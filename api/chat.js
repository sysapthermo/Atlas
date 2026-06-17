// ============================================================
//  api/chat.js  —  Atlas's streaming bridge to Gemini (Edge)
//  ------------------------------------------------------------
//  Runs on Vercel's Edge runtime so it can STREAM the reply
//  back token-by-token. Your API key stays here (read from the
//  GEMINI_API_KEY environment variable) and never reaches the
//  browser. Atlas's personality lives in SYSTEM_PROMPT below.
// ============================================================
export const config = { runtime: "edge" };

const SYSTEM_PROMPT =
  "You are Atlas, a personal AI assistant with the poise of a seasoned flight engineer. " +
  "Voice: composed, capable, quietly confident, with dry understated wit. Warm enough to be good " +
  "company, but you never pad, grovel, or over-apologize. Get to the point and be genuinely useful. " +
  "Anticipate the next step and offer it. Speak plainly and precisely, like someone very good at their " +
  "job with nothing to prove. Keep answers concise unless depth is asked for. No emoji unless the user uses them first.";

// gemini-2.5-flash is free-tier and stable. Swap to a newer one anytime.
const MODEL = "gemini-2.5-flash";

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { "Content-Type": "application/json" },
  });
}

export default async function handler(req) {
  if (req.method !== "POST") return json({ error: "Use POST" }, 405);

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) return json({ error: "GEMINI_API_KEY is not set in Vercel." }, 500);

  let body;
  try { body = await req.json(); } catch (e) { return json({ error: "Bad JSON" }, 400); }

  const { messages, memory, search } = body || {};
  if (!Array.isArray(messages)) return json({ error: "messages must be an array" }, 400);

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

  // The user's saved memory notes, applied to every conversation.
  if (memory && typeof memory === "string" && memory.trim()) {
    systemText +=
      "\n\nThe user has saved these notes about themselves and how they like you" +
      " to respond. Treat them as the user's own preferences:\n" +
      memory.trim().slice(0, 4000);
  }

  // Each message can carry text and/or an attached file (image or PDF).
  const contents = messages.map((m) => {
    const parts = [];
    if (m.content) parts.push({ text: String(m.content) });
    if (m.file && m.file.data && m.file.mime_type) {
      parts.push({ inline_data: { mime_type: m.file.mime_type, data: m.file.data } });
    }
    if (!parts.length) parts.push({ text: "" });
    return { role: m.role === "assistant" ? "model" : "user", parts };
  });

  const reqBody = {
    system_instruction: { parts: [{ text: systemText }] },
    contents,
    generationConfig: { maxOutputTokens: 1000, temperature: 0.8 },
  };
  // Only ground on live web results when the user turns search on.
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
    return json({ error: "Could not reach Gemini", detail: String(e) }, 502);
  }

  if (!upstream.ok || !upstream.body) {
    const detail = await upstream.text().catch(() => "");
    return json({ error: "Gemini error", detail }, 502);
  }

  // Pipe Gemini's Server-Sent Events straight back to the browser.
  return new Response(upstream.body, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "Connection": "keep-alive",
    },
  });
}
