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
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Load a local .env (zero-dep) so `npm start` picks up OPENROUTER_API_KEY without
// exporting it by hand. Real deploys (Render) inject env vars directly and ship
// no .env file, so this is a no-op there. Never overrides an already-set var.
(function loadEnv() {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const txt = fs.readFileSync(path.join(dir, ".env"), "utf8");
    for (const line of txt.split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      const v = m[2].trim().replace(/^["']|["']$/g, "");
      if (v && process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch {
    /* no .env — the key comes from the shell or the platform */
  }
})();

const ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";
// Text model(s) on OpenRouter. A ":free" id does NOT consume credit and reads the
// clip frames to return the structured challenge; a paid id (e.g. anthropic/
// claude-opus-5) works the same way with better output. Free pools rotate and
// rate-limit (429), so we accept a chain and use the first that answers — one
// hard-coded model is not reliable enough. Override with AI_TEXT_MODELS
// (comma-separated) for a chain, or AI_TEXT_MODEL for a single model.
const parseModels = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
const MODELS = parseModels(
  process.env.AI_TEXT_MODELS ||
    process.env.AI_TEXT_MODEL ||
    "google/gemma-4-31b-it:free,google/gemma-4-26b-a4b-it:free",
);
// Ideas are throwaway suggestions, so they can run on a cheaper model than the
// main generate call. Falls back to MODELS when not set.
const IDEAS_MODELS = process.env.AI_IDEAS_MODELS || process.env.AI_IDEAS_MODEL
  ? parseModels(process.env.AI_IDEAS_MODELS || process.env.AI_IDEAS_MODEL)
  : MODELS;
// Badges: Pollinations (free, no key, FLUX) by default, or an OpenRouter image
// model when AI_BADGE_PROVIDER=openrouter (production parity, spends credit).
const POLLINATIONS = "https://image.pollinations.ai/prompt/";
const BADGE_PROVIDER = process.env.AI_BADGE_PROVIDER || "pollinations";
const IMAGE_MODEL = process.env.AI_IMAGE_MODEL || "google/gemini-3.1-flash-image";
// Cover scene (step 1): a vertical 9:16 phone-screen photo. Defaults to the badge
// provider but can be set apart — Pollinations gives exact 9:16 framing for free,
// which OpenRouter image models cannot guarantee.
const SCENE_PROVIDER = process.env.AI_SCENE_PROVIDER || BADGE_PROVIDER;

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

// Cover scene: a vertical phone-screen photo the challenge shows behind its title.
function scenePrompt(idea) {
  return [
    "Cinematic vertical 9:16 phone-screen photo for a social-good video challenge.",
    `Scene: ${idea}.`,
    "Real people, candid documentary style, natural light, shallow depth of field,",
    "full-bleed vertical portrait composition that fills a phone screen,",
    "no text, no captions, no logos, no watermark, no UI.",
  ].join(" ");
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
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
// Free models often wrap JSON in prose or markdown fences. Strip fences, then
// fall back to extracting the outermost {...} block.
function parseContent(text) {
  const s = String(text || "")
    .replace(/^\s*```(?:json)?\s*/i, "")
    .replace(/\s*```\s*$/, "")
    .trim();
  try {
    return JSON.parse(s);
  } catch {
    const a = s.indexOf("{");
    const b = s.lastIndexOf("}");
    if (a >= 0 && b > a) return JSON.parse(s.slice(a, b + 1));
    throw new Error("no JSON object in model output");
  }
}
function orHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
    "HTTP-Referer": APP_URL,
    "X-Title": "Shareity AI Service",
  };
}

// Free-model resilience: try the chain and use the first that answers. We ask for
// response_format json_object (widely supported, unlike json_schema) so the model
// emits a JSON object instead of an empty or prose reply — the prompts already say
// "reply only with JSON", which json_object requires. Free pools still occasionally
// answer 200 with an EMPTY body, so we retry a model a couple of times before
// moving to the next; parseContent is the final safety net for stray fences.
const ATTEMPTS = 2;
async function chatJSON(apiKey, messages, maxTokens = 3000, models = MODELS) {
  let lastErr = "all models unavailable";
  for (const model of models) {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
      let upstream;
      try {
        upstream = await fetch(ENDPOINT, {
          method: "POST",
          headers: orHeaders(apiKey),
          body: JSON.stringify({
            model,
            max_tokens: maxTokens,
            messages,
            response_format: { type: "json_object" },
            // Ask OpenRouter to return the real USD cost of the call in usage.cost.
            usage: { include: true },
          }),
        });
      } catch (e) {
        lastErr = String(e?.message || e);
        break; // network error: this model is unreachable, try the next
      }
      const raw = await upstream.text();
      if (upstream.ok) {
        let text = "";
        let usage = null;
        try {
          const j = JSON.parse(raw);
          text = j?.choices?.[0]?.message?.content || "";
          usage = j?.usage || null;
        } catch {
          text = ""; // empty/garbled body on a 200 — treat as retryable
        }
        if (text) return { text, model, usage };
        lastErr = `${model} → empty content`;
        console.error("[chatJSON]", lastErr, `(attempt ${attempt + 1}/${ATTEMPTS})`);
        if (attempt < ATTEMPTS - 1) {
          await new Promise((r) => setTimeout(r, 800));
          continue; // same model, try again — it often answers on the next call
        }
        break; // exhausted this model, fall through to the next in the chain
      }
      lastErr = `${model} → ${upstream.status} ${raw.slice(0, 160)}`;
      console.error("[chatJSON]", lastErr);
      // brief retry on a shared-pool 429, then fall through to the next model
      if (upstream.status === 429 && attempt < ATTEMPTS - 1) {
        await new Promise((r) => setTimeout(r, 1500));
        continue;
      }
      break;
    }
  }
  throw new Error(lastErr);
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
          `\nDesign the challenge.\n\n` +
          `Return ONLY a JSON object (no prose, no markdown) with EXACTLY these keys:\n` +
          `reasoning (array of 4-6 short first-person notes), name (<=42 chars), ` +
          `description (a SHORT brief for the participant: at most 2 sentences, ~140 chars total, one line, no rambling), ` +
          `cause, organization, organizationId (integer id from the ` +
          `list above, or null), sponsor, matchPct (integer 70-99), amount (integer), ` +
          `maxAmount (integer), shareMessage, shareMessageShort (<=60 chars), ` +
          `instructions, badgeTitle (UPPERCASE <=12 chars), badgeRibbon, ` +
          `badgeSubject (one simple scene in flat shapes), emoji (single emoji), ` +
          `lang ("es" | "pt" | "en").`,
      },
      ...frames.slice(0, 4).map((url) => ({ type: "image_url", image_url: { url } })),
    ];

    const { text, model, usage } = await chatJSON(
      apiKey,
      [
        { role: "system", content: SYSTEM },
        { role: "user", content },
      ],
      3000,
    );
    send(res, 200, { gen: parseContent(text), model, usage, cost: usage?.cost ?? null });
  } catch (err) {
    console.error("[generate]", err);
    send(res, 500, { error: String(err?.message || err) });
  }
}

async function handleBadge(req, res) {
  try {
    const { title = "", subject = "", color = "#29ABE2", palette = "", seed } = await readBody(req);
    const prompt = badgePrompt({ title, subject, color, palette });

    // Free path (default): Pollinations renders straight from the prompt in the
    // URL, no API key. A different seed gives a different image — that is how the
    // wizard asks for 3 versions. Returned as a base64 data URL so the browser
    // re-encodes it without CORS taint.
    if (BADGE_PROVIDER !== "openrouter") {
      const url =
        POLLINATIONS +
        encodeURIComponent(prompt) +
        "?width=1024&height=1024&nologo=true&model=flux" +
        (seed != null ? `&seed=${encodeURIComponent(seed)}` : "");

      const upstream = await fetch(url);
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        console.error("[badge] pollinations", upstream.status, detail.slice(0, 200));
        return send(res, upstream.status, { error: "Badge generation failed", detail: detail.slice(0, 200) });
      }
      const mime = upstream.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await upstream.arrayBuffer());
      const image = `data:${mime};base64,${buf.toString("base64")}`;
      return send(res, 200, { image, prompt, cost: 0 });
    }

    // Paid path (production parity): OpenRouter image model, spends credit.
    const apiKey = key();
    if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: orHeaders(apiKey),
      body: JSON.stringify({
        model: IMAGE_MODEL,
        modalities: ["image", "text"],
        messages: [{ role: "user", content: prompt }],
        usage: { include: true },
      }),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[badge] openrouter", upstream.status, raw.slice(0, 200));
      return send(res, upstream.status, { error: "Badge generation failed", detail: raw.slice(0, 200) });
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

// ------------------------------------------------------------------- scene
// Step 1's cover image: a vertical 9:16 phone-screen photo built from the idea.
// Video is upload-only for now, so this is the only generated cover.
async function handleScene(req, res) {
  try {
    const { prompt: idea = "", seed } = await readBody(req);
    const prompt = scenePrompt(idea || "people doing a social-good challenge together");

    // Free path (default): Pollinations at an exact 9:16 so it fills a phone screen.
    if (SCENE_PROVIDER !== "openrouter") {
      const url =
        POLLINATIONS +
        encodeURIComponent(prompt) +
        "?width=768&height=1344&nologo=true&model=flux" +
        (seed != null ? `&seed=${encodeURIComponent(seed)}` : "");
      const upstream = await fetch(url);
      if (!upstream.ok) {
        const detail = await upstream.text().catch(() => "");
        console.error("[scene] pollinations", upstream.status, detail.slice(0, 200));
        return send(res, upstream.status, { error: "Scene generation failed", detail: detail.slice(0, 200) });
      }
      const mime = upstream.headers.get("content-type") || "image/jpeg";
      const buf = Buffer.from(await upstream.arrayBuffer());
      return send(res, 200, { image: `data:${mime};base64,${buf.toString("base64")}`, prompt, cost: 0 });
    }

    // Paid path: OpenRouter image model. Aspect ratio is only a prompt hint here,
    // so the front crops the result into its phone frame.
    const apiKey = key();
    if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      headers: orHeaders(apiKey),
      body: JSON.stringify({
        model: IMAGE_MODEL,
        modalities: ["image", "text"],
        messages: [{ role: "user", content: prompt }],
        usage: { include: true },
      }),
    });
    const raw = await upstream.text();
    if (!upstream.ok) {
      console.error("[scene] openrouter", upstream.status, raw.slice(0, 200));
      return send(res, upstream.status, { error: "Scene generation failed", detail: raw.slice(0, 200) });
    }
    const json = JSON.parse(raw);
    const image = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
    if (!image) return send(res, 502, { error: "The model returned no image" });
    send(res, 200, { image, prompt, cost: json?.usage?.cost ?? null });
  } catch (err) {
    console.error("[scene]", err);
    send(res, 500, { error: String(err?.message || err) });
  }
}

// ------------------------------------------------------------------- ideas
// Screen 1's idea generator: a few challenge objectives (each with a title) the
// user can pick from or ignore. Same free text model, no images returned.
async function handleIdeas(req, res) {
  const apiKey = key();
  if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
  try {
    const { hint = "", frames = [], count = 4 } = await readBody(req);
    const content = [
      {
        type: "text",
        text:
          `Suggest ${count} distinct social-challenge ideas for Shareity (brands fund ` +
          `challenges the community films on video).\n` +
          (hint ? `Direction from the user: "${hint}".\n` : "") +
          (frames.length ? `Look at the attached frame(s) and let them inspire the ideas.\n` : "") +
          `Each idea = a clear one-sentence OBJECTIVE (what people film and why it helps) ` +
          `plus a short punchy TITLE (max 42 chars, no quotes).\n` +
          `Reply ONLY with JSON: {"ideas":[{"objective":"...","title":"..."}]}.`,
      },
      ...frames.slice(0, 2).map((url) => ({ type: "image_url", image_url: { url } })),
    ];

    const { text, model, usage } = await chatJSON(
      apiKey,
      [
        { role: "system", content: "You are Steve, a creative director. Reply ONLY with valid JSON." },
        { role: "user", content },
      ],
      1200,
      IDEAS_MODELS,
    );
    const parsed = parseContent(text);
    const ideas = Array.isArray(parsed?.ideas) ? parsed.ideas.slice(0, count) : [];
    send(res, 200, { ideas, model, usage, cost: usage?.cost ?? null });
  } catch (err) {
    // Ideas are optional suggestions: a flaky free model (empty body, no JSON)
    // must not surface as an error. Degrade to an empty list — the wizard then
    // just invites the user to write their own.
    console.error("[ideas]", err);
    send(res, 200, { ideas: [] });
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
    return send(res, 200, {
      ok: true,
      service: "shareity-ai",
      key: key() ? "set" : "missing",
      textModel: MODELS[0],
      ideasModel: IDEAS_MODELS[0],
      badgeProvider: BADGE_PROVIDER,
      sceneProvider: SCENE_PROVIDER,
      imageModel: BADGE_PROVIDER === "openrouter" || SCENE_PROVIDER === "openrouter" ? IMAGE_MODEL : null,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/ai/generate") return handleGenerate(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/badge") return handleBadge(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/scene") return handleScene(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/ideas") return handleIdeas(req, res);

  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Shareity AI service  →  http://localhost:${PORT}`);
  console.log(`  OPENROUTER_API_KEY:  ${key() ? "found" : "MISSING — set it in the env"}`);
  console.log(`  Text model:          ${MODELS.join(", ")}`);
  console.log(`  Ideas model:         ${IDEAS_MODELS.join(", ")}`);
  console.log(`  Badge provider:      ${BADGE_PROVIDER}${BADGE_PROVIDER === "openrouter" ? ` (${IMAGE_MODEL})` : ""}`);
  console.log(`  Scene provider:      ${SCENE_PROVIDER}${SCENE_PROVIDER === "openrouter" ? ` (${IMAGE_MODEL})` : ""}`);
  console.log(`  CORS origin:         ${ALLOWED_ORIGIN}\n`);
});
