// TasteBrief — /api/brief
// Server-side only. QLOO_API_KEY lives in the Netlify environment, never in the browser.
//
// Pipeline (all data comes from live Qloo calls — nothing is invented):
//   1. Resolve each seed string to a Qloo entity via /search.
//   2. For each briefing domain, call /v2/insights seeded by ALL resolved entities,
//      with feature.explainability=true so every pick can be traced to the seed(s)
//      that actually drove it.
//   3. "Why" per pick = contributing seeds (explainability scores) + tags the pick
//      shares with the seed set (from the payloads themselves).
//   4. Trending strip: /v2/trending time-series for the seeds themselves
//      (latest popularity percentile + chart rank).
//   5. A domain that returns nothing is omitted. No card is ever fabricated.

const API_BASE = process.env.QLOO_API_BASE || 'https://hackathon.api.qloo.com';
const API_KEY = process.env.QLOO_API_KEY;

// Briefing domains: Qloo insights filter types verified live on the hackathon key.
// urn:entity:video_game is intentionally absent — the hackathon environment
// rejects it for filter.type (HTTP 400), so it is excluded defensively.
const DOMAINS = [
  { key: 'movie',       label: 'Films to watch',        type: 'urn:entity:movie' },
  { key: 'tv_show',     label: 'Shows to watch',        type: 'urn:entity:tv_show' },
  { key: 'artist',      label: 'Artists to hear',       type: 'urn:entity:artist' },
  { key: 'podcast',     label: 'Podcasts to try',       type: 'urn:entity:podcast' },
  { key: 'book',        label: 'Books to read',         type: 'urn:entity:book' },
  { key: 'place',       label: 'Places to eat & visit', type: 'urn:entity:place' },
  { key: 'destination', label: 'Destinations to visit', type: 'urn:entity:destination' },
  { key: 'brand',       label: 'Brands to try',         type: 'urn:entity:brand' },
];

// Types a /search hit may carry and still be usable as a taste-graph signal.
const SEED_TYPES = new Set([
  'urn:entity:movie', 'urn:entity:tv_show', 'urn:entity:artist', 'urn:entity:place',
  'urn:entity:book', 'urn:entity:podcast', 'urn:entity:brand', 'urn:entity:destination',
  'urn:entity:person', 'urn:entity:video_game',
]);
// Fallback order for typed searches when the untyped search finds nothing usable.
const SEED_SEARCH_ORDER = ['artist', 'movie', 'tv_show', 'place', 'book', 'podcast', 'brand', 'destination'];
// /v2/trending only accepts these filter types.
const TRENDING_TYPES = new Set(['urn:entity:artist', 'urn:entity:brand', 'urn:entity:movie', 'urn:entity:person', 'urn:entity:podcast', 'urn:entity:tv_show']);

const cache = new Map(); // seed-set key -> { at, payload } (in-memory, per warm instance)
const CACHE_TTL_MS = 10 * 60 * 1000;

function norm(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim(); }

async function qloo(path, params, attempt = 0) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}${path}?${qs}`, { headers: { 'X-Api-Key': API_KEY } });
  if ((res.status === 429 || res.status >= 500) && attempt < 1) {
    await new Promise(r => setTimeout(r, 600));
    return qloo(path, params, attempt + 1);
  }
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  if (!res.ok) {
    const msg = json?.errors?.[0]?.message || `HTTP ${res.status}`;
    const err = new Error(`Qloo ${path} failed: ${msg}`);
    err.status = res.status;
    throw err;
  }
  return json;
}

// When several types share an exact name, prefer the culturally "seed-like"
// types over person (e.g. "Nobu" the restaurant over Nobu the person).
const TYPE_PREF = ['artist', 'movie', 'tv_show', 'place', 'destination', 'book', 'podcast', 'brand', 'video_game', 'person']
  .map(t => `urn:entity:${t}`);

function tokens(s) { return norm(s).split(' ').filter(t => t.length >= 2); }

// A search hit only counts as resolving a seed if its name genuinely matches
// what the user typed — Qloo search returns fuzzy/popular results for
// gibberish, and silently substituting those would be fabrication.
function nameMatches(input, name) {
  const a = tokens(input), b = tokens(name);
  if (!a.length || !b.length) return norm(input) === norm(name);
  const setA = new Set(a), setB = new Set(b);
  return a.every(t => setB.has(t)) || b.every(t => setA.has(t));
}

function pickFromSearch(results, input) {
  if (!Array.isArray(results)) return null;
  const usable = results.filter(e =>
    e && e.entity_id &&
    (e.types || []).some(t => SEED_TYPES.has(t)) &&
    nameMatches(input, e.name));
  if (!usable.length) return null;
  const target = norm(input);
  const exact = usable.filter(e => norm(e.name) === target);
  const pool = exact.length ? exact : usable;
  const pref = e => {
    const idx = TYPE_PREF.indexOf((e.types || [])[0]);
    return idx === -1 ? 99 : idx;
  };
  return pool.sort((a, b) => pref(a) - pref(b) || (b.popularity || 0) - (a.popularity || 0))[0];
}

async function resolveSeed(input) {
  // 1) untyped search first — one call, cross-domain.
  try {
    const j = await qloo('/search', { query: input, take: '8' });
    const hit = pickFromSearch(j?.results, input);
    if (hit) return hit;
  } catch { /* fall through to typed searches */ }
  // 2) typed searches in a fixed order until something resolves.
  for (const t of SEED_SEARCH_ORDER) {
    try {
      const j = await qloo('/search', { query: input, types: `urn:entity:${t}`, take: '3' });
      const hit = pickFromSearch(j?.results, input);
      if (hit) return hit;
    } catch { /* try next type */ }
  }
  return null;
}

function dedupeNames(names, cap) {
  const seen = new Set(); const out = [];
  for (const n of names) {
    if (!n) continue;
    const k = n.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(n);
    if (out.length >= cap) break;
  }
  return out;
}

function seedSummary(input, e) {
  return {
    input,
    entity_id: e.entity_id,
    name: e.name,
    type: (e.types || [])[0] || null,
    popularity: typeof e.popularity === 'number' ? e.popularity : null,
    tags: dedupeNames((e.tags || []).map(t => t.name), 12),
    image: e.properties?.image?.url || null,
  };
}

function buildWhy(pick, seedById) {
  const why = { seeds: [], sharedTags: [] };
  const contribs = pick.query?.explainability?.['signal.interests.entities'] || [];
  why.seeds = contribs
    .filter(c => c.score >= 0.1 && seedById.has(c.entity_id))
    .sort((a, b) => b.score - a.score)
    .map(c => ({ name: seedById.get(c.entity_id).name, score: Math.round(c.score * 100) / 100 }));
  const seedTags = new Map(); // lowercase -> original casing
  for (const s of seedById.values()) for (const t of s.tags) seedTags.set(t.toLowerCase(), t);
  const seen = new Set();
  why.sharedTags = (pick.tags || [])
    .map(t => t.name)
    .filter(n => {
      if (!n) return false;
      const k = n.toLowerCase();
      if (!seedTags.has(k) || seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .slice(0, 3);
  return why;
}

function pickSummary(pick, seedById) {
  const p = pick.properties || {};
  return {
    entity_id: pick.entity_id,
    name: pick.name,
    type: pick.subtype || null,
    affinity: typeof pick.query?.affinity === 'number' ? Math.round(pick.query.affinity * 1000) / 1000 : null,
    popularity: typeof pick.popularity === 'number' ? Math.round(pick.popularity * 1000) / 1000 : null,
    image: p.image?.url || null,
    description: p.description ? String(p.description).slice(0, 220) : null,
    genres: Array.isArray(p.genres) ? p.genres.slice(0, 3) : [],
    release_year: p.release_year || null,
    address: p.address || null,
    rating: typeof p.business_rating === 'number' ? Math.round(p.business_rating * 10) / 10 : null,
    tags: dedupeNames((pick.tags || []).map(t => t.name), 5),
    why: buildWhy(pick, seedById),
  };
}

async function domainPicks(domain, seedIds, seedById) {
  const j = await qloo('/v2/insights', {
    'filter.type': domain.type,
    'signal.interests.entities': seedIds.join(','),
    'feature.explainability': 'true',
    take: '6',
  });
  const entities = j?.results?.entities || [];
  const picks = entities
    .filter(e => e && e.entity_id && !seedById.has(e.entity_id))
    .slice(0, 4)
    .map(e => pickSummary(e, seedById));
  return picks.length ? { key: domain.key, label: domain.label, picks } : null;
}

async function trendingFor(seed) {
  if (!TRENDING_TYPES.has(seed.type)) return null;
  const iso = d => d.toISOString().slice(0, 10);
  const j = await qloo('/v2/trending', {
    'filter.type': seed.type,
    'signal.interests.entities': seed.entity_id,
    'filter.start_date': iso(new Date(Date.now() - 180 * 864e5)),
    'filter.end_date': iso(new Date()),
    take: '12',
  });
  const series = j?.results?.trending || [];
  if (!series.length) return null;
  const latest = series[0]; // ordered by date, descending
  return {
    name: seed.name,
    type: seed.type,
    date: latest.date || null,
    percentile: typeof latest.population_percentile === 'number' ? Math.round(latest.population_percentile * 1000) / 1000 : null,
    rank: latest.population_rank != null ? String(latest.population_rank) : null,
    spark: series.slice().reverse().map(pt => (typeof pt.population_percentile === 'number' ? Math.round(pt.population_percentile * 1000) / 1000 : null)),
  };
}

async function buildBriefing(inputs) {
  const resolvedRaw = await Promise.all(inputs.map(i => resolveSeed(i).catch(() => null)));
  const seeds = [];
  const unresolved = [];
  inputs.forEach((input, idx) => {
    if (resolvedRaw[idx]) seeds.push(seedSummary(input, resolvedRaw[idx]));
    else unresolved.push(input);
  });
  if (!seeds.length) return { seeds, unresolved, domains: [], trending: [] };

  const seedById = new Map(seeds.map(s => [s.entity_id, s]));
  const seedIds = seeds.map(s => s.entity_id);

  const [domainResults, trendingResults] = await Promise.all([
    Promise.all(DOMAINS.map(d => domainPicks(d, seedIds, seedById).catch(() => null))),
    Promise.all(seeds.map(s => trendingFor(s).catch(() => null))),
  ]);

  return {
    seeds,
    unresolved,
    domains: domainResults.filter(Boolean),
    trending: trendingResults.filter(Boolean).sort((a, b) => (b.percentile || 0) - (a.percentile || 0)).slice(0, 5),
  };
}

export async function handler(event) {
  const headers = { 'Content-Type': 'application/json' };
  if (!API_KEY) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Server is missing its Qloo API key configuration.' }) };
  }
  let inputs = [];
  try {
    if (event.httpMethod === 'POST' && event.body) {
      const body = JSON.parse(event.body);
      inputs = Array.isArray(body.seeds) ? body.seeds : [];
    } else if (event.queryStringParameters?.seeds) {
      inputs = String(event.queryStringParameters.seeds).split(',');
    }
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Request body must be JSON: { "seeds": ["...", "..."] }' }) };
  }
  inputs = inputs.map(s => String(s).trim()).filter(Boolean).slice(0, 5);
  if (inputs.length < 2) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Give me 2–5 things you love to build a briefing.' }) };
  }

  const cacheKey = inputs.map(norm).sort().join('|');
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) {
    return { statusCode: 200, headers, body: JSON.stringify({ ...hit.payload, cached: true }) };
  }

  try {
    const briefing = await buildBriefing(inputs);
    const payload = { ...briefing, generatedAt: new Date().toISOString(), cached: false };
    cache.set(cacheKey, { at: Date.now(), payload });
    return { statusCode: 200, headers, body: JSON.stringify(payload) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'The taste graph could not be reached just now. Please try again in a moment.' }) };
  }
}
