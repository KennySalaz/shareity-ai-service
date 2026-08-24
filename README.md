# Shareity AI service

Mini backend for the dashboard's **Create with AI** flow. Two endpoints that call
a model with the OpenRouter key kept **server-side** (never in the browser bundle).
Zero dependencies — plain Node `http` + built-in `fetch` (Node 18+).

Ported from the dashboard's `dev/aiHandlers.js`, so the prompt and JSON schema are
identical: when the real backend is ready, it can reuse this logic as-is.

## Endpoints
| Method | Path                | Does                                             |
|--------|---------------------|--------------------------------------------------|
| POST   | `/api/ai/generate`  | Challenge copy — text model, reads the clip frames |
| POST   | `/api/ai/badge`     | Challenge badge — image model                     |
| GET    | `/`                 | Health check (`{ ok, key: set/missing }`)         |

Request/response shapes: see `../shareitydashboard/dev/aiHandlers.js` or the backend spec.

## Run locally
```bash
cp .env.example .env         # then paste your OPENROUTER_API_KEY
npm start                    # or: OPENROUTER_API_KEY=sk-or-... npm start
# → http://localhost:8787   (GET / should return { ok: true, key: "set" })
```

## Deploy free on Render
1. Push this folder to its own git repo (GitHub/GitLab).
2. On [render.com](https://render.com): **New → Web Service → Build and deploy from a Git repo**.
   - Render reads `render.yaml`, or set manually: **Build** `npm install`, **Start** `npm start`.
3. **Environment → Add:** `OPENROUTER_API_KEY = <your key>` (and optionally tighten `ALLOWED_ORIGIN`).
4. Deploy → you get `https://shareity-ai-service.onrender.com`.

> Free tier sleeps after ~15 min idle → first request after idle is a ~50s cold
> start. Open the URL a minute before a demo to wake it.

## Point the dashboard at it
In the **dashboard** repo, set the build-time env so the front calls this service
instead of the (dev-only) Vite proxy:

```
# shareitydashboard/.env.local  (or the build env on appdev)
VITE_AI_HOST=https://shareity-ai-service.onrender.com
```

- Empty / unset → the front uses the local Vite proxy (dev), exactly like today.
- Set → the static front calls this service. CORS is already handled here.

## Security
- The key lives only in this service's env. Set `ALLOWED_ORIGIN` to your dashboard
  origin for anything beyond a short demo — with `*`, any site can spend your credit.
- OpenRouter is paid (Claude Opus 5 for text, ~$0.07 per badge image). Use a key
  with a spending limit while testing.
