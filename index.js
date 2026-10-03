/**
 * llm-model-resolver
 *
 * Resolve the current model ID for an LLM provider at runtime instead of
 * hard-coding it. Works across xAI, Anthropic, Gemini, and OpenRouter.
 *
 *   resolveModel(provider, apiKey, options?)
 *     → Promise<{ id, source: 'live'|'pinned'|'fallback', orderedBy }>
 *
 * Profiles
 * ────────
 * All preferences live in YAML files under profiles/ inside this package.
 * Edit them in the GitHub repo — they ship with the package so everyone who
 * clones it can change them directly without touching application code.
 *
 * Select a profile:
 *   env:  LLM_MODEL_RESOLVER_PROFILE=economy   (read at require time)
 *   code: require('llm-model-resolver').useProfile('economy')
 *
 * Available profiles: flagship (default), economy
 * Custom files:       loadConfig('/path/to/your-own.yml')
 *
 * @see https://github.com/prakar/llm-model-resolver
 */

'use strict';

const fs   = require('fs');
const path = require('path');

const PROVIDERS = ['xai', 'anthropic', 'gemini', 'openrouter'];

// ---------------------------------------------------------------------------
// Built-in defaults = the "flagship" profile.
// Every field here is overridable from the config file.
// ---------------------------------------------------------------------------
const _BUILT_IN = {
  timeoutMs:  10_000,
  cooldownMs: 60_000,
  order:      'newest',   // 'newest' | 'oldest' | 'provider'
  providers: {
    xai: {
      pin:      null,
      include:  /^grok-/i,
      // non-?reasoning: xAI ships paired grok-…-reasoning / grok-…-non-reasoning.
      // Excluding bare /reasoning/ would remove BOTH (non-reasoning contains the
      // substring). This pattern skips ONLY the non-reasoning variant.
      // image|imagine|video: non-chat models that appear in /v1/models.
      exclude:  /fast|mini|lite|code-fast|non-?reasoning|image|imagine|video/i,
      fallback: process.env.XAI_MODEL_FALLBACK || process.env.GROK_MODEL_FALLBACK || 'grok-4',
    },
    anthropic: {
      pin:      null,
      include:  /^claude-/i,
      exclude:  /haiku|instant|mini/i,
      fallback: process.env.ANTHROPIC_MODEL_FALLBACK || 'claude-sonnet-5',
    },
    gemini: {
      pin:      null,
      include:  /gemini-/i,
      // image|audio: some pro-named models advertise generateContent but produce
      // image/audio output — exclude by name even though the capability filter
      // already drops the obvious families (imagen, veo, tts, live).
      exclude:  /flash|lite|embedding|aqa|imagen|veo|tts|live|image|audio/i,
      fallback: process.env.GEMINI_MODEL_FALLBACK || 'gemini-flash-latest',
    },
    openrouter: {
      pin:      null,
      include:  null,
      exclude:  null,
      fallback: process.env.OPENROUTER_MODEL_FALLBACK || process.env.OPENROUTER_FREE_FALLBACK || 'openrouter/free',
    },
  },
};

// ---------------------------------------------------------------------------
// Active configuration (replaced by configure() / loadConfig())
// ---------------------------------------------------------------------------
let _cfg = _BUILT_IN;

function _toRegex(v) {
  if (!v)               return null;
  if (v instanceof RegExp) return v;
  return new RegExp(String(v), 'i');
}

function _positive(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * Apply a configuration object.
 * Missing fields keep the built-in default. Clears the model-list cache.
 */
function configure(raw) {
  const g    = (raw && raw.global)    || {};
  const prov = (raw && raw.providers) || {};

  const merged = {
    timeoutMs:  _positive(g.timeoutMs)  || _BUILT_IN.timeoutMs,
    cooldownMs: _positive(g.cooldownMs) || _BUILT_IN.cooldownMs,
    order:      ['newest','oldest','cheapest','provider'].includes(g.order) ? g.order : _BUILT_IN.order,
    providers:  {},
  };

  for (const p of PROVIDERS) {
    const built = _BUILT_IN.providers[p];
    const over  = prov[p] || {};
    merged.providers[p] = {
      pin:      over.pin      != null ? String(over.pin) : built.pin,
      include:  _toRegex(over.include) || built.include,
      exclude:  _toRegex(over.exclude) || built.exclude,
      fallback: over.fallback != null ? String(over.fallback) : built.fallback,
    };
  }

  _cfg = merged;
  clearCache();
}

/**
 * Load a YAML (.yml / .yaml) or JSON (.json) config file and apply it.
 * YAML requires js-yaml: npm install js-yaml
 * Call once at startup before the first resolveModel() call.
 */
function loadConfig(filePath) {
  if (!filePath) throw new Error('loadConfig: filePath is required');
  const abs  = path.resolve(filePath);
  const text = fs.readFileSync(abs, 'utf8');
  let raw;
  if (abs.endsWith('.json')) {
    raw = JSON.parse(text);
  } else {
    let jsyaml;
    try   { jsyaml = require('js-yaml'); }
    catch (_) { throw new Error('loadConfig: YAML files need js-yaml — run: npm install js-yaml'); }
    raw = jsyaml.load(text);
  }
  configure(raw);
  return raw;
}

/** List of profile names bundled with this package. */
const PROFILES_DIR     = path.join(__dirname, 'profiles');
const AVAILABLE_PROFILES = ['flagship', 'economy'];

/**
 * Load a bundled profile from the profiles/ directory.
 * Edit profiles/economy.yml or profiles/flagship.yml in the GitHub repo to
 * customise the profile — changes ship with the package to everyone who clones it.
 * @param {'flagship'|'economy'} name
 */
function useProfile(name) {
  if (!AVAILABLE_PROFILES.includes(name))
    throw new Error(`useProfile: unknown profile "${name}". Available: ${AVAILABLE_PROFILES.join(', ')}`);
  // Profiles are loaded from the bundled .js representation (no YAML dep needed at runtime).
  // The .yml files in profiles/ are the canonical human-editable form in the repo.
  // After editing a .yml, run `npm run build-profiles` to regenerate the .js files.
  const raw = require(path.join(PROFILES_DIR, name + '.js'));
  configure(raw);
  return raw;
}

/** Return the effective rules for a provider (reflects the active config). */
function effectiveConfig(provider) {
  const p = String(provider || '').toLowerCase();
  return (_cfg.providers && _cfg.providers[p]) || _BUILT_IN.providers[p] || {};
}

// ---------------------------------------------------------------------------
// In-memory caches (process lifetime)
// ---------------------------------------------------------------------------
const _cache    = { xai: null, anthropic: null, gemini: null, openrouter: null };
let   _orFreeIdx = 0;
const _failedAt  = { xai: 0, anthropic: 0, gemini: 0, openrouter: 0 };
const _lastError = { xai: null, anthropic: null, gemini: null, openrouter: null };
const _now       = () => Date.now();

// Known-bad models: in-memory only (see README — this is intentional).
const _knownBad = { xai: new Set(), anthropic: new Set(), gemini: new Set() };

// ---------------------------------------------------------------------------
// Fetch helper
// ---------------------------------------------------------------------------
async function httpGet(url, headers, timeoutMs) {
  const tms = timeoutMs || _cfg.timeoutMs;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json', ...(headers || {}) },
      signal: AbortSignal.timeout(tms),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}: ${body.slice(0, 200)}`);
    }
    return await res.json();
  } catch (e) {
    if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) {
      const host = (() => { try { return new URL(url).host; } catch(_){return 'provider';} })();
      throw new Error(`Timed out after ${tms}ms waiting for ${host}`);
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Per-provider fetchers → [{ id, created, generation }]
// ---------------------------------------------------------------------------
function toMs(v) {
  let n;
  if (typeof v === 'string') n = /^\d+$/.test(v.trim()) ? Number(v) : Date.parse(v);
  else n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n < 1e11 ? n * 1000 : n;
}

function geminiGen(id) {
  const m = /^gemini-(\d+(?:\.\d+)*)/i.exec(id);
  return m ? m[1].split('.').map(Number) : null;
}

async function fetchXaiModels(apiKey, timeoutMs) {
  const headers  = { Authorization: `Bearer ${apiKey}` };
  // prompt_text_token_price is in 100-picodollar units per token.
  // Dividing by 1e4 gives USD per million tokens input, matching the prices you see on
  // xAI's pricing page. The economy profile uses this to pick the cheapest eligible model.
  const xaiPrice = m => (typeof m.prompt_text_token_price === 'number') ? m.prompt_text_token_price / 1e4 : null;
  const toEntry  = m => { const id = m && (m.id || m.name); return id ? { id, created: toMs(m.created), generation: null, priceIn: xaiPrice(m) } : null; };
  try {
    const json    = await httpGet('https://api.x.ai/v1/language-models', headers, timeoutMs);
    const entries = (json.models || json.data || []).map(toEntry).filter(Boolean);
    if (entries.length) return entries;
  } catch (_) {}
  const json = await httpGet('https://api.x.ai/v1/models', headers, timeoutMs);
  return (json.data || json.models || []).map(toEntry).filter(Boolean);
}

async function fetchAnthropicModels(apiKey, timeoutMs) {
  const json = await httpGet('https://api.anthropic.com/v1/models?limit=1000',
    { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' }, timeoutMs);
  return (json.data || []).filter(m => m && m.id)
    .map(m => ({ id: m.id, created: toMs(m.created_at), generation: null }));
}

async function fetchGeminiModels(apiKey, timeoutMs) {
  const url  = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}&pageSize=1000`;
  const json = await httpGet(url, {}, timeoutMs);
  return (json.models || [])
    .filter(m => (m.supportedGenerationMethods || m.supported_actions || []).some(x => /generateContent/i.test(x)))
    .map(m => { const name = m.name || ''; const id = name.startsWith('models/') ? name.slice(7) : name; return { id, created: null, generation: geminiGen(id) }; })
    .filter(e => e.id);
}

async function fetchOpenRouterFreeModels(apiKey, timeoutMs) {
  const json   = await httpGet('https://openrouter.ai/api/v1/models', { Authorization: `Bearer ${apiKey}` }, timeoutMs);
  const isZero = v => v === 0 || v === '0' || v === '0.0' || v === '0.00';
  return (json.data || []).filter(m => m.pricing && isZero(m.pricing.prompt) && isZero(m.pricing.completion)).map(m => m.id).filter(Boolean);
}

const FETCHERS = { xai: fetchXaiModels, anthropic: fetchAnthropicModels, gemini: fetchGeminiModels };

// ---------------------------------------------------------------------------
// Ordering + selection
// ---------------------------------------------------------------------------
function cmpVer(a, b) {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) { const d = (a[i]||0) - (b[i]||0); if (d) return d; }
  return 0;
}

function orderCandidates(entries, mode) {
  // 'cheapest': sort by priceIn ascending; models with no price data sort last.
  // This uses the actual API-reported price, not a name heuristic, so a new expensive
  // model that doesn't say "reasoning" in its name is still ranked correctly.
  if (mode === 'cheapest') {
    const has = entries.some(e => e.priceIn != null);
    if (!has) return { ordered: entries.slice(), orderedBy: 'provider' };
    const decorated = entries.map((e, i) => ({ e, i }));
    decorated.sort((a, b) => {
      const pa = a.e.priceIn, pb = b.e.priceIn;
      if (pa == null && pb == null) return a.i - b.i;
      if (pa == null) return  1;
      if (pb == null) return -1;
      return (pa - pb) || a.i - b.i;
    });
    return { ordered: decorated.map(x => x.e), orderedBy: 'cheapest' };
  }
  let signal = 'provider';
  if (mode !== 'provider') {
    if      (entries.some(e => e.created    != null)) signal = 'created';
    else if (entries.some(e => e.generation        )) signal = 'version';
  }
  if (signal === 'provider') return { ordered: entries.slice(), orderedBy: 'provider' };
  const desc    = (mode !== 'oldest');
  const keyOf   = e => signal === 'created' ? e.created : e.generation;
  const decorated = entries.map((e, i) => ({ e, i }));
  decorated.sort((a, b) => {
    const ka = keyOf(a.e), kb = keyOf(b.e);
    if (ka == null && kb == null) return a.i - b.i;
    if (ka == null) return  1;
    if (kb == null) return -1;
    const d = signal === 'created'
      ? (desc ? kb - ka : ka - kb)
      : (desc ? cmpVer(kb, ka) : cmpVer(ka, kb));
    return d || a.i - b.i;
  });
  return { ordered: decorated.map(x => x.e), orderedBy: signal };
}

function choose(entries, rules, mode) {
  const inc = e => !rules.include || rules.include.test(e.id);
  const exc = e =>  rules.exclude &&  rules.exclude.test(e.id);
  let set = entries.filter(e => inc(e) && !exc(e)); let tier = 1;
  if (!set.length) { set = entries.filter(inc); tier = 2; }
  if (!set.length) return { tier: 3, ordered: entries.slice(), orderedBy: 'provider', chosen: entries[0] || null };
  const { ordered, orderedBy } = orderCandidates(set, mode);
  return { tier, ordered, orderedBy, chosen: ordered[0] };
}

// ---------------------------------------------------------------------------
// OpenRouter free pool
// ---------------------------------------------------------------------------
async function _openRouterFree(apiKey, { force, timeoutMs, cooldownMs }) {
  if (_cache.openrouter && !force) return { set: _cache.openrouter, live: true };
  const fb = effectiveConfig('openrouter').fallback;
  if (!force && _failedAt.openrouter && (_now() - _failedAt.openrouter) < cooldownMs)
    return { set: new Set([fb]), live: false, reason: 'cooldown', error: _lastError.openrouter };
  try {
    const ids = await fetchOpenRouterFreeModels(apiKey, timeoutMs);
    _cache.openrouter = new Set(ids); _failedAt.openrouter = 0; _lastError.openrouter = null;
    return { set: _cache.openrouter, live: true };
  } catch (e) {
    _failedAt.openrouter = _now(); _lastError.openrouter = e.message;
    if (_cache.openrouter) return { set: _cache.openrouter, live: true, error: e.message };
    return { set: new Set([fb]), live: false, reason: 'fetch-failed', error: e.message };
  }
}

// ---------------------------------------------------------------------------
// Core pipeline
// ---------------------------------------------------------------------------
const _GRP = { chosen: 0, eligible: 1, excluded: 2, 'not-matching': 3, 'known-bad': 4 };

async function evaluate(provider, apiKey, options) {
  options     = options || {};
  const p     = String(provider || '').toLowerCase();
  if (!PROVIDERS.includes(p)) throw new Error(`Unknown provider: ${provider}. Expected xai|anthropic|gemini|openrouter`);

  const pc     = effectiveConfig(p);
  const pinned = options.fallback || pc.fallback;
  const out    = { provider: p, id: pinned, source: 'fallback', reason: null, orderedBy: null, tier: null, fallback: pinned, error: null, candidates: [] };

  // A pin in the config skips the live list entirely (unless caller passes forceRefresh to override it).
  if (pc.pin && !options.forceRefresh) {
    out.id = pc.pin; out.source = 'pinned'; return out;
  }

  if (!apiKey) { out.reason = 'no-key'; return out; }

  try {
    const force      = !!options.forceRefresh;
    const timeoutMs  = _positive(options.timeoutMs) || _positive(process.env.LLM_MODEL_RESOLVER_TIMEOUT_MS) || _cfg.timeoutMs;
    const cooldownMs = (Number.isFinite(Number(options.cooldownMs)) && Number(options.cooldownMs) >= 0) ? Number(options.cooldownMs) : _cfg.cooldownMs;

    if (p === 'openrouter') {
      const r   = await _openRouterFree(apiKey, { force, timeoutMs, cooldownMs });
      const ids = Array.from(r.set);
      if (r.error) out.error = r.error;
      if (r.live && ids.length) {
        out.id = ids[0]; out.source = 'live';
        out.candidates = ids.map((id, i) => ({ id, created: null, generation: null, status: i === 0 ? 'chosen' : 'eligible', rank: i + 1 }));
      } else { out.reason = r.live ? 'empty-list' : r.reason; }
      return out;
    }

    let entries = _cache[p];
    if (!entries || force) {
      const inCooldown = !force && _failedAt[p] && (_now() - _failedAt[p]) < cooldownMs;
      if (inCooldown) { out.reason = 'cooldown'; out.error = _lastError[p]; return out; }
      try {
        entries = await FETCHERS[p](apiKey, timeoutMs);
        _cache[p] = entries; _failedAt[p] = 0; _lastError[p] = null;
      } catch (err) {
        _failedAt[p] = _now(); _lastError[p] = err.message; out.error = err.message;
        if (!_cache[p]) { out.reason = 'fetch-failed'; return out; }
        entries = _cache[p];
      }
    }

    const mode   = options.order || _cfg.order;
    const rules  = { include: pc.include, exclude: pc.exclude };
    const usable = entries.filter(e => !_knownBad[p]?.has(e.id));
    const sel    = usable.length ? choose(usable, rules, mode) : null;

    const rankOf = new Map(sel ? sel.ordered.map((e, i) => [e.id, i + 1]) : []);
    out.candidates = entries.map(e => {
      let status;
      if (_knownBad[p]?.has(e.id))                           status = 'known-bad';
      else if (sel?.chosen?.id === e.id)                      status = 'chosen';
      else if (rules.include && !rules.include.test(e.id))    status = 'not-matching';
      else if (rules.exclude &&  rules.exclude.test(e.id))    status = 'excluded';
      else                                                     status = 'eligible';
      return { id: e.id, created: e.created ? new Date(e.created).toISOString() : null, generation: e.generation?.join('.') || null, priceIn: e.priceIn ?? null, status, rank: rankOf.get(e.id) || null };
    }).sort((a, b) => (_GRP[a.status] - _GRP[b.status]) || ((a.rank||1e9) - (b.rank||1e9)));

    if (sel?.chosen) {
      out.id = sel.chosen.id; out.source = 'live'; out.orderedBy = sel.orderedBy; out.tier = sel.tier;
    } else {
      out.reason = entries.length ? 'all-known-bad' : 'empty-list';
    }
    return out;
  } catch (err) {
    out.source = 'fallback'; out.reason = 'error'; out.error = err?.message; return out;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
async function resolveModel(provider, apiKey, options = {}) {
  const ev = await evaluate(provider, apiKey, options);
  return { id: ev.id, source: ev.source, orderedBy: ev.orderedBy };
}
async function inspectModels(provider, apiKey, options = {}) { return evaluate(provider, apiKey, options); }

async function fetchFreeModels(apiKey, arg) {
  const o = (arg && typeof arg === 'object') ? arg : { forceRefresh: !!arg };
  return (await _openRouterFree(apiKey, { force: !!o.forceRefresh, timeoutMs: _positive(o.timeoutMs)||_cfg.timeoutMs, cooldownMs: _cfg.cooldownMs })).set;
}

async function getNextFreeModel(apiKey, options = {}) {
  const available = await fetchFreeModels(apiKey, options);
  if (available.size === 0) return effectiveConfig('openrouter').fallback;
  const models = Array.from(available);
  const model  = models[_orFreeIdx % models.length];
  _orFreeIdx   = (_orFreeIdx + 1) % models.length;
  return model;
}

function resetFreeModelIndex() { _orFreeIdx = 0; }

function markModelBad(provider, modelId) {
  const p = String(provider || '').toLowerCase();
  if (_knownBad[p] && modelId) _knownBad[p].add(modelId);
}

function clearCache() {
  for (const p of PROVIDERS) { _cache[p] = null; _failedAt[p] = 0; _lastError[p] = null; }
  _knownBad.xai?.clear(); _knownBad.anthropic?.clear(); _knownBad.gemini?.clear();
  _orFreeIdx = 0;
}

// ---------------------------------------------------------------------------
// Auto-load: read profiles/settings.yml at require time (no extra dependencies).
// The flagship_performance field controls which profile is active.
// Override with LLM_MODEL_RESOLVER_PROFILE env var or useProfile() in code.
// ---------------------------------------------------------------------------
(function() {
  // Priority: useProfile() call > LLM_MODEL_RESOLVER_PROFILE env var > settings.yml
  const envProf = process.env.LLM_MODEL_RESOLVER_PROFILE;
  if (envProf) {
    try { useProfile(envProf); return; }
    catch (e) { process.emitWarning('llm-model-resolver: ' + e.message + ' — falling back to settings.yml'); }
  }
  try {
    const settingsPath = path.join(PROFILES_DIR, 'settings.yml');
    const text = fs.readFileSync(settingsPath, 'utf8');
    // Inline parse for the single known field — no js-yaml dependency at startup.
    const m = /^\s*flagship_performance\s*:\s*(yes|no|true|false)/mi.exec(text);
    const flagship = m ? (m[1] === 'yes' || m[1] === 'true') : false;
    useProfile(flagship ? 'flagship' : 'economy');
  } catch (e) {
    // If settings.yml is missing or unreadable, flagship defaults are already active.
    process.emitWarning('llm-model-resolver: could not read profiles/settings.yml (' + e.message + ') — using flagship defaults');
  }
})();

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  resolveModel, inspectModels,
  configure, loadConfig, useProfile, effectiveConfig,
  AVAILABLE_PROFILES,
  fetchFreeModels, getNextFreeModel, resetFreeModelIndex,
  markModelBad, clearCache,
  // These are live getters into the active config so they always reflect configure()
  get DEFAULT_FALLBACKS() { return Object.fromEntries(PROVIDERS.map(p => [p, effectiveConfig(p).fallback])); },
  get DEFAULT_TIMEOUT_MS()  { return _cfg.timeoutMs; },
  get DEFAULT_COOLDOWN_MS() { return _cfg.cooldownMs; },
  get PREFERENCE()          { return Object.fromEntries(PROVIDERS.filter(p=>p!=='openrouter').map(p=>[p,{include:effectiveConfig(p).include,exclude:effectiveConfig(p).exclude}])); },
};
