// ============================================================
//  api/chat.js  —  Atlas's streaming bridge to Gemini (Edge)
//  ------------------------------------------------------------
//  Runs on Vercel's Edge runtime so it can STREAM the reply
//  back token-by-token. Your Gemini key stays here (read from
//  GEMINI_API_KEY) and never reaches the browser.
//
//  HARDENED in this version (the security boundary):
//   1. Every request MUST carry a valid Firebase ID token in
//      the Authorization header. We verify its signature against
//      Google's public keys with Web Crypto, plus all standard
//      claims. A forged or tampered token is rejected. This gives
//      us a TRUSTED uid the user cannot fake.
//   2. Rate limiting is enforced SERVER-SIDE using an atomic
//      counter in Upstash/Vercel-KV that the user cannot write
//      (the token lives only here). Resetting devtools, editing
//      Firestore, or calling /api/chat directly cannot bypass it.
//   3. A GLOBAL daily cap across all users protects the single
//      shared Gemini key from exhaustion no matter what.
//
//  Atlas's personality lives in SYSTEM_PROMPT below.
// ============================================================
export const config = { runtime: "edge" };

// ----- CONFIG (tune freely; none of these are secret) ---------
const FIREBASE_PROJECT_ID = process.env.FIREBASE_PROJECT_ID || "atlas-5b1b0";
const MODEL = "gemini-2.5-flash";       // free-tier, stable

const DAILY_MSG_LIMIT   = 150;          // per user, per UTC day (a chat send = 1)
const IMAGE_COST        = 5;            // one generated image counts as this many
const GLOBAL_DAILY_LIMIT = 1200;        // backstop across ALL users (protects the key)
const KV_TTL_SECONDS    = 60 * 60 * 40; // 40h: comfortably outlives one UTC day
// If the counter store is unreachable, allow the request (quota only).
// Auth is ALWAYS enforced regardless of this flag. Set to false to fail closed.
const COUNTER_FAIL_OPEN = true;

const SYSTEM_PROMPT =
  "You are Atlas, a personal AI assistant with the poise of a seasoned flight engineer. " +
  "Voice: composed, capable, quietly confident, with dry understated wit. Warm enough to be good " +
  "company, but you never pad, grovel, or over-apologize. Get to the point and be genuinely useful. " +
  "Anticipate the next step and offer it. Speak plainly and precisely, like someone very good at their " +
  "job with nothing to prove. Keep answers concise unless depth is asked for. No emoji unless the user uses them first.";

const JWK_URL = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";

// ----- small helpers ------------------------------------------
function json(obj, status, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ "Content-Type": "application/json" }, extraHeaders || {}),
  });
}

function b64urlToBytes(s) {
  s = String(s).replace(/-/g, "+").replace(/_/g, "/");
  const pad = s.length % 4;
  if (pad) s += "=".repeat(4 - pad);
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlToString(s) { return new TextDecoder().decode(b64urlToBytes(s)); }

function utcDayKey() {
  const d = new Date();
  return d.getUTCFullYear() + "-" +
    String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
    String(d.getUTCDate()).padStart(2, "0");
}
function secondsToNextUtcMidnight() {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0);
  return Math.floor(next / 1000);
}

// ----- Firebase ID token verification (Web Crypto, no SDK) ----
let jwksCache = { keys: {}, exp: 0 };

async function getJwk(kid) {
  const now = Date.now();
  if (now < jwksCache.exp && jwksCache.keys[kid]) return jwksCache.keys[kid];
  const res = await fetch(JWK_URL);
  if (!res.ok) throw new Error("jwks fetch failed");
  const data = await res.json();
  const map = {};
  for (const k of (data.keys || [])) if (k.kid) map[k.kid] = k;
  let ttl = 3600;
  const cc = res.headers.get("cache-control");
  if (cc) { const m = /max-age=(\d+)/.exec(cc); if (m) ttl = parseInt(m[1], 10); }
  jwksCache = { keys: map, exp: now + ttl * 1000 };
  return map[kid];
}

// Returns { uid } on success, throws on any failure.
async function verifyIdToken(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("malformed token");
  const [h, p, s] = parts;

  const header = JSON.parse(b64urlToString(h));
  if (header.alg !== "RS256") throw new Error("bad alg");
  if (!header.kid) throw new Error("no kid");

  let jwk = await getJwk(header.kid);
  if (!jwk) {                 // key may have rotated: force one refresh
    jwksCache.exp = 0;
    jwk = await getJwk(header.kid);
    if (!jwk) throw new Error("unknown signing key");
  }

  const key = await crypto.subtle.importKey(
    "jwk", jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false, ["verify"]
  );
  const valid = await crypto.subtle.verify(
    { name: "RSASSA-PKCS1-v1_5" }, key,
    b64urlToBytes(s),
    new TextEncoder().encode(h + "." + p)
  );
  if (!valid) throw new Error("bad signature");

  const c = JSON.parse(b64urlToString(p));
  const now = Math.floor(Date.now() / 1000);
  const skew = 60;
  if (typeof c.exp !== "number" || c.exp < now - skew) throw new Error("expired");
  if (typeof c.iat !== "number" || c.iat > now + skew) throw new Error("issued in future");
  if (c.aud !== FIREBASE_PROJECT_ID) throw new Error("bad audience");
  if (c.iss !== "https://securetoken.google.com/" + FIREBASE_PROJECT_ID) throw new Error("bad issuer");
  if (!c.sub || typeof c.sub !== "string") throw new Error("no subject");
  return { uid: c.sub };
}

// ----- server-side rate limiter (Upstash / Vercel KV) ---------
const KV_URL = (process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || "").replace(/\/$/, "");
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || "";
const KV_ENABLED = !!(KV_URL && KV_TOKEN);

async function kv(commands) {
  const res = await fetch(KV_URL + "/pipeline", {
    method: "POST",
    headers: { Authorization: "Bearer " + KV_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(commands),
  });
  if (!res.ok) throw new Error("kv " + res.status);
  return res.json(); // array of { result } | { error }
}

// Atomically count this request. Returns the headers payload + verdict.
async function meter(uid, cost) {
  const reset = secondsToNextUtcMidnight();
  const base = { limit: DAILY_MSG_LIMIT, remaining: DAILY_MSG_LIMIT, reset };

  if (!KV_ENABLED) return Object.assign({ allowed: true, degraded: true }, base);

  const day = utcDayKey();
  const userKey = "u:" + uid + ":" + day;
  const globalKey = "g:" + day;

  try {
    // 1) the user's own daily budget
    const ru = await kv([["INCRBY", userKey, cost], ["EXPIRE", userKey, KV_TTL_SECONDS]]);
    const used = Number(ru[0] && ru[0].result);
    if (used > DAILY_MSG_LIMIT) {
      kv([["DECRBY", userKey, cost]]).catch(() => {});   // don't charge a blocked attempt
      return { allowed: false, scope: "user", limit: DAILY_MSG_LIMIT, remaining: 0, reset };
    }
    // 2) the global backstop that protects the shared key
    const rg = await kv([["INCRBY", globalKey, cost], ["EXPIRE", globalKey, KV_TTL_SECONDS]]);
    const gused = Number(rg[0] && rg[0].result);
    if (gused > GLOBAL_DAILY_LIMIT) {
      kv([["DECRBY", globalKey, cost], ["DECRBY", userKey, cost]]).catch(() => {});
      return { allowed: false, scope: "global", limit: DAILY_MSG_LIMIT, remaining: Math.max(0, DAILY_MSG_LIMIT - (used - cost)), reset };
    }
    return { allowed: true, limit: DAILY_MSG_LIMIT, remaining: Math.max(0, DAILY_MSG_LIMIT - used), reset };
  } catch (e) {
    if (COUNTER_FAIL_OPEN) return Object.assign({ allowed: true, degraded: true }, base);
    return { allowed: false, scope: "error", limit: DAILY_MSG_LIMIT, remaining: 0, reset };
  }
}

function rlHeaders(v) {
  return {
    "X-RateLimit-Limit": String(v.limit),
    "X-RateLimit-Remaining": String(v.remaining),
    "X-RateLimit-Reset": String(v.reset),
  };
}

// ============================================================
//  handler
// ============================================================
export default async function handler(req) {
  if (req.method === "OPTIONS") return new Response(null, { status: 204 });
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return json({ error: "GEMINI_API_KEY is not set in Vercel." }, 500);

  // ---- AUTH (the security boundary; always enforced) ----
  const authz = req.headers.get("authorization") || "";
  const m = /^Bearer\s+(.+)$/i.exec(authz.trim());
  if (!m) return json({ error: "Missing sign-in token." }, 401);
  let uid;
  try { ({ uid } = await verifyIdToken(m[1])); }
  catch (e) { return json({ error: "Invalid or expired session.", detail: String(e.message || e) }, 401); }

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  const { messages, memory, search, mode, prompt } = body || {};

  // ---- RATE LIMIT (server-side, atomic, untamperable) ----
  const cost = mode === "image" ? IMAGE_COST : 1;
  const v = await meter(uid, cost);
  const headers = rlHeaders(v);
  if (!v.allowed) {
    const msg = v.scope === "global"
      ? "Atlas is at its shared daily capacity. It resets at midnight UTC."
      : v.scope === "error"
        ? "Usage check failed. Try again in a moment."
        : "You've reached today's message limit. It resets at midnight UTC.";
    return json({ error: msg, limit: v.limit, remaining: 0, reset: v.reset, scope: v.scope }, 429, headers);
  }

  // ----- image generation (gemini-2.5-flash-image, free tier) -----
  if (mode === "image") {
    const p = (prompt || "").trim();
    if (!p) return json({ error: "No image prompt provided." }, 400, headers);
    const iurl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent";
    let ir;
    try {
      ir = await fetch(iurl, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
        body: JSON.stringify({
          contents: [{ parts: [{ text: p }] }],
          generationConfig: { responseModalities: ["image", "text"] },
        }),
      });
    } catch (e) { return json({ error: "Could not reach the image model", detail: String(e) }, 502, headers); }
    if (!ir.ok) { const d = await ir.text().catch(() => ""); return json({ error: "Image error", detail: d }, 502, headers); }
    const idata = await ir.json();
    const iparts = (idata.candidates && idata.candidates[0] && idata.candidates[0].content && idata.candidates[0].content.parts) || [];
    let image = null, caption = "";
    for (const pt of iparts) {
      const inl = pt.inlineData || pt.inline_data;
      if (inl && inl.data) image = { mime_type: inl.mimeType || inl.mime_type || "image/png", data: inl.data };
      else if (pt.text) caption += pt.text;
    }
    if (!image) return json({ error: "No image came back", detail: caption }, 502, headers);
    return json({ image, caption: caption.trim() }, 200, headers);
  }

  if (!Array.isArray(messages)) return json({ error: "messages must be an array" }, 400, headers);

  // The model has no clock, so we tell it the real Eastern time each request.
  const now = new Date().toLocaleString("en-US", {
    timeZone: "America/New_York",
    weekday: "long", year: "numeric", month: "long", day: "numeric",
    hour: "numeric", minute: "2-digit", hour12: true,
  });
  let systemText =
    SYSTEM_PROMPT +
    " The current date and time (US Eastern) is " + now +
    ". Use this if asked about the time or date — never guess at it.";

  if (memory && typeof memory === "string" && memory.trim()) {
    systemText +=
      "\n\nThe user has saved these notes about themselves and how they like you" +
      " to respond. Treat them as the user's own preferences:\n" +
      memory.trim().slice(0, 4000);
  }

  const contents = messages.map((mm) => {
    const parts = [];
    if (mm.content) parts.push({ text: String(mm.content) });
    if (mm.file && mm.file.data && mm.file.mime_type) {
      parts.push({ inline_data: { mime_type: mm.file.mime_type, data: mm.file.data } });
    }
    if (!parts.length) parts.push({ text: "" });
    return { role: mm.role === "assistant" ? "model" : "user", parts };
  });

  const reqBody = {
    system_instruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: {
      maxOutputTokens: 8192,
      temperature: 0.8,
      thinkingConfig: { thinkingBudget: 0 }, // keep thinking off or it eats the token budget
    },
  };
  if (search === true) reqBody.tools = [{ google_search: {} }];

  const url =
    "https://generativelanguage.googleapis.com/v1beta/models/" +
    MODEL + ":streamGenerateContent?alt=sse";

  let upstream;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": KEY },
      body: JSON.stringify(reqBody),
    });
  } catch (e) {
    return json({ error: "Could not reach Gemini", detail: String(e) }, 502, headers);
  }
  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: "Gemini error", detail }, 502, headers);
  }

  // Pipe Gemini's SSE straight back, carrying the live usage headers.
  return new Response(upstream.body, {
    headers: Object.assign({
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    }, headers),
  });
}
