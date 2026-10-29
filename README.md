# TasteBrief — a discovery agent with actual taste

Tell TasteBrief a few things you already love — an artist, a film, a cuisine, a
neighbourhood, in any mix. It resolves them in **Qloo's taste graph**, walks the
connections an LLM can only guess at, and hands you a cross-domain briefing:
films and shows to watch, artists and podcasts to hear, books to read, places to
eat and visit, destinations and brands to try — **each pick labelled with the
taste thread it hangs from**, plus a live read on how your own seeds are
trending right now.

## Why Qloo is the product, not a garnish

Every recommendation, explanation and trending figure comes from a live Qloo
call:

1. **Entity search** (`/search`) resolves each seed name to a Qloo entity.
2. **Cross-domain recommendations** (`/v2/insights`, one call per domain,
   seeded by *all* resolved entities, `feature.explainability=true`) produce
   the picks. The explainability payload says which seed(s) actually drove each
   pick and with what weight — that is the "why" line, not a generated story.
   Shared tags between a pick and the seed set are computed from the payloads.
3. **Trending** (`/v2/trending`) returns the popularity time-series of the
   seeds themselves — the strip shows each seed's current popularity
   percentile and chart rank.

Remove the API and there is no briefing, only an LLM bluffing about taste.

**Honesty by construction:** a domain that returns nothing gets no card. A
seed that can't be resolved in the graph is reported as unresolved, never
quietly replaced. Nothing in the UI is hard-coded or pre-baked.

## Run it locally (zero dependencies)

Requires Node.js 18+ and a Qloo hackathon API key.

```bash
QLOO_API_KEY=your-key node scripts/dev.mjs
# → http://localhost:8899
```

`QLOO_API_BASE` defaults to `https://hackathon.api.qloo.com` (hackathon keys
only work against that host). See `.env.example`.

## Deploy (Netlify)

1. Create a Netlify site from this repo (build settings are in `netlify.toml`:
   publish `public/`, functions `netlify/functions/`, `/api/brief` rewrites to
   the function).
2. Set the environment variable **`QLOO_API_KEY`** in the Netlify site
   settings. The key is used **server-side only** — it never appears in the
   static page, the repo, or any browser request.

## Layout

```
public/index.html            one-page UI (vanilla JS, no build step)
netlify/functions/brief.mjs  the whole agent pipeline behind /api/brief
scripts/dev.mjs              zero-dependency local server for the same code
netlify.toml                 Netlify build + redirect config
```

Notes from building against the hackathon environment:

- `urn:entity:video_game` is rejected as an Insights `filter.type` there, so
  it is deliberately excluded from the domain map (defensive mapping: fall
  back, never fail the whole briefing).
- Briefings are cached in memory per seed-set for 10 minutes to respect the
  event quota during judging.

## Licence

MIT — see `LICENSE`.

A Qloo Agentic Hackathon project by Nenzy Brown.
