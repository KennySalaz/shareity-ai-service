/* eslint-disable no-console */
// Shareity AI service — standalone mini backend for "Create with AI".
//
// The endpoints the dashboard front calls; all keep the OpenRouter credential
// server-side (env var), never in the browser bundle:
//   POST /api/ai/generate   -> challenge copy (text model, reads the clip frames)
//   POST /api/ai/badge      -> challenge badge (image model)
//   POST /api/ai/scene      -> step-1 cover photo (image model)
//   POST /api/ai/ideas      -> a few challenge ideas (text model)
//   POST /api/ai/animation  -> step-6 theme segment (HTML+SVG, text model)
//   GET  /                  -> health check
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
// Text model(s) on OpenRouter. Accepts a chain and uses the first that answers, so
// one model being down or rate-limited (429) does not break the wizard. Override
// with AI_TEXT_MODELS (comma-separated) for a chain, or AI_TEXT_MODEL for one model.
const parseModels = (v) => v.split(",").map((s) => s.trim()).filter(Boolean);
const MODELS = parseModels(
  process.env.AI_TEXT_MODELS ||
    process.env.AI_TEXT_MODEL ||
    "anthropic/claude-sonnet-5",
);
// Ideas are throwaway suggestions, so they can run on a cheaper model than the
// main generate call. Falls back to MODELS when not set.
const IDEAS_MODELS = process.env.AI_IDEAS_MODELS || process.env.AI_IDEAS_MODEL
  ? parseModels(process.env.AI_IDEAS_MODELS || process.env.AI_IDEAS_MODEL)
  : MODELS;
// Animation theme (step 6): the model writes an HTML+CSS+SVG fragment (code, not
// JSON), so it needs a strong visual-code model; weaker models produce broken
// markup. Sonnet 5 is the quality/price sweet spot. Override with
// AI_ANIMATION_MODELS (chain) or AI_ANIMATION_MODEL.
const ANIMATION_MODELS = process.env.AI_ANIMATION_MODELS || process.env.AI_ANIMATION_MODEL
  ? parseModels(process.env.AI_ANIMATION_MODELS || process.env.AI_ANIMATION_MODEL)
  : ["anthropic/claude-sonnet-5"];
// Every generated image (badges and the step-1 cover) comes from this OpenRouter
// image model. Override with AI_IMAGE_MODEL.
const IMAGE_MODEL = process.env.AI_IMAGE_MODEL || "google/gemini-3.1-flash-image";

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
    "A flat vector illustration that IS the badge: it fills the whole square canvas edge to edge.",
    `The solid ${color} background reaches all four edges and all four corners:`,
    "square corners, not a rounded app icon, no white or empty margin around it,",
    "no border, no outline, no sticker die-cut, no drop shadow.",
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

// Cover scene: the full-screen photo behind the challenge UI (header card on top,
// pitch and Accept button at the bottom), so the prompt steers the composition
// around them and keeps any text out of the picture.
function scenePrompt({ idea, title } = {}) {
  const MAX = 1100;
  // Quotes and markup around user text are what image models most often letter into the picture.
  const clean = (v) =>
    String(v ?? "")
      .replace(/["`“”«»<>{}[\]#*_|\\]/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[\s.,;:!?¡¿]+$/, "");
  const clip = (s, n) => (s.length <= n ? s : s.slice(0, n).replace(/\s+\S*$/, "") || s.slice(0, n));

  const what = clean(idea);
  const name = clean(title);

  // EN/ES keywords. A false positive only adds the child rule; a miss keeps the scene adults-only,
  // so an identifiable child is never requested either way.
  const kids =
    /\b(?:famil|niñ|alumn|guarder|infan)|\b(?:kids?|child|children|bab(?:y|ies)|toddlers?|teens?|students?|schools?|classroom|boys?|girls?|sons?|daughters?|parents?|moms?|dads?|bedtime|playground|nin[oa]s?|beb[eé]s?|hij[oa]s?|niet[oa]s?|escuelas?|colegios?|estudiantes?|adolescentes?|mam[aá]s?|pap[aá]s?|padres)(?![a-z])/i;
  const people = kids.test(`${what} ${name}`)
    ? "one or two adults in focus (any child only from behind or as hands, face never shown)"
    : "one to three ordinary adults of mixed ages and backgrounds";

  const lead = "Candid vertical smartphone photo, edge to edge, of this challenge being done: ";
  const tail = [
    ".",
    "The brief may be English or Spanish: depict it in a fitting everyday place, never write its words.",
    `Catch the one moment that proves it, shot by a friend at eye level, not a selfie, no phone in view: ${people}, mid-action, genuine joy or focus.`,
    "Natural light, crisp subject, soft background blur, true colours, real skin and hands, plain clothes. Not an ad or stock.",
    // The glass header card with white text covers the top ~21% and the pitch plus Accept button the
    // bottom ~30%, both under dark scrims. The prompt never names them: mentioning text invites text.
    "Faces a third down, action centred and readable as a thumbnail; top fifth calm and not bright, bottom third quiet ground, both real blurred parts of the place, never blank.",
    "Dignified and safe: no risky stunts, weapons or political symbols; hardship shown with agency, never pity.",
    "No text, letters, numbers, captions, signs, logos, brands, labels, printed clothes, timers, screens, watermarks, borders, device frames or UI.",
  ].join(" ");

  // Hard budget: the objective wins and the title is dropped first.
  const room = MAX - lead.length - tail.length;
  let brief = clip(what, room);
  if (name && !what.toLowerCase().includes(name.toLowerCase())) {
    const named = brief ? `${brief}. Its name, ${name}, only sets the mood` : name;
    brief = named.length <= room ? named : brief || clip(name, room);
  }
  return lead + (brief || "neighbours doing a small, joyful good deed together") + tail;
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

// ---------------------------------------------------------------- animation
// Step 6 of the celebration animation: the model writes ONLY the themed segment
// (what the challenge is about). It returns a self-contained HTML fragment the
// dashboard injects into a 400x711 phone canvas over the brand-colour background.
const ANIMATION_SYSTEM = `You are a motion designer at Shareity. You create ONE short, self-contained
"celebration" animation segment for a completed challenge — the part that is
ABOUT WHAT THE CHALLENGE IS. It plays inside a vertical 400x711 phone canvas,
over a background that is already the challenge's brand colour.

Output ONLY the HTML fragment — nothing else. No prose, no explanation, no
markdown code fences. The very first character of your reply is "<".

The fragment is exactly: one <style> block, then one
<div class="theme-root"> ... </div>.

Hard rules — follow ALL or the render breaks:
- EVERY CSS selector is scoped under .theme-root (e.g. ".theme-root .ball{}").
  Never write a bare "*", "body", "html" or unscoped tag selector.
- .theme-root is position:absolute; inset:0; children positioned absolutely.
- Pure CSS animation only. NO <script>, NO JS, NO on... attributes.
- NO external resources: no <img>, no network url(...), no @import. Draw the
  subject (the animal/object/scene of the challenge) with INLINE SVG in simple
  flat shapes, thick outlines, friendly children's-book style.
- Font 'Poppins', sans-serif is available. Include a big celebratory title
  (like "GREAT JOB!") in white/light text with good contrast, plus a short
  on-topic sub-line if it fits.
- Light: at most ~30 animated elements; animations ~2-3s; infinite loops ok.
  Use the challenge colour for accents.
- The subject MUST clearly reflect the challenge topic. Chicken dance => a cute
  dancing chicken; soccer => a bouncing soccer ball; tree planting => a growing
  tree. Add confetti or sparkle. Make it delightful and unmistakably on-topic.`;

// The fragment renders in a sandboxed iframe, but strip any <script> or on*
// handler the model returns anyway, as defence in depth.
function sanitizeThemeHtml(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*"[^"]*"/gi, "")
    .replace(/\son\w+\s*=\s*'[^']*'/gi, "");
}
// Models sometimes wrap the fragment in fences or prepend a sentence; keep from
// the first <style>/<div> onward.
function extractFragment(text) {
  let s = String(text || "").trim();
  s = s.replace(/^\s*```(?:html)?\s*/i, "").replace(/\s*```\s*$/i, "");
  const i = s.search(/<style|<div/i);
  if (i > 0) s = s.slice(i);
  return s.trim();
}

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
// Models sometimes wrap JSON in prose or markdown fences. Strip fences, then
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

// Resilience: try the chain and use the first model that answers. We ask for
// response_format json_object (widely supported, unlike json_schema) so the model
// emits a JSON object instead of an empty or prose reply — the prompts already say
// "reply only with JSON", which json_object requires. Providers still occasionally
// answer 200 with an EMPTY body, so we retry a model a couple of times before
// moving to the next; parseContent is the final safety net for stray fences.
const ATTEMPTS = 2;
// `json` requests a JSON object back (the default, for the challenge/ideas calls).
// Pass json:false when the model should return free-form text — the animation
// theme is an HTML fragment, not a JSON object, so json_object would be wrong.
// OpenRouter answers 402 when the account has no credit left for the request. The
// dashboard shows NO_CREDIT.error as is, so it is written for the admin.
const NO_CREDIT = { error: "Sin saldo en OpenRouter", code: "no_credit" };
function noCreditError(detail) {
  return Object.assign(new Error(detail), { code: "no_credit" });
}

async function chatJSON(apiKey, messages, maxTokens = 3000, models = MODELS, json = true) {
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
            ...(json ? { response_format: { type: "json_object" } } : {}),
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
      // Credit is account-wide: no other model in the chain can answer either.
      if (upstream.status === 402) throw noCreditError(lastErr);
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
    if (err?.code === "no_credit") return send(res, 402, NO_CREDIT);
    send(res, 500, { error: String(err?.message || err) });
  }
}

// Badges and covers share one OpenRouter call; only the framing and the seed
// differ. Gemini image models honour image_config.aspect_ratio and seed even though
// the model list does not advertise image_config.
async function generateImage(apiKey, prompt, { aspectRatio, seed } = {}) {
  const seedParam =
    seed != null && seed !== "" && Number.isFinite(Number(seed)) ? { seed: Number(seed) } : {};
  const upstream = await fetch(ENDPOINT, {
    method: "POST",
    headers: orHeaders(apiKey),
    body: JSON.stringify({
      model: IMAGE_MODEL,
      modalities: ["image", "text"],
      messages: [{ role: "user", content: prompt }],
      image_config: { aspect_ratio: aspectRatio },
      ...seedParam,
      usage: { include: true },
    }),
  });
  const raw = await upstream.text();
  if (!upstream.ok) return { status: upstream.status, detail: raw.slice(0, 200), noCredit: upstream.status === 402 };
  const json = JSON.parse(raw);
  const image = json?.choices?.[0]?.message?.images?.[0]?.image_url?.url;
  if (!image) return { status: 502, detail: "The model returned no image" };
  return { image, cost: json?.usage?.cost ?? null, model: json?.model || IMAGE_MODEL };
}

async function handleBadge(req, res) {
  const apiKey = key();
  if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
  try {
    const { title = "", subject = "", color = "#29ABE2", palette = "", seed } = await readBody(req);
    const prompt = badgePrompt({ title, subject, color, palette });
    // A different seed gives a different image: that is how the wizard asks for 3 versions.
    const out = await generateImage(apiKey, prompt, { aspectRatio: "1:1", seed });
    if (!out.image) {
      console.error("[badge] openrouter", out.status, out.detail);
      if (out.noCredit) return send(res, 402, NO_CREDIT);
      return send(res, out.status, { error: "Badge generation failed", detail: out.detail });
    }
    send(res, 200, { image: out.image, prompt, cost: out.cost, model: out.model });
  } catch (err) {
    console.error("[badge]", err);
    send(res, 500, { error: String(err?.message || err) });
  }
}

// ------------------------------------------------------------------- scene
// Step 1's cover image: a vertical 9:16 phone-screen photo built from the idea.
// Video is upload-only for now, so this is the only generated cover.
async function handleScene(req, res) {
  const apiKey = key();
  if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
  try {
    const { prompt: idea = "", title = "", seed } = await readBody(req);
    const prompt = scenePrompt({ idea, title });
    const out = await generateImage(apiKey, prompt, { aspectRatio: "9:16", seed });
    if (!out.image) {
      console.error("[scene] openrouter", out.status, out.detail);
      if (out.noCredit) return send(res, 402, NO_CREDIT);
      return send(res, out.status, { error: "Scene generation failed", detail: out.detail });
    }
    send(res, 200, { image: out.image, prompt, cost: out.cost, model: out.model });
  } catch (err) {
    console.error("[scene]", err);
    send(res, 500, { error: String(err?.message || err) });
  }
}

// ------------------------------------------------------------------- ideas
// Screen 1's idea generator: a few challenge objectives (each with a title) the
// user can pick from or ignore. Uses AI_IDEAS_MODELS (or the text chain).
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
    // Ideas are optional suggestions: a flaky model (empty body, no JSON)
    // must not surface as an error. Degrade to an empty list — the wizard then
    // just invites the user to write their own.
    console.error("[ideas]", err);
    if (err?.code === "no_credit") return send(res, 402, NO_CREDIT);
    send(res, 200, { ideas: [] });
  }
}

// ------------------------------------------------------------------- animation
// Step 6's theme: the model returns the HTML fragment (scoped under .theme-root)
// that the dashboard drops into the celebration animation. Same shape the
// dashboard's aiAnimationRemote.js expects: { theme: { html, label, sub } }.
async function handleAnimation(req, res) {
  const apiKey = key();
  if (!apiKey) return send(res, 503, { error: "OPENROUTER_API_KEY is not set." });
  try {
    const {
      name = "", description = "", color = "#0a84e8",
      causeColor = "#59c7f9", tone = "Playful",
    } = await readBody(req);

    const user =
      `Challenge name: "${name}"\n` +
      `What it is about: "${description}"\n` +
      `Brand colour: ${color}\n` +
      `Cause colour: ${causeColor}\n` +
      `Tone: ${tone}\n\n` +
      `Return the themed celebration segment for THIS challenge as the HTML fragment.`;

    // json:false — the model returns an HTML fragment, not a JSON object.
    const { text, model, usage } = await chatJSON(
      apiKey,
      [
        { role: "system", content: ANIMATION_SYSTEM },
        { role: "user", content: user },
      ],
      8000,
      ANIMATION_MODELS,
      false,
    );

    const html = sanitizeThemeHtml(extractFragment(text));
    if (!html || !html.includes("theme-root")) {
      return send(res, 502, {
        error: "The model returned an invalid theme",
        detail: String(text).slice(0, 300),
      });
    }
    send(res, 200, {
      theme: { html, label: "GREAT JOB!", sub: "" },
      model,
      usage,
      cost: usage?.cost ?? null,
    });
  } catch (err) {
    console.error("[animation]", err);
    if (err?.code === "no_credit") return send(res, 402, NO_CREDIT);
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
    return send(res, 200, {
      ok: true,
      service: "shareity-ai",
      key: key() ? "set" : "missing",
      textModel: MODELS[0],
      ideasModel: IDEAS_MODELS[0],
      animationModel: ANIMATION_MODELS[0],
      imageModel: IMAGE_MODEL,
    });
  }
  if (req.method === "POST" && url.pathname === "/api/ai/generate") return handleGenerate(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/badge") return handleBadge(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/scene") return handleScene(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/ideas") return handleIdeas(req, res);
  if (req.method === "POST" && url.pathname === "/api/ai/animation") return handleAnimation(req, res);

  send(res, 404, { error: "not found" });
});

server.listen(PORT, HOST, () => {
  console.log(`\n  Shareity AI service  →  http://localhost:${PORT}`);
  console.log(`  OPENROUTER_API_KEY:  ${key() ? "found" : "MISSING — set it in the env"}`);
  console.log(`  Text model:          ${MODELS.join(", ")}`);
  console.log(`  Ideas model:         ${IDEAS_MODELS.join(", ")}`);
  console.log(`  Animation model:     ${ANIMATION_MODELS.join(", ")}`);
  console.log(`  Image model:         ${IMAGE_MODEL}`);
  console.log(`  CORS origin:         ${ALLOWED_ORIGIN}\n`);
});
