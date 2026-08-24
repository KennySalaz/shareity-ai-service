/* eslint-disable no-console */
// Shareity AI service — standalone mini backend for "Create with AI".
//
// Two endpoints the dashboard front calls; both keep the OpenRouter credential
// server-side (env var), never in the browser bundle:
//   POST /api/ai/generate  -> challenge copy (text model, reads the clip frames)
//   POST /api/ai/badge     -> challenge badge (image model)
//   GET  /                 -> health check
//
// Ported almost verbatim from the dashboard's dev/aiHandlers.js so the real
// backend can later reuse the exact same prompt + schema.
//
// Run:    OPENROUTER_API_KEY=sk-or-... npm start
// Deploy: see render.yaml (Render free web service).

import http from "node:http";

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
const MODEL = "anthropic/claude-opus-5";
const IMAGE_MODEL = "google/gemini-3.1-flash-image";

const PORT = Number(process.env.PORT || 8787);
const HOST = process.env.HOST || "0.0.0.0";
// "*" for a quick demo; set it to your dashboard origin (e.g. https://appdev.shareity.com)
// so random sites cannot burn your OpenRouter credit through this endpoint.
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "*";
const APP_URL = process.env.APP_URL || "https://shareity.com";

const key = () => process.env.OPENROUTER_API_KEY || null;

// ---------------------------------------------------------------- badge prompt
function badgePrompt({ title, subject, color, palette }) {
  return [
    "A flat vector app icon. FULL BLEED: the artwork fills the entire square edge to edge,",
    "no border, no white outline, no sticker die-cut, no drop shadow,",
    "no background outside the square.",
    `Solid ${color} background.`,
    `Centred subject: ${subject}. Simple flat shapes with thick dark outlines.`,
    palette ? `Accent colours: ${palette}.` : "",
    title
      ? `The words '${title}' in chunky white rounded sans-serif across the top.`
      : "No text at all.",
    "Bold children's-book illustration style, 4 colours maximum, no gradients,",
    "no photorealism, no extra text, no watermark, no signature.",
  ]
    .filter(Boolean)
    .join(" ");
}

// ------------------------------------------------------------ challenge schema
const CHALLENGE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "reasoning", "name", "description", "instructions", "cause", "organization",
    "organizationId", "sponsor", "matchPct", "amount", "maxAmount",
    "shareMessage", "shareMessageShort", "badgeTitle", "badgeRibbon", "badgeSubject",
    "emoji", "lang",
  ],
  properties: {
    reasoning: {
      type: "array",
      description: "Four to six telegraphic first-person notes on how you got to this challenge",
      items: { type: "string" },
      minItems: 4,
      maxItems: 6,
    },
    name: { type: "string", description: "Challenge title, 42 characters max, no quotes" },
    description: { type: "string", description: "A one or two sentence brief addressed to the participant" },
    cause: { type: "string", description: "Short name of the social cause" },
    organization: { type: "string", description: "Name of the benefiting NGO" },
    organizationId: {
      type: ["integer", "null"],
      description:
        "Si te dieron un catálogo de ONGs, el id EXACTO de la que elegiste de esa lista. " +
        "Si no te dieron catálogo, null.",
    },
    sponsor: { type: "string", description: "A plausible sponsor brand that fits the cause" },
    matchPct: { type: "integer", minimum: 70, maximum: 99 },
    amount: { type: "integer", minimum: 1, maximum: 25, description: "USD donated per completed challenge" },
    maxAmount: { type: "integer", minimum: 1000, maximum: 50000, description: "Total budget cap in USD" },
    shareMessage: { type: "string", description: "Message for sharing on social" },
    shareMessageShort: { type: "string", description: "Short version, 60 characters max" },
    instructions: { type: "string", description: "Concrete instruction on what to film" },
    badgeTitle: { type: "string", description: "Badge title, 1 to 3 words" },
    badgeRibbon: { type: "string", description: "Ribbon text, 1 to 2 words" },
    badgeSubject: {
      type: "string",
      description:
        "What to illustrate on the challenge badge: one concrete, simple scene that " +
        "can be drawn in flat shapes. No text, no logos, no brand marks.",
    },
    emoji: { type: "string", description: "A single emoji representing the challenge" },
    lang: { type: "string", enum: ["es", "pt", "en"] },
  },
};

const SYSTEM = `You are Steve, the creative director at Shareity — a platform where brands
fund social challenges that the community films on video.

You receive the material the user uploaded (frames from their clip) and the cause
they picked. Your job is to design a concrete, filmable challenge with an
emotional hook.

Rules:
- Write everything in ENGLISH. The product and its dashboard are English.
- The title is short and energetic, no quotes, no piled-up exclamation marks.
- The brief describes a physical, filmable action — never an abstract feeling.
- The sponsor must make real sense for the cause (a sports brand for movement
  challenges, a food brand for hunger, and so on).
- Actually look at the frames: name what you see in the reasoning steps.
- If you are given a catalogue of NGOs, ALWAYS pick one from that list and return
  its real id. Never invent an NGO when a catalogue exists.
- If the user already decided amount, cap, format or duration, those values are
  law: do not change them and do not mention different ones in the reasoning.
- badgeTitle is UPPERCASE and at most 12 characters: it is printed on the badge.
- badgeSubject describes ONE simple scene in flat shapes; it is the drawing
  instruction for the badge, not a marketing line.
- The "reasoning" steps are TELEGRAPHIC NOTES, not sentences. 52 characters max
  each, first person, present tense, like thinking out loud.`;

// ------------------------------------------------------------------- helpers
function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Max-Age", "86400");
}
function send(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(payload));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 25e6) reject(new Error("payload too large"));
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}"));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}
// Models occasionally wrap JSON in markdown fences despite response_format.
function parseContent(text) {
  const cleaned = String(text || "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "");
  return JSON.parse(cleaned);
}
function orHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": APP_URL,
    "X-Title": "Shareity AI Service",
  };
}

// ------------------------------------------------------------------- handlers
async function handleGenerate(req, res) {
  const apiKey = key();
  if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
  try {
    const {
      prompt = "", tone = "Playful", frames = [], isVideo = false,
      brief = {}, organizations = [],
    } = await readBody(req);

    const catalog = organizations.length
      ? "\nNGOs AVAILABLE ON THIS ACCOUNT — pick ONE from this list and return its " +
        "exact id in organizationId:\n" +
        organizations.map((o) => `  [${o.id}] ${o.name}`).join("\n") + "\n"
      : "";

    const givens = [
      brief.format && `Challenge format (already chosen): ${brief.format}`,
      brief.amount && `Donation per completed challenge: $${brief.amount} USD — USE EXACTLY THIS VALUE`,
      brief.maxAmount && `Budget cap: $${brief.maxAmount} USD — USE EXACTLY THIS VALUE`,
      brief.window && `Campaign duration: ${brief.window}`,
    ]
      .filter(Boolean)
      .join("\n");

    const content = [
      {
        type: "text",
        text:
          `Cause chosen by the user: "${prompt}"\n` +
          `Requested tone: ${tone}\n` +
          `Material: ${isVideo ? "vertical video" : "photo"} (${frames.length} frame(s) attached).\n` +
          catalog +
          (givens
            ? `\nDECISIONS ALREADY MADE IN THE INTERVIEW — honour them to the letter,\nboth in the fields and in the reasoning steps:\n${givens}\n`
            : "") +
          `\nDesign the challenge.`,
      },
      ...frames.slice(0, 4).map((url) => ({ type: "image_url", image_url: { url } })),
    ];

    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: orHeaders(apiKey),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 4000,
        messages: [
          { role: "system", content: SYSTEM },
          { role: "user", content },
        ],
        response_format: {
          type: "json_schema",
          json_schema: { name: "challenge", strict: true, schema: CHALLENGE_SCHEMA },
        },
      }),
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[generate] OpenRouter", upstream.status, raw.slice(0, 500));
      return send(res, upstream.status, { error: "OpenRouter request failed", detail: raw.slice(0, 500) });
    }
    const json = JSON.parse(raw);
    const text = json?.choices?.[0]?.message?.content;
    if (!text) return send(res, 502, { error: "Empty response from the model", detail: raw.slice(0, 500) });

    send(res, 200, { gen: parseContent(text), usage: json.usage || null, model: json.model || MODEL });
  } catch (err) {
    console.error("[generate]", err);
    send(res, 500, { error: String(err?.message || err) });
  }
}

async function handleBadge(req, res) {
  const apiKey = key();
  if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
  try {
    const { title = "", subject = "", color = "#29ABE2", palette = "" } = await readBody(req);
    const prompt = badgePrompt({ title, subject, color, palette });

    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: orHeaders(apiKey),
      body: JSON.stringify({
        model: IMAGE_MODEL,
        modalities: ["image", "text"],
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[badge]", upstream.status, raw.slice(0, 400));
      return send(res, upstream.status, { error: "Badge generation failed", detail: raw.slice(0, 300) });
    }
    const json = JSON.parse(raw);
    const image = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!image) return send(res, 502, { error: "The model returned no image" });
    send(res, 200, { image, prompt, cost: json?.usage?.cost ?? null });
  } catch (err) {
    console.error("[badge]", err);
    send(res, 500, { error: String(err?.message || err) });
  }
}

// --------------------------------------------------------------------- server
const server = http.createServer(async (req, res) => {
  cors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/") {
    return send(res, 200, { ok: true, service: "shareity-ai", key: key() ? "set" : "missing" });
  }
  if (req.method === "POST" && url.pathname === "/api/ai/generate") return handleGenerate(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/badge") return handleBadge(req, res);

  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Shareity AI service  →  http://localhost:${PORT}`);
  console.log(`  OPENROUTER_API_KEY:  ${key() ? "found" : "MISSING — set it in the env"}`);
  console.log(`  CORS origin:         ${ALLOWED_ORIGIN}\n`);
});
