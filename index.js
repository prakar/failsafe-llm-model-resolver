/**
 * llm-model-resolver
 *
 * Resolve the current model ID for an LLM provider at runtime instead of
 * hard-coding it. Works across xAI, Anthropic, Gemini, and OpenRouter.
 *
 *   resolveModel(provider, apiKey, options?)
 *     → Promise<{ id, source: 'live'|'fallback', orderedBy }>
 *
 * How a model is chosen
 * ─────────────────────
 * 1. Fetch the provider's live model list (cached for the process lifetime).
 * 2. Drop models reported with markModelBad().
 * 3. Keep models matching the provider's include rule and not its exclude rule
 *    (relaxing in two steps rather than returning nothing - see choose()).
 * 4. Order what's left NEWEST FIRST using the best recency signal the provider
 *    actually gives us:
 *      xAI        `created`    (Unix time - NOT the version in the ID, see below)
 *      Anthropic  `created_at` (RFC 3339)
 *      Gemini     no timestamp exists; use the generation number in the ID
 *    A model with no usable signal sorts AFTER models that have one. If nothing
 *    has a signal, the provider's own order is kept.
 * 5. Take the first. If anything fails, or nothing usable is left, return the
 *    pinned fallback so a transient error never kills a batch job.
 *
 * Why xAI is sorted by timestamp and not by parsing the ID: xAI ships IDs like
 * `grok-4.20-0309-reasoning` and `grok-4.3`. Read as dotted versions, 4.20 ranks
 * above 4.3, but those numbers are product names (sometimes with a date suffix),
 * not a release counter - so the release timestamp is the only trustworthy
 * ordering. Parsing versions out of IDs is only reasonable where the numbering
 * really is monotonic (Gemini: 2.5 < 3 < 3.1).
 *
 * @see https://github.com/prakar/llm-model-resolver
 */

'use strict';

const PROVIDERS = ['xai', 'anthropic', 'gemini', 'openrouter'];

/** Per-request network timeout. A hung /models endpoint is abandoned after this. */
const DEFAULT_TIMEOUT_MS = 10_000;
/**
 * After a failed list fetch, don't retry that provider for this long (falls back
 * meanwhile). Without it a hung endpoint would cost DEFAULT_TIMEOUT_MS on EVERY
 * call of a long batch - a timeout alone only turns one long stall into many
 * short ones.
 */
const DEFAULT_COOLDOWN_MS = 60_000;

// ---------------------------------------------------------------------------
// In-memory caches (process lifetime)
// ---------------------------------------------------------------------------
const _cache = {
  xai: null,               // entries: [{ id, created, generation }]
  anthropic: null,
  gemini: null,
  openrouter: null,        // Set of free model ids
};
let _orFreeIdx = 0;        // round-robin index for OpenRouter free models

// When a list fetch last failed, and why. Drives the cool-down above.
const _failedAt  = { xai: 0, anthropic: 0, gemini: 0, openrouter: 0 };
const _lastError = { xai: null, anthropic: null, gemini: null, openrouter: null };
const _now = () => Date.now();

// ---------------------------------------------------------------------------
// "Known-bad" models — a model can be genuinely listed by a provider's own
// live /models endpoint and STILL fail the actual generation call. Observed in
// production: Gemini returning 404 "no longer available to new users" for a
// model its own listing still showed. Google documents why: access to the 2.5
// models was limited to accounts that had used them before - the models were
// not deprecated, just gated by account history, which no list endpoint
// exposes. This is a different fact from "does this model exist" (_cache
// above) and needs its own cache: a model can be valid AND bad at once.
//
// DESIGN NOTE FOR ANYONE FORKING OR EXTENDING THIS FILE, READ BEFORE ADDING
// PERSISTENCE OR A TTL HERE:
//
// This cache is deliberately in-memory only, scoped to the current process,
// with NO disk persistence and NO time-based expiry. That is not a missing
// feature - it's the fix for the exact bug class this whole package exists
// to prevent. If you persist "known-bad" to disk with no expiry, you
// recreate a hardcoded-stale-model bug with extra steps: the day the
// provider fixes the model, or the caller's account tier changes, a
// persisted bad-list keeps avoiding a model that now works, silently,
// forever, with no signal telling you it's wrong. A TTL "fixes" that at the
// cost of inventing its own new failure surface (wrong duration, clock
// skew, timezone bugs) to get right.
//
// Tying this cache to the process lifetime needs none of that. It goes away
// automatically the moment the process exits - the next invocation always
// re-validates a previously-bad model exactly once before falling through
// again if it's still broken. For a long batch job (thousands of calls, one
// process, hours), this is precisely where the win matters: discover the
// bad model once, skip it for the rest of the run. For a short one-off CLI
// call, the cost of "one wasted call on rediscovery" is trivial. Either way,
// correctness comes from where the boundary naturally sits, not from logic
// you have to write and can get wrong.
//
// (The fetch-failure cool-down above is a different animal and IS time-based:
// it only suppresses re-fetching a list for a minute, it never hides a model.)
//
// If you genuinely need cross-process memory of a bad model, the correct
// place for that is the CALLING application's own operational monitoring
// (it already knows it's making repeated calls to the same provider), not
// this package pretending to be a persistent state store.
const _knownBad = {
  xai: new Set(),
  anthropic: new Set(),
  gemini: new Set(),
};

// ---------------------------------------------------------------------------
// Defaults / env fallbacks
//
// These are LAST-RESORT pins, used only when live resolution fails. They were
// reviewed on 2026-09-28 against provider docs and production use - NOT
// against your account, which is why you should set your own (see README).
// Chosen for durability, not for being the newest:
//   xai        grok-4               worked in production 2026-09-27. xAI has
//                                   retired dated grok-4 IDs before but
//                                   redirects them, so the alias keeps working.
//   anthropic  claude-sonnet-5      Anthropic's published model string.
//   gemini     gemini-flash-latest  Google's auto-updating alias. Replaces
//                                   gemini-2.5-pro, which is access-limited to
//                                   accounts that used it before, and unlike
//                                   gemini-2.5-flash it doesn't carry a
//                                   published shutdown date.
//   openrouter openrouter/free      OpenRouter's own router.
// ---------------------------------------------------------------------------
const DEFAULT_FALLBACKS = {
  xai:        process.env.XAI_MODEL_FALLBACK        || process.env.GROK_MODEL_FALLBACK        || 'grok-4',
  anthropic:  process.env.ANTHROPIC_MODEL_FALLBACK  || 'claude-sonnet-5',
  gemini:     process.env.GEMINI_MODEL_FALLBACK     || 'gemini-flash-latest',
  openrouter: process.env.OPENROUTER_MODEL_FALLBACK || process.env.OPENROUTER_FREE_FALLBACK || 'openrouter/free',
};

// Preference patterns for paid providers. They pick WHICH models are eligible;
// recency ordering (see orderCandidates) then picks among them.
const PREFERENCE = {
  // Prefer flagship grok-*, skip fast / mini / code-fast variants when possible
  xai: {
    include: /^grok-/i,
    // "non-reasoning" is intentionally its own term here, not "reasoning" -
    // xAI ships paired variants like grok-4.20-0309-reasoning and
    // grok-4.20-0309-non-reasoning. Excluding bare /reasoning/ would match
    // BOTH strings (non-reasoning contains "reasoning" as a substring) and
    // throw away the good one along with the bad one. non-?reasoning also
    // catches an unhyphenated "nonreasoning" form if xAI ever ships one.
    // Tagging/classification work benefits from the reasoning variant, so
    // steer away from the faster-but-shallower non-reasoning one by default.
    //
    // image|imagine|video: xAI's /v1/models lists image-generation models
    // (e.g. grok-2-image-1212) alongside chat models. The fetch prefers
    // /v1/language-models, which has none, but /v1/models is the fallback and
    // these names would otherwise pass the include rule.
    exclude: /fast|mini|lite|code-fast|non-?reasoning|image|imagine|video/i,
  },
  // Prefer sonnet/opus over haiku. Anthropic documents its list as newest-first, so the first match is the latest.
  anthropic: {
    include: /^claude-/i,
    exclude: /haiku|instant|mini/i,
  },
  // Prefer pro / non-flash / non-lite when available.
  // image|audio: gemini-3-pro-image-preview and the native-audio models are
  // real "pro"/"flash" names that a name-only rule would happily rank as the
  // best text model (image-output models DO advertise generateContent).
  gemini: {
    include: /gemini-/i,
    exclude: /flash|lite|embedding|aqa|imagen|veo|tts|live|image|audio/i,
  },
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function _positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function timeoutFrom(options) {
  return _positive(options && options.timeoutMs)
      || _positive(process.env.LLM_MODEL_RESOLVER_TIMEOUT_MS)
      || DEFAULT_TIMEOUT_MS;
}

function cooldownFrom(options) {
  const n = Number(options && options.cooldownMs);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_COOLDOWN_MS;
}

/**
 * Normalise a provider timestamp to epoch milliseconds, or null when unknown.
 * Accepts Unix seconds (xAI), epoch ms, or an RFC 3339 string (Anthropic).
 * An epoch-zero value means "release date unknown" (Anthropic documents this),
 * so it is treated as missing rather than as "the oldest model ever".
 */
function toMs(v) {
  let n;
  if (typeof v === 'string') n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
  else n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

/** gemini-3.1-pro-preview → [3,1]; gemini-2.5-pro → [2,5]; gemini-pro-latest → null */
function geminiGeneration(id) {
  const m = /^gemini-(\d+(?:\.\d+)*)/i.exec(id);
  return m ? m[1].split('.').map(Number) : null;
}

function cmpVersion(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] || 0) - (b[i] || 0);
    if (d) return d;
  }
  return 0;
}

function hostOf(url) {
  try { return new URL(url).host; } catch (_) { return 'provider'; }
}

// ---------------------------------------------------------------------------
// Tiny fetch helper (native fetch, Node 18+)
// ---------------------------------------------------------------------------
async function httpGet(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', ...headers },
      // Covers the whole exchange including reading the body, so a server that
      // sends headers and then stalls is abandoned too.
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      // Host only: the Gemini URL carries the API key in its query string, and
      // this message ends up in caller logs.
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${hostOf(url)}`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Per-provider fetch + normalize → entries: [{ id, created, generation }]
// `created` is epoch ms or null; `generation` is a number[] or null. Entries
// stay in the provider's own order; ordering by recency happens later.
// ---------------------------------------------------------------------------
async function fetchXaiModels(apiKey, timeoutMs) {
  const headers = { Authorization: `Bearer ${apiKey}` };
  const toEntry = m => {
    const id = m && (m.id || m.name);
    return id ? { id, created: toMs(m.created), generation: null } : null;
  };

  // Preferred: /v1/language-models lists only chat + image-understanding
  // models, so image-generation models (which /v1/models mixes in) never reach
  // the preference rules. Both endpoints carry `created`.
  try {
    const json = await httpGet('https://api.x.ai/v1/language-models', headers, timeoutMs);
    const entries = (json.models || json.data || []).map(toEntry).filter(Boolean);
    if (entries.length) return entries;
  } catch (_) { /* fall through to the general list */ }

  const json = await httpGet('https://api.x.ai/v1/models', headers, timeoutMs);
  return (json.data || json.models || []).map(toEntry).filter(Boolean);
}

async function fetchAnthropicModels(apiKey, timeoutMs) {
  // The endpoint returns 20 per page unless asked otherwise (max 1000). Asking
  // for the maximum means recency ordering sees the whole list, not page one.
  const json = await httpGet('https://api.anthropic.com/v1/models?limit=1000', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  }, timeoutMs);
  // Shape: { data: [ { id, display_name, created_at } ] }. Anthropic documents
  // this list as newest-first; created_at is what we sort on.
  return (json.data || [])
    .filter(m => m && m.id)
    .map(m => ({ id: m.id, created: toMs(m.created_at), generation: null }));
}

async function fetchGeminiModels(apiKey, timeoutMs) {
  // Gemini uses query-string key and a different envelope
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
  const json = await httpGet(url, {}, timeoutMs);
  // Shape: { models: [ { name: "models/gemini-…", supportedGenerationMethods: [...], … } ] }
  // No release timestamp exists in this API, so recency comes from the
  // generation number in the ID. Deprecated-but-still-listed models appear in
  // this list too (see the known-bad note above).
  //
  // Filter on the FULL model object first (supportedGenerationMethods lives
  // there), THEN reduce to an id. (An earlier version reduced to a bare id
  // string first and then tried to read the method list off a variable that
  // was no longer in scope - a ReferenceError on every real call.)
  return (json.models || [])
    .filter(m => {
      const methods = m.supportedGenerationMethods || m.supported_actions || [];
      return methods.some(x => /generateContent/i.test(x));
    })
    .map(m => {
      const name = m.name || '';
      // The ID used in generateContent is the part after "models/"
      const id = name.startsWith('models/') ? name.slice(7) : name;
      return { id, created: null, generation: geminiGeneration(id) };
    })
    .filter(e => e.id);
}

async function fetchOpenRouterFreeModels(apiKey, timeoutMs) {
  const json = await httpGet('https://openrouter.ai/api/v1/models', {
    Authorization: `Bearer ${apiKey}`,
  }, timeoutMs);
  // Free = pricing.prompt === "0" && pricing.completion === "0" (string or number)
  const isZero = v => v === 0 || v === '0' || v === '0.0' || v === '0.00';
  return (json.data || [])
    .filter(m => m.pricing && isZero(m.pricing.prompt) && isZero(m.pricing.completion))
    .map(m => m.id)
    .filter(Boolean);
}

const FETCHERS = {
  xai: fetchXaiModels,
  anthropic: fetchAnthropicModels,
  gemini: fetchGeminiModels,
};

// ---------------------------------------------------------------------------
// Ordering + selection (paid providers)
// ---------------------------------------------------------------------------

/**
 * Order eligible entries newest-first. Returns { ordered, orderedBy } where
 * orderedBy names the signal actually used: 'created' | 'version' | 'provider'.
 * Entries with no signal sort after entries that have one, in provider order,
 * and the sort is stable so ties keep the provider's order too.
 */
function orderCandidates(entries, mode) {
  let signal = 'provider';
  if (mode !== 'provider') {
    if (entries.some(e => e.created != null)) signal = 'created';
    else if (entries.some(e => e.generation)) signal = 'version';
  }
  if (signal === 'provider') return { ordered: entries.slice(), orderedBy: 'provider' };

  const keyOf = e => (signal === 'created' ? e.created : e.generation);
  const decorated = entries.map((e, i) => ({ e, i }));
  decorated.sort((a, b) => {
    const ka = keyOf(a.e), kb = keyOf(b.e);
    if (ka == null && kb == null) return a.i - b.i;
    if (ka == null) return 1;
    if (kb == null) return -1;
    const d = signal === 'created' ? kb - ka : cmpVersion(kb, ka);
    return d || a.i - b.i;
  });
  return { ordered: decorated.map(x => x.e), orderedBy: signal };
}

/**
 * Pick from usable entries. Relaxes rather than giving up:
 *   tier 1: include AND NOT exclude
 *   tier 2: include only (exclude ignored) - so a provider that only lists
 *           `fast` models still yields one
 *   tier 3: the first entry, whatever it is
 * Recency ordering applies within tiers 1 and 2 only; tier 3 has no basis for
 * ranking, so it keeps the provider's order.
 */
function choose(entries, rules, mode) {
  const inc = e => rules.include.test(e.id);
  const exc = e => rules.exclude.test(e.id);

  let set = entries.filter(e => inc(e) && !exc(e));
  let tier = 1;
  if (!set.length) { set = entries.filter(inc); tier = 2; }
  if (!set.length) {
    return { tier: 3, ordered: entries.slice(), orderedBy: 'provider', chosen: entries[0] || null };
  }
  const { ordered, orderedBy } = orderCandidates(set, mode);
  return { tier, ordered, orderedBy, chosen: ordered[0] };
}

// ---------------------------------------------------------------------------
// OpenRouter free-tier list (kept separate: it is a Set of ids, not entries)
// ---------------------------------------------------------------------------
async function _openRouterFree(apiKey, { force, timeoutMs, cooldownMs }) {
  if (_cache.openrouter && !force) return { set: _cache.openrouter, live: true };

  if (!force && _failedAt.openrouter && (_now() - _failedAt.openrouter) < cooldownMs) {
    return { set: new Set([DEFAULT_FALLBACKS.openrouter]), live: false, reason: 'cooldown', error: _lastError.openrouter };
  }
  try {
    const ids = await fetchOpenRouterFreeModels(apiKey, timeoutMs);
    _cache.openrouter = new Set(ids);
    _failedAt.openrouter = 0;
    _lastError.openrouter = null;
    return { set: _cache.openrouter, live: true };
  } catch (e) {
    _failedAt.openrouter = _now();
    _lastError.openrouter = e.message;
    // A failed refresh keeps serving the list we already have. Otherwise hand
    // back the fallback WITHOUT caching it: an earlier version cached it for
    // the rest of the process, so one blip pinned OpenRouter to the fallback
    // forever (and reported it as 'live').
    if (_cache.openrouter) return { set: _cache.openrouter, live: true, error: e.message };
    return { set: new Set([DEFAULT_FALLBACKS.openrouter]), live: false, reason: 'fetch-failed', error: e.message };
  }
}

// ---------------------------------------------------------------------------
// The single pipeline behind resolveModel() and inspectModels()
// ---------------------------------------------------------------------------
async function evaluate(provider, apiKey, options) {
  options = options || {};
  const p = String(provider || '').toLowerCase();
  if (!PROVIDERS.includes(p)) {
    throw new Error(`Unknown provider: ${provider}. Expected xai|anthropic|gemini|openrouter`);
  }
  const pinned = options.fallback || DEFAULT_FALLBACKS[p];
  const out = {
    provider: p, id: pinned, source: 'fallback', reason: null,
    orderedBy: null, tier: null, fallback: pinned, error: null, candidates: [],
  };
  if (!apiKey) { out.reason = 'no-key'; return out; }   // offline / test runs: no network at all

  try {
    const force = !!options.forceRefresh;
    const timeoutMs = timeoutFrom(options);
    const cooldownMs = cooldownFrom(options);

    if (p === 'openrouter') {
      // The generic resolve returns the first free model (or the fallback).
      // Callers that want round-robin should use getNextFreeModel().
      const r = await _openRouterFree(apiKey, { force, timeoutMs, cooldownMs });
      const ids = Array.from(r.set);
      if (r.error) out.error = r.error;
      if (r.live && ids.length) {
        out.id = ids[0]; out.source = 'live';
        out.candidates = ids.map((id, i) => ({ id, created: null, generation: null, status: i === 0 ? 'chosen' : 'eligible', rank: i + 1 }));
      } else {
        out.reason = r.live ? 'empty-list' : r.reason;
      }
      return out;
    }

    let entries = _cache[p];
    if (!entries || force) {
      const inCooldown = !force && _failedAt[p] && (_now() - _failedAt[p]) < cooldownMs;
      if (inCooldown) {
        out.reason = 'cooldown'; out.error = _lastError[p];
        return out;
      }
      try {
        entries = await FETCHERS[p](apiKey, timeoutMs);
        _cache[p] = entries;
        _failedAt[p] = 0;
        _lastError[p] = null;
      } catch (err) {
        _failedAt[p] = _now();
        _lastError[p] = err.message;
        out.error = err.message;
        // A failed REFRESH keeps serving the list we already have.
        if (!_cache[p]) { out.reason = 'fetch-failed'; return out; }
        entries = _cache[p];
      }
    }

    const mode = options.order === 'provider' ? 'provider' : 'newest';
    const usable = entries.filter(e => !_knownBad[p].has(e.id));
    const sel = usable.length ? choose(usable, PREFERENCE[p], mode) : null;

    // Candidate table (this is what inspectModels() shows).
    const rules = PREFERENCE[p];
    const rankOf = new Map(sel ? sel.ordered.map((e, i) => [e.id, i + 1]) : []);
    const rows = entries.map(e => {
      let status;
      if (_knownBad[p].has(e.id)) status = 'known-bad';
      else if (sel && sel.chosen && e.id === sel.chosen.id) status = 'chosen';
      else if (!rules.include.test(e.id)) status = 'not-matching';
      else if (rules.exclude.test(e.id)) status = 'excluded';
      else status = 'eligible';
      return {
        id: e.id,
        created: e.created ? new Date(e.created).toISOString() : null,
        generation: e.generation ? e.generation.join('.') : null,
        status,
        rank: rankOf.get(e.id) || null,
      };
    });
    const groupOrder = { chosen: 0, eligible: 1, excluded: 2, 'not-matching': 3, 'known-bad': 4 };
    out.candidates = rows
      .map((r, i) => ({ r, i }))
      .sort((a, b) => (groupOrder[a.r.status] - groupOrder[b.r.status]) || ((a.r.rank || 1e9) - (b.r.rank || 1e9)) || (a.i - b.i))
      .map(x => x.r);

    if (sel && sel.chosen) {
      out.id = sel.chosen.id; out.source = 'live';
      out.orderedBy = sel.orderedBy; out.tier = sel.tier;
    } else {
      out.reason = entries.length ? 'all-known-bad' : 'empty-list';
    }
    return out;
  } catch (err) {
    // Never let an unexpected error kill a batch job.
    out.id = pinned; out.source = 'fallback'; out.reason = 'error'; out.error = err && err.message;
    return out;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolve the best model ID for a provider.
 *
 * @param {'xai'|'anthropic'|'gemini'|'openrouter'} provider
 * @param {string} apiKey
 * @param {object} [options]
 * @param {boolean} [options.forceRefresh=false]  Bypass the cached list (and the fetch cool-down)
 * @param {string}  [options.fallback]            Override the env/default pin for this call
 * @param {'newest'|'provider'} [options.order='newest']  'provider' keeps the provider's own order
 * @param {number}  [options.timeoutMs]           Per-request timeout (default 10000, or LLM_MODEL_RESOLVER_TIMEOUT_MS)
 * @param {number}  [options.cooldownMs]          Pause after a failed fetch (default 60000; 0 disables)
 * @returns {Promise<{ id: string, source: 'live'|'fallback', orderedBy: 'created'|'version'|'provider'|null }>}
 * Throws only for an unknown provider name; every other failure returns the fallback.
 */
async function resolveModel(provider, apiKey, options = {}) {
  const ev = await evaluate(provider, apiKey, options);
  return { id: ev.id, source: ev.source, orderedBy: ev.orderedBy };
}

/**
 * Show WHY a model was chosen: every listed model with its recency signal and
 * status (chosen / eligible / excluded / not-matching / known-bad), which
 * ordering signal was used, and - when the answer is the fallback - the reason
 * ('no-key' | 'fetch-failed' | 'cooldown' | 'empty-list' | 'all-known-bad' |
 * 'error') and the error. Makes a real request unless the list is cached.
 * Same options as resolveModel().
 */
async function inspectModels(provider, apiKey, options = {}) {
  return evaluate(provider, apiKey, options);
}

/**
 * Return the cached (or freshly fetched) Set of OpenRouter free model IDs.
 * Matches the old fetchOrFreeModels() contract. The second argument may be a
 * boolean (forceRefresh, the original signature) or an options object.
 */
async function fetchFreeModels(apiKey, arg) {
  const o = (arg && typeof arg === 'object') ? arg : { forceRefresh: !!arg };
  const r = await _openRouterFree(apiKey, {
    force: !!o.forceRefresh, timeoutMs: timeoutFrom(o), cooldownMs: cooldownFrom(o),
  });
  return r.set;
}

/**
 * Round-robin through currently available OpenRouter free models.
 * Drop-in replacement for the legacy getNextOrModel().
 */
async function getNextFreeModel(apiKey, options = {}) {
  const available = await fetchFreeModels(apiKey, options);
  if (available.size === 0) return DEFAULT_FALLBACKS.openrouter;
  const models = Array.from(available);
  const model = models[_orFreeIdx % models.length];
  _orFreeIdx = (_orFreeIdx + 1) % models.length;
  return model;
}

/**
 * Reset the free-model round-robin index (useful at the start of a batch).
 */
function resetFreeModelIndex() {
  _orFreeIdx = 0;
}

/**
 * Record that a model failed the REAL call (not just resolution) - e.g. a
 * 404/permission error from the provider's generateContent/chat-completions
 * endpoint. Every subsequent resolveModel() call for this provider, in this
 * process, will skip this id and pick the next-best live candidate instead.
 *
 * Only mark a model bad for failures that are ABOUT THE MODEL (404 / 403).
 * Not for 429, 5xx or timeouts: those say nothing about the model, and
 * marking it would sideline a good one for the rest of the process.
 *
 * Typical caller pattern (no separate retry-loop function needed - this is
 * the whole point of folding known-bad awareness into resolveModel itself):
 *
 *   let resolved = await resolveModel('gemini', key, { fallback: PINNED });
 *   try {
 *     return await actuallyCallTheApi(resolved.id);
 *   } catch (e) {
 *     if (e.status !== 404 && e.status !== 403) throw e;
 *     markModelBad('gemini', resolved.id);
 *     resolved = await resolveModel('gemini', key, { fallback: PINNED });
 *     return await actuallyCallTheApi(resolved.id); // now skips the bad one
 *   }
 *
 * Not exposed for 'openrouter' - its free-tier round-robin already moves on
 * from a failing model via getNextFreeModel()'s own retry loop.
 */
function markModelBad(provider, modelId) {
  const p = String(provider || '').toLowerCase();
  if (_knownBad[p] && modelId) _knownBad[p].add(modelId);
}

/**
 * Clear all in-memory state: cached lists, known-bad models, fetch cool-downs
 * (mainly for tests).
 */
function clearCache() {
  for (const p of PROVIDERS) {
    _cache[p] = null;
    _failedAt[p] = 0;
    _lastError[p] = null;
  }
  _knownBad.xai.clear();
  _knownBad.anthropic.clear();
  _knownBad.gemini.clear();
  _orFreeIdx = 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  resolveModel,
  inspectModels,
  fetchFreeModels,
  getNextFreeModel,
  resetFreeModelIndex,
  markModelBad,
  clearCache,
  // exposed for advanced callers / tests
  DEFAULT_FALLBACKS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_COOLDOWN_MS,
  PREFERENCE,
};
