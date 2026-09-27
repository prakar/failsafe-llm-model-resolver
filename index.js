/**
 * failsafe-llm-model-resolver
 *
 * Self-healing, failsafe resolver for the current frontier model across
 * xAI, Anthropic, Gemini, and OpenRouter.
 *
 *   resolveModel(provider, apiKey, options?) → Promise<{ id, source: 'live'|'fallback' }>
 *
 * Design goals
 * ────────────
 * • Live fetch from each provider’s native /models endpoint
 * • Preference rules:
 *     – paid providers: regex + “newest first, skip fast/mini/lite/haiku”
 *     – OpenRouter free: filter pricing.prompt/completion === '0', then round-robin
 * • In-memory cache per process
 * • Env-configurable pinned fallbacks so a transient network blip never kills a batch job
 *
 * @see https://github.com/prakar/failsafe-llm-model-resolver
 */

'use strict';

// ---------------------------------------------------------------------------
// In-memory caches (process lifetime)
// ---------------------------------------------------------------------------
const _cache = {
  xai: null,
  anthropic: null,
  gemini: null,
  openrouter: null,       // full free-model Set
};
let _orFreeIdx = 0;       // round-robin index for OpenRouter free models

// ---------------------------------------------------------------------------
// Defaults / env fallbacks
// ---------------------------------------------------------------------------
const DEFAULT_FALLBACKS = {
  xai:        process.env.XAI_MODEL_FALLBACK        || process.env.GROK_MODEL_FALLBACK        || 'grok-4',
  anthropic:  process.env.ANTHROPIC_MODEL_FALLBACK  || 'claude-sonnet-4-20250514',
  gemini:     process.env.GEMINI_MODEL_FALLBACK     || 'gemini-2.5-pro',
  openrouter: process.env.OPENROUTER_MODEL_FALLBACK || process.env.OPENROUTER_FREE_FALLBACK || 'openrouter/free',
};

// Preference patterns for paid providers (applied after newest-first ordering)
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
    exclude: /fast|mini|lite|code-fast|non-?reasoning/i,
  },
  // Prefer sonnet/opus over haiku; newest first already gives us the latest
  anthropic: {
    include: /^claude-/i,
    exclude: /haiku|instant|mini/i,
  },
  // Prefer pro / non-flash / non-lite when available
  gemini: {
    include: /gemini-/i,
    exclude: /flash|lite|embedding|aqa|imagen|veo|tts|live/i,
  },
};

// ---------------------------------------------------------------------------
// Tiny fetch helper (native fetch, Node 18+)
// ---------------------------------------------------------------------------
async function httpGet(url, headers = {}) {
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      ...headers,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------------------
// Per-provider fetch + normalize → string[] of usable model IDs (newest first)
// ---------------------------------------------------------------------------
async function fetchXaiModels(apiKey) {
  const json = await httpGet('https://api.x.ai/v1/models', {
    Authorization: `Bearer ${apiKey}`,
  });
  // OpenAI-compatible shape: { data: [ { id, ... } ] }
  const list = (json.data || json.models || []).map(m => m.id || m.name).filter(Boolean);
  return list;
}

async function fetchAnthropicModels(apiKey) {
  const json = await httpGet('https://api.anthropic.com/v1/models', {
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  });
  // Newest-first by design. Shape: { data: [ { id, display_name, created_at } ] }
  const list = (json.data || []).map(m => m.id).filter(Boolean);
  return list;
}

async function fetchGeminiModels(apiKey) {
  // Gemini uses query-string key and a different envelope
  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
  const json = await httpGet(url);
  // Shape: { models: [ { name: "models/gemini-…", supportedGenerationMethods: [...], … } ] }
  //
  // BUGFIX (was throwing ReferenceError on every real call): the previous
  // version called .filter() AFTER .map() had already reduced each model
  // object down to a bare id string - by the time the filter ran, the only
  // thing it had to inspect was `id` (a string), yet it tried to read
  // `m.supportedGenerationMethods` on a variable `m` that was never in scope
  // in that callback. This wasn't just a typo to rename; the whole ordering
  // was backwards. The fix: filter on the full model object FIRST (while
  // supportedGenerationMethods is still available), THEN map down to the id
  // string. No IIFE, no scope trick needed - the property we need is simply
  // read before it's thrown away.
  const list = (json.models || [])
    .filter(m => {
      const methods = m.supportedGenerationMethods || m.supported_actions || [];
      return methods.some(x => /generateContent/i.test(x));
    })
    .map(m => {
      const name = m.name || '';
      // The ID used in generateContent is the part after "models/"
      return name.startsWith('models/') ? name.slice(7) : name;
    })
    .filter(Boolean);
  return list;
}

async function fetchOpenRouterFreeModels(apiKey) {
  const json = await httpGet('https://openrouter.ai/api/v1/models', {
    Authorization: `Bearer ${apiKey}`,
  });
  // Free = pricing.prompt === "0" && pricing.completion === "0" (string or number)
  const isZero = v => v === 0 || v === '0' || v === '0.0' || v === '0.00';
  const free = (json.data || [])
    .filter(m => m.pricing && isZero(m.pricing.prompt) && isZero(m.pricing.completion))
    .map(m => m.id)
    .filter(Boolean);
  return free;
}

// ---------------------------------------------------------------------------
// Preference selector (paid providers)
// ---------------------------------------------------------------------------
function pickPreferred(ids, rules) {
  if (!ids || ids.length === 0) return null;

  // 1. Prefer models that match include and do NOT match exclude
  const preferred = ids.filter(id =>
    rules.include.test(id) && !rules.exclude.test(id)
  );
  if (preferred.length) return preferred[0];

  // 2. Fall back to any that match include (even if they hit exclude)
  const anyInclude = ids.filter(id => rules.include.test(id));
  if (anyInclude.length) return anyInclude[0];

  // 3. Absolute last resort: first ID in the list
  return ids[0];
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
 * @param {boolean} [options.forceRefresh=false]  Bypass cache
 * @param {string}  [options.fallback]            Override env fallback for this call
 * @returns {Promise<{ id: string, source: 'live'|'fallback' }>}
 */
async function resolveModel(provider, apiKey, options = {}) {
  const p = String(provider || '').toLowerCase();
  if (!['xai', 'anthropic', 'gemini', 'openrouter'].includes(p)) {
    throw new Error(`Unknown provider: ${provider}. Expected xai|anthropic|gemini|openrouter`);
  }
  if (!apiKey) {
    // No key → immediate fallback (still useful for offline / test runs)
    return { id: options.fallback || DEFAULT_FALLBACKS[p], source: 'fallback' };
  }

  const force = !!options.forceRefresh;
  const pinned = options.fallback || DEFAULT_FALLBACKS[p];

  try {
    let id;

    if (p === 'openrouter') {
      // For the generic resolve we return the first free model (or the fallback).
      // Callers that want round-robin should use getNextFreeModel().
      const free = await _getOpenRouterFreeSet(apiKey, force);
      id = free.size ? Array.from(free)[0] : null;
    } else {
      let list = _cache[p];
      if (!list || force) {
        if (p === 'xai')        list = await fetchXaiModels(apiKey);
        if (p === 'anthropic')  list = await fetchAnthropicModels(apiKey);
        if (p === 'gemini')     list = await fetchGeminiModels(apiKey);
        _cache[p] = list;
      }
      id = pickPreferred(list, PREFERENCE[p]);
    }

    if (id) return { id, source: 'live' };
    return { id: pinned, source: 'fallback' };
  } catch (err) {
    // Never let a transient network error kill a batch job
    return { id: pinned, source: 'fallback' };
  }
}

/**
 * Return the cached (or freshly fetched) Set of OpenRouter free model IDs.
 * Matches the old fetchOrFreeModels() contract.
 */
async function fetchFreeModels(apiKey, forceRefresh = false) {
  return _getOpenRouterFreeSet(apiKey, forceRefresh);
}

async function _getOpenRouterFreeSet(apiKey, force = false) {
  if (_cache.openrouter && !force) return _cache.openrouter;
  try {
    const ids = await fetchOpenRouterFreeModels(apiKey);
    _cache.openrouter = new Set(ids);
    return _cache.openrouter;
  } catch (e) {
    // Preserve previous cache if any; otherwise seed with the hard-coded fallback
    if (!_cache.openrouter) {
      _cache.openrouter = new Set([DEFAULT_FALLBACKS.openrouter]);
    }
    return _cache.openrouter;
  }
}

/**
 * Round-robin through currently available OpenRouter free models.
 * Drop-in replacement for the legacy getNextOrModel().
 */
async function getNextFreeModel(apiKey) {
  const available = await _getOpenRouterFreeSet(apiKey);
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
 * Clear all in-memory caches (mainly for tests).
 */
function clearCache() {
  _cache.xai = null;
  _cache.anthropic = null;
  _cache.gemini = null;
  _cache.openrouter = null;
  _orFreeIdx = 0;
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  resolveModel,
  fetchFreeModels,
  getNextFreeModel,
  resetFreeModelIndex,
  clearCache,
  // exposed for advanced callers / tests
  DEFAULT_FALLBACKS,
  PREFERENCE,
};
