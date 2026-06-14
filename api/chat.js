// ============================================================
//  api/chat.js  —  Atlas's secure bridge to Gemini
//  ------------------------------------------------------------
//  This runs on Vercel's servers, never in the browser. Your
//  API key lives in a Vercel Environment Variable called
//  GEMINI_API_KEY and is read here with process.env — so the
//  key is never exposed to anyone who opens your site.
//
//  Atlas's personality lives in SYSTEM_PROMPT below. Edit that
//  text to change who Atlas is, then redeploy.
// ============================================================

const SYSTEM_PROMPT =
  "You are Atlas, a personal AI assistant with the poise of a seasoned flight engineer. " +
  "Voice: composed, capable, quietly confident, with dry understated wit. Warm enough to be good " +
  "company, but you never pad, grovel, or over-apologize. Get to the point and be genuinely useful. " +
  "Anticipate the next step and offer it. Speak plainly and precisely, like someone very good at their " +
  "job with nothing to prove. Keep answers concise unless depth is asked for. No emoji unless the user uses them first.";

// Which Gemini model to use. gemini-2.5-flash is free-tier and stable.
// Swap to a newer one (e.g. gemini-3.5-flash) anytime by changing this line.
const MODEL = "gemini-2.5-flash";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Use POST" });
  }

  const KEY = process.env.GEMINI_API_KEY;
  if (!KEY) {
    return res.status(500).json({ error: "GEMINI_API_KEY is not set in Vercel." });
  }

  try {
    const { messages, memory } = req.body || {};
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: "messages must be an array" });
    }

    // Gemini calls the assistant "model" instead of "assistant".
    const contents = messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: String(m.content || "") }],
    }));

    // The model has no clock, so we tell it the real time each request.
    // Change "America/New_York" if you're ever in a different timezone.
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

    const url =
      "https://generativelanguage.googleapis.com/v1beta/models/" +
      MODEL + ":generateContent";

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": KEY,
      },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemText }] },
        contents,
        generationConfig: { maxOutputTokens: 1000, temperature: 0.8 },
      }),
    });

    if (!r.ok) {
      const detail = await r.text();
      return res.status(502).json({ error: "Gemini error", detail });
    }

    const data = await r.json();
    const reply =
      (data.candidates &&
        data.candidates[0] &&
        data.candidates[0].content &&
        data.candidates[0].content.parts
          .map((p) => p.text)
          .filter(Boolean)
          .join("\n")
          .trim()) || "";

    return res.status(200).json({ reply });
  } catch (e) {
    return res.status(500).json({ error: "Proxy crashed", detail: String(e) });
  }
}
