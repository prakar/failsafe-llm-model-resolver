# llm-model-resolver

**Resolve the current model ID for an LLM provider at runtime, instead of hard-coding it.**

```js
const { resolveModel } = require('llm-model-resolver');
// profile selected by env var — no code change needed to switch models
const { id, source } = await resolveModel('xai', process.env.XAI_API_KEY);
// → { id: 'grok-4-fast', source: 'live', orderedBy: 'created' }
```

> Formerly published as `failsafe-llm-model-resolver`.

---

## Profiles — the only thing you need to change

All preferences (include/exclude patterns, fallbacks, pins, timeouts) live in YAML files
inside this package under `profiles/`. Edit them in the GitHub repo and they stay
with the package — everyone who clones it gets the updated behaviour without changing
any application code.

Two profiles ship in the box:

| Profile | What it picks | Good for |
|---------|---------------|----------|
| `flagship` | Newest, most capable model | Complex reasoning, quality-critical work |
| `economy`  | Fastest, cheapest model    | Batch work, classification, tagging |

**One field in one text file controls everything — edit it in GitHub:**

```yaml
# profiles/settings.yml  (inside the package)
flagship_performance: no    # change to 'yes' for the most capable models
```

That's the only change needed. No env vars, no code changes. The package reads
`settings.yml` automatically at startup, every time it's required.

The env var `LLM_MODEL_RESOLVER_PROFILE` and `useProfile()` still work as
per-process overrides when you need them (CI, testing), but for normal use
`settings.yml` is all you need.

Without `settings.yml` the flagship defaults are used.

**To customise a profile: edit its YAML in the repo.**
`profiles/economy.yml` and `profiles/flagship.yml` are the canonical source.
After editing, run `npm run build-profiles` to regenerate the `.js` counterparts
that the package loads at runtime (zero extra dependencies).

---

## What a profile controls

The full structure (all fields optional):

```yaml
global:
  timeoutMs:  10000    # per-request network timeout (ms). Default 10000.
                       # Override per-call with resolveModel(…, { timeoutMs: N })
  cooldownMs: 60000    # after a failed /models fetch, wait this long before retrying
  order:      newest   # 'newest' | 'oldest' | 'provider'
                       # newest: pick the model with the latest release date
                       # oldest: pick the oldest in the eligible set
                       # provider: keep the provider's own list order (no sorting)

providers:
  xai:
    pin:      "grok-4.3"     # ALWAYS return this; skip the live list entirely.
                             # Remove or comment out to let the live list decide.
    include:  "^grok-"       # regex (case-insensitive string); only matching IDs are eligible
    exclude:  "reasoning|fast|image|video"   # regex; matching IDs are skipped
    fallback: "grok-4"       # used ONLY when live resolution fails

  anthropic:
    pin:      null           # null = no pin; live list is used
    include:  "^claude-"
    exclude:  "haiku|instant|mini"
    fallback: "claude-sonnet-5"

  gemini:
    include:  "gemini-"
    exclude:  "flash|lite|embedding|aqa|imagen|veo|tts|live|image|audio"
    fallback: "gemini-flash-latest"

  openrouter:             # OpenRouter only uses fallback (see OpenRouter section below)
    fallback: "openrouter/free"
```

### The include / exclude patterns

These are **case-insensitive regex strings** compiled to `new RegExp(pattern, 'i')`. Standard regex syntax, no special escaping needed for common characters. A few patterns worth knowing:

```yaml
# Skip all fast/mini/cheap tiers (flagship profile)
exclude: "fast|mini|lite|haiku|instant|code-fast"

# Skip reasoning models by name
# (careful: "non-reasoning" contains the word "reasoning" — use the form below)
exclude: "(?:^|[.-])reasoning"      # matches "grok-4.7-reasoning" but NOT "non-reasoning"
exclude: "non-?reasoning"           # matches "non-reasoning" and "nonreasoning" only

# Skip image / video / audio models that appear in the chat model list
exclude: "image|imagine|video|audio|tts|veo|tts|live"
```

The resolver relaxes rules rather than returning nothing. If every model is excluded, it falls through to tier 2 (include only, ignore exclude), then tier 3 (first in list). You always get something unless the list is empty.

### Pin vs fallback

| Field | When used | Live list? |
|-------|-----------|-----------|
| `pin` | Always (unless `forceRefresh: true`) | No — returns immediately |
| `fallback` | Only when the live list fails or is unusable | — |

Use `pin` when you need **deterministic, cost-controlled behaviour** and don't want surprises from the resolver picking a newer (more expensive) model. Use `fallback` as your safety net for when the network is down.

---

## Economy profile (`config.economy.yml`)

For batch classification, tagging, and structured extraction — the use case where reasoning models add latency and cost without quality gains:

```yaml
# Prices as of 2026-09-28
# grok-4-fast:    $0.20/$0.50 per M tokens
# grok-4.1-fast:  $0.20/$0.50 per M tokens
# grok-4.3:       $1.25/$2.50 per M tokens  ← quality/cost sweet spot
# grok-4.7:       $2.00/$6.00 per M tokens  ← flagship reasoning, skip

global:
  timeoutMs:  300000
  cooldownMs: 60000
  order:      newest

providers:
  xai:
    include:  "^grok-"
    exclude:  "(?:^|[.-])reasoning|non-?reasoning|image|imagine|video|code-fast"
    # Pin to a specific model for cost predictability:
    # pin: "grok-4.3"        # $1.25/$2.50 — balanced
    # pin: "grok-4-fast"     # $0.20/$0.50 — cheapest
    fallback: "grok-4.3"

  anthropic:
    include:  "^claude-"
    exclude:  "instant|mini"    # haiku IS included (the flagship profile excludes it)
    fallback: "claude-haiku-4-5"

  gemini:
    include:  "gemini-"
    exclude:  "lite|embedding|aqa|imagen|veo|tts|live|image|audio"   # flash IS included
    fallback: "gemini-flash-latest"

  openrouter:
    fallback: "openrouter/free"
```

Known fast / cheap models as of September 2026:

| Provider | Model | Input $/M | Output $/M | Notes |
|----------|-------|-----------|------------|-------|
| xAI | `grok-4-fast` | $0.20 | $0.50 | 2M context, fast |
| xAI | `grok-4.1-fast` | $0.20 | $0.50 | slightly newer fast variant |
| xAI | `grok-4.3` | $1.25 | $2.50 | quality/cost sweet spot |
| xAI | `grok-3-mini` | $0.25 | $0.50 | older, 128K context |
| Anthropic | `claude-haiku-4-5` | $1.00 | $5.00 | Anthropic fast tier |
| Anthropic | `claude-3-haiku-20240307` | $0.25 | $1.25 | cheapest Claude |
| Gemini | `gemini-flash-latest` | $0.075 | $0.30 | cheapest Gemini |
| Gemini | `gemini-2.5-flash` | $0.075 | $0.30 | specific flash version |

---

## Flagship profile (`config.flagship.yml`)

For the highest quality on complex tasks — reasoning models, no fast/cheap tiers:

```yaml
global:
  timeoutMs:  600000   # 10 minutes — reasoning models can be slow
  cooldownMs: 60000
  order:      newest

providers:
  xai:
    include:  "^grok-"
    exclude:  "non-?reasoning|fast|mini|lite|code-fast|image|imagine|video"
    fallback: "grok-4"

  anthropic:
    include:  "^claude-"
    exclude:  "haiku|instant|mini"
    fallback: "claude-sonnet-5"

  gemini:
    include:  "gemini-"
    exclude:  "flash|lite|embedding|aqa|imagen|veo|tts|live|image|audio"
    fallback: "gemini-flash-latest"

  openrouter:
    fallback: "openrouter/free"
```

---

## Install

```bash
npm install llm-model-resolver
# To load custom YAML files with loadConfig() (the bundled profiles need no extra dep):
npm install js-yaml
```

---

## How a model is chosen

1. If the config has a `pin` for this provider, return it immediately. No network call.
2. Fetch the provider's live `/models` list (cached in memory for the process lifetime).
3. Drop models reported with `markModelBad()`.
4. Apply `include` and `exclude`. Relax in two steps rather than returning nothing:
   - tier 1: matches include AND does NOT match exclude
   - tier 2: matches include only (exclude ignored)
   - tier 3: the first model in the list, whatever it is
5. Order the tier 1/2 candidates by `order` (`newest` / `oldest` / `provider`).
6. Take the first. On any failure, return the `fallback`.

The `resolveModel()` result includes `source`:
- `'live'`    — a model was selected from the live list
- `'pinned'`  — the config `pin` was returned (no network call)
- `'fallback'`— the live list failed or produced no usable results

---

## API

```ts
// Profile selection (the main entry point)
function useProfile(name: 'flagship' | 'economy'): object   // loads profiles/<name>.yml from the package
const AVAILABLE_PROFILES: string[]                          // ['flagship', 'economy']
// env: LLM_MODEL_RESOLVER_PROFILE=economy  (read at require time, before any code runs)

// Custom config (when you need something the bundled profiles don't cover)
function configure(cfg: object): void
function loadConfig(filePath: string): object      // .json (zero dep) or .yml (needs js-yaml)
function effectiveConfig(provider: string): ProviderConfig   // live view of active config

// Resolution
function resolveModel(provider, apiKey, options?): Promise<ResolveResult>
function inspectModels(provider, apiKey, options?): Promise<Inspection>

// options:
//   fallback?:      string   — per-call fallback override
//   forceRefresh?:  boolean  — bypass pin, cache and cooldown
//   order?:         'newest' | 'oldest' | 'provider'
//   timeoutMs?:     number
//   cooldownMs?:    number

// OpenRouter
function fetchFreeModels(apiKey, forceRefreshOrOpts?): Promise<Set<string>>
function getNextFreeModel(apiKey, options?): Promise<string>
function resetFreeModelIndex(): void

// Known-bad model tracking
function markModelBad(provider: 'xai'|'anthropic'|'gemini', modelId: string): void

// Cache
function clearCache(): void

// Live config state (reflect configure() immediately)
const DEFAULT_FALLBACKS:  Record<string, string>
const DEFAULT_TIMEOUT_MS: number
const DEFAULT_COOLDOWN_MS: number
const PREFERENCE:          Record<string, { include: RegExp, exclude: RegExp }>
```

### `profiles/settings.yml` — the primary control

```yaml
# profiles/settings.yml
flagship_performance: no   # yes = flagship (newest/smartest), no = economy (fast/cheap)
```

Edit this in the GitHub repo. The package reads it at startup automatically.

`useProfile(name)` loads a bundled profile programmatically. `LLM_MODEL_RESOLVER_PROFILE`
env var overrides `settings.yml` for per-process control. Both are mainly useful in tests and CI.

Priority: `useProfile()` call > env var > `settings.yml` > flagship defaults.

### `configure(cfg)` and `loadConfig(path)`

For when you need something the bundled profiles don't cover.
Load a config object directly, or from a file. Call once at startup.
Clears the model-list cache so stale results don't survive a reconfigure.

```js
const { loadConfig, configure, resolveModel } = require('llm-model-resolver');

// From a file:
loadConfig('./config.economy.yml');

// Or programmatically:
configure({
  global: { timeoutMs: 300_000 },
  providers: {
    xai:       { pin: 'grok-4.3' },
    anthropic: { exclude: 'haiku|instant|mini', fallback: 'claude-sonnet-5' },
  }
});
```

### `markModelBad(provider, modelId)`

A model can be listed in the provider's `/models` response and still fail the actual API call — Gemini has returned 404 for models its own listing still showed (account-tier gating). Call this when a generation call fails with 404 or 403 (not for 429/5xx, which say nothing about the model). Every subsequent `resolveModel()` skips it for the rest of the process.

```js
const { resolveModel, markModelBad } = require('llm-model-resolver');

let r = await resolveModel('gemini', key, { fallback: 'gemini-flash-latest' });
try {
  return await callGemini(r.id, prompt);
} catch (e) {
  if (e.status !== 404 && e.status !== 403) throw e;   // not a model problem
  markModelBad('gemini', r.id);
  r = await resolveModel('gemini', key, { fallback: 'gemini-flash-latest' });
  return await callGemini(r.id, prompt);                // second failure throws
}
```

The known-bad set is in-memory only (process lifetime). This is intentional — see the design note in the package source.

---

## Supported providers

| Provider | Name | Endpoint | Selection (if no config loaded) |
|----------|------|----------|---------------------------------|
| xAI | `xai` | `GET https://api.x.ai/v1/language-models` (falls back to `/v1/models`) | newest `grok-*`, skipping fast/mini/lite/code-fast/non-reasoning/image/video |
| Anthropic | `anthropic` | `GET https://api.anthropic.com/v1/models?limit=1000` | newest `claude-*`, skipping haiku/instant/mini |
| Gemini | `gemini` | `GET https://generativelanguage.googleapis.com/v1beta/models?key=…` | newest `gemini-*` with `generateContent`, skipping flash/lite and non-chat families |
| OpenRouter | `openrouter` | `GET https://openrouter.ai/api/v1/models` | free models only (both prices zero), round-robin |

No SDKs. Native `fetch` only (Node ≥ 18).

**"Newest" is by release timestamp**, not by parsing the model ID. xAI IDs like `grok-4.20-0309` and `grok-4.3` are not monotonic version numbers — the timestamp from the `/models` response is the only reliable order signal. Anthropic documents its list as newest-first; Gemini publishes no timestamps so generation numbers (`2.5` < `3` < `3.1`) are used instead.

---

## Env-configurable fallbacks (no-config alternative)

If you don't want a config file, set these environment variables before the process starts. They are read once, at `require()` time, and used as the built-in fallbacks:

```bash
XAI_MODEL_FALLBACK=…          # or GROK_MODEL_FALLBACK
ANTHROPIC_MODEL_FALLBACK=…
GEMINI_MODEL_FALLBACK=…
OPENROUTER_MODEL_FALLBACK=…   # or OPENROUTER_FREE_FALLBACK
LLM_MODEL_RESOLVER_TIMEOUT_MS=…   # per-request timeout in ms
```

A config file takes precedence over these env vars. The `options.fallback` argument to `resolveModel()` takes precedence over both.

---

## Design notes

- **In-memory cache** — one `/models` fetch per provider per process.
- **Pin skips the network** — use it when cost predictability matters more than "latest".
- **Relaxed matching** — an over-strict exclude degrades to a less-preferred model rather than to nothing.
- **Fails toward a known model** — network error, timeout, HTTP error, empty list, missing key → your fallback.
- **Zero core dependencies** — only what Node 18+ provides. `js-yaml` is an optional dependency needed only for YAML config files.

---

## Smoke test

```bash
npm test
# With live keys, to verify real provider behavior:
LLM_MODEL_RESOLVER_CONFIG=./config.economy.yml \
  XAI_API_KEY=… node inspect.js xai
```

---

## License

MIT
