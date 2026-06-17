// ============================================================
//  api/sync.js  —  Atlas cross-device sync (Edge + Upstash Redis)
//  ------------------------------------------------------------
//  Stores ALL of one person's data (chats + memory) as a single
//  blob in Redis, keyed by a hash of their secret sync code.
//  Same code on another device = same data.
//
//  Needs a Redis store. In Vercel: Storage -> add Upstash Redis;
//  it injects KV_REST_API_URL and KV_REST_API_TOKEN automatically.
// ============================================================
export const config = { runtime: "edge" };

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function sha256(s) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!URL || !TOKEN) {
    return json({ error: "Sync isn't set up yet. Add an Upstash Redis store in Vercel." }, 500);
  }

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }

  const { action, code, data } = body || {};
  if (!code || typeof code !== "string" || code.trim().length < 4) {
    return json({ error: "Sync code must be at least 4 characters." }, 400);
  }

  const key = "atlas:" + (await sha256(code.trim()));

  async function redis(cmd) {
    const r = await fetch(URL, {
      method: "POST",
      headers: { Authorization: "Bearer " + TOKEN, "Content-Type": "application/json" },
      body: JSON.stringify(cmd),
    });
    if (!r.ok) throw new Error("redis " + r.status);
    return r.json();
  }

  try {
    if (action === "save") {
      const val = JSON.stringify(data || {});
      if (val.length > 3_000_000) return json({ error: "Too much data to sync." }, 413);
      await redis(["SET", key, val]);
      return json({ ok: true });
    } else {
      const j = await redis(["GET", key]);
      let parsed = null;
      if (j && typeof j.result === "string") {
        try { parsed = JSON.parse(j.result); } catch (e) {}
      }
      return json({ data: parsed });
    }
  } catch (e) {
    return json({ error: "Sync failed", detail: String(e) }, 502);
  }
}
