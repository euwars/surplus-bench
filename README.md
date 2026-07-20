# surplus-bench

A live dashboard that benchmarks a set of models on
[Surplus Intelligence](https://surplusintelligence.ai) every 10 minutes and
tracks, per model:

- **JSON reliability** — did it produce schema-valid structured output (via the
  AI SDK's `streamObject` + a zod schema; the whole test is "does it conform").
- **first token** (TTFT) and **tok/s** (content decode rate).
- **duration** and real **cost** (Surplus returns per-call cost in the usage).
- **thinking** — did the model reason (reasoning tokens), and were we able to
  **see** the reasoning stream. The same reasoning effort is requested for every
  model so the comparison is fair.

The page loads instantly from stored results; the backend refreshes on a cron.
On first deploy with no data, the UI kicks a run itself and shows live status,
a per-model table, and reliability sparklines over history.

No provider pinning — requests hit Surplus's default routing, with one retry on
a transient marketplace blip.

## Configure

One required env var:

```
SURPLUS_API_KEY=inf_...
```

Locally, put it in `.env.local` (gitignored). On Vercel, set it in Project
Settings → Environment Variables.

Edit the model list, prompt, and reasoning effort in `lib/models.ts`.

## Run locally

```
npm install
npm run dev        # dashboard at http://localhost:3000
npm run bench      # one benchmark pass printed to the terminal
```

## Deploy to Vercel (push-to-deploy)

1. Import this GitHub repo at [vercel.com/new](https://vercel.com/new).
2. Add `SURPLUS_API_KEY` under Environment Variables.
3. Deploy. `vercel.json` already registers the every-10-minute cron
   (`/api/run`). Every `git push` redeploys.

### Persistent history (optional)

Without a store, history lives in memory (fine locally, resets per serverless
instance on Vercel). For durable history charts, add a **Vercel KV** store to
the project (Storage tab, one click) — it sets `KV_REST_API_URL` /
`KV_REST_API_TOKEN` automatically and the app uses them with no code change.
