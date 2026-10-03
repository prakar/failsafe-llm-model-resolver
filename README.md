# llm-model-resolver

**Resolve the current model ID for an LLM provider at runtime, instead of hard-coding it.**

```js
const { resolveModel } = require('llm-model-resolver');
// profile selected by settings.yml in the package — no code change needed to switch models
const { id, source, orderedBy } = await resolveModel('xai', process.env.XAI_API_KEY);
// → { id: 'grok-4-fast', source: 'live', orderedBy: 'cheapest' }
```

> Formerly published as `failsafe-llm-model-resolver`.

---

## Profiles — the only thing you need to change

All preferences live in YAML files inside this package under `profiles/`. Edit them in
the GitHub repo — they ship with the package so everyone who clones it can change them
directly without touching application code.

Two profiles ship in the box:

| Profile | What it picks | Good for |
|---------|---------------|----------|
| `flagship` | Newest, most capable model | Complex reasoning, quality-critical work |
| `economy`  | Cheapest eligible model    | Batch work, classification, tagging |

**One field in `profiles/settings.yml` switches between them:**

```yaml
# profiles/settings.yml — edit this in GitHub to change the active profile
flagship_performance: no    # yes = flagship (newest/best), no = economy (cheapest)
```

The package reads `settings.yml` automatically at startup. No env vars, no code changes.

`LLM_MODEL_RESOLVER_PROFILE=economy` (env var) and `useProfile('economy')` (code) still
work as per-process overrides when needed for CI or testing.

---

## How pricing works

Model selection in the economy profile is based on actual input-token price, not on name
heuristics. This matters: a new expensive model whose name doesn't say "reasoning" still
ranks below a cheaper one automatically.

Prices come from two sources with different confidence levels:

| Provider | Price source | Confidence | Notes |
|----------|-------------|------------|-------|
| xAI | `prompt_text_token_price` field in `/v1/language-models` response | `live` | Automatic, no maintenance needed |
| Anthropic | `knownPrices` table in `economy.yml` | `maintained` | Anthropic's `/v1/models` returns no pricing |
| Gemini | `knownPrices` table in `economy.yml` | `maintained` | Gemini's API returns no pricing |

This provenance is exposed on every candidate in `inspectModels()`:

```js
const ev = await inspectModels('xai', key);
// ev.candidates[0]:
// { id: 'grok-4-fast', priceIn: 0.20, priceOut: 0.50,
//   priceSource: 'provider-api', priceConfidence: 'live', priceUpdated: null, ... }

// vs. Anthropic:
// { id: 'claude-haiku-4-5', priceIn: 1.00, priceOut: 5.00,
//   priceSource: 'maintained', priceConfidence: 'maintained', priceUpdated: '2026-09-29', ... }
```

`priceIn` and `priceOut` are **effective base rates** in USD per million tokens — uncached
input, standard output. This is a deliberate simplification appropriate for model
*selection*. It ignores volume tiers, caching discounts, batch pricing, and reasoning token
surcharges. Cost *accounting* (what you were actually billed) is a separate concern that
belongs in your application, not here.

If `cheapest` is requested but no price data exists for a provider (neither from the API
nor from `knownPrices`), a `LLM_RESOLVER_PRICE_UNAVAILABLE` warning is emitted and the
provider's own list order is used instead of silently returning the wrong model.

---

## Updating the price table

When Anthropic or Gemini changes their pricing, edit `profiles/economy.yml`:

```yaml
anthropic:
  knownPrices:
    source:  maintained
    updated: "2026-10-01"       # ← bump this date when you update prices
    models:
      claude-haiku-4:  { input: 1.00, output: 5.00 }
      claude-sonnet-5: { input: 3.00, output: 15.00 }
      claude-opus-5:   { input: 15.00, output: 75.00 }
```

Key matching uses longest prefix: `claude-haiku-4` matches `claude-haiku-4-5-20251001`
and any future haiku-4 variant, so you don't need to update the table for every minor
model release. After editing the YAML, run `npm run build-profiles` to regenerate the
`.js` counterpart.

Verify current rates at:
- Anthropic: https://www.anthropic.com/pricing
- Gemini: https://ai.google.dev/gemini-api/docs/pricing

---

## Economy profile (`profiles/economy.yml`)

```yaml
global:
  order: cheapest   # sort eligible models by input-token price, cheapest first

providers:
  xai:
    include: "^grok-"
    exclude: "non-?reasoning|image|imagine|video|code-fast"
    fallback: "grok-4.3"
    # No knownPrices — xAI returns live pricing in its /v1/language-models response

  anthropic:
    include: "^claude-"
    exclude: "instant|mini"
    fallback: "claude-haiku-4-5"
    knownPrices:
      source: maintained
      updated: "2026-09-29"
      models:
        claude-haiku-3:  { input: 0.25,  output: 1.25  }
        claude-haiku-4:  { input: 1.00,  output: 5.00  }
        claude-sonnet-5: { input: 3.00,  output: 15.00 }
        claude-opus-5:   { input: 15.00, output: 75.00 }

  gemini:
    include: "gemini-"
    exclude: "lite|embedding|aqa|imagen|veo|tts|live|image|audio"
    fallback: "gemini-flash-latest"
    knownPrices:
      source: maintained
      updated: "2026-09-29"
      models:
        gemini-2.5-flash:    { input: 0.075, output: 0.30 }
        gemini-flash-latest: { input: 0.075, output: 0.30 }
        gemini-2.5-pro:      { input: 1.25,  output: 5.00 }
```

Known fast/cheap models as of September 2026:

| Provider | Model | Input $/M | Output $/M |
|----------|-------|-----------|------------|
| xAI | `grok-4-fast` | $0.20 | $0.50 |
| xAI | `grok-4.1-fast` | $0.20 | $0.50 |
| xAI | `grok-4.3` | $1.25 | $2.50 |
| Anthropic | `claude-3-haiku-20240307` | $0.25 | $1.25 |
| Anthropic | `claude-haiku-4-5` | $1.00 | $5.00 |
| Gemini | `gemini-2.5-flash` | $0.075 | $0.30 |

---

## Flagship profile (`profiles/flagship.yml`)

Picks the newest, most capable model. No price ordering — uses `order: newest`.

```yaml
global:
  order: newest

providers:
  xai:       { include: "^grok-",   exclude: "non-?reasoning|fast|mini|lite|code-fast|image|imagine|video" }
  anthropic: { include: "^claude-", exclude: "haiku|instant|mini" }
  gemini:    { include: "gemini-",  exclude: "flash|lite|embedding|aqa|imagen|veo|tts|live|image|audio" }
```

---

## Install

```bash
npm install llm-model-resolver
# To load custom YAML files with loadConfig() (bundled profiles need no extra dep):
npm install js-yaml
```

---

## Supported providers

| Provider | Name | Endpoint | Selection |
|----------|------|----------|-----------|
| xAI | `xai` | `GET https://api.x.ai/v1/language-models` (fallback: `/v1/models`) | by `order` within include/exclude rules |
| Anthropic | `anthropic` | `GET https://api.anthropic.com/v1/models?limit=1000` | by `order` within include/exclude rules |
| Gemini | `gemini` | `GET https://generativelanguage.googleapis.com/v1beta/models?key=…` | by `order`; only `generateContent` models |
| OpenRouter | `openrouter` | `GET https://openrouter.ai/api/v1/models` | free models only, round-robin |

No SDKs. Native `fetch` only (Node ≥ 18).

**Ordering signals by provider:**

| Provider | `order: newest/oldest` | `order: cheapest` |
|----------|------------------------|-------------------|
| xAI | `created` (Unix timestamp from API) | `prompt_text_token_price` from API |
| Anthropic | `created_at` (RFC 3339 from API) | `knownPrices` table in YAML |
| Gemini | generation number parsed from ID (`2.5` < `3` < `3.1`) | `knownPrices` table in YAML |

---

## API

```ts
// Profile selection
function useProfile(name: 'flagship' | 'economy'): object
const AVAILABLE_PROFILES: string[]
// env: LLM_MODEL_RESOLVER_PROFILE=economy  (read at require time)

// Custom config
function configure(cfg: object): void
function loadConfig(filePath: string): object   // .json (zero dep) or .yml (needs js-yaml)
function effectiveConfig(provider: string): ProviderConfig

// Resolution
function resolveModel(provider, apiKey, options?): Promise<ResolveResult>
// ResolveResult: { id, source: 'live'|'pinned'|'fallback', orderedBy }

function inspectModels(provider, apiKey, options?): Promise<Inspection>
// Inspection: { id, source, orderedBy, tier, reason, fallback, error,
//               candidates: [{ id, priceIn, priceOut, priceSource, priceConfidence,
//                              priceUpdated, created, generation, status, rank }] }

// options: { forceRefresh?, fallback?, order?, timeoutMs?, cooldownMs? }

// OpenRouter
function fetchFreeModels(apiKey, opts?): Promise<Set<string>>
function getNextFreeModel(apiKey, opts?): Promise<string>
function resetFreeModelIndex(): void

// Known-bad model tracking
function markModelBad(provider: 'xai'|'anthropic'|'gemini', modelId: string): void

// Cache / state
function clearCache(): void
const DEFAULT_FALLBACKS:  Record<string, string>   // live view of active config
const DEFAULT_TIMEOUT_MS:  number
const DEFAULT_COOLDOWN_MS: number
const PREFERENCE: Record<string, { include: RegExp, exclude: RegExp }>
```

---

## Timeouts and the fetch cool-down

Every `/models` request has a timeout (default **10 seconds** in flagship, **5 minutes**
in economy). After a failed fetch, the provider is skipped for 60 seconds rather than
retried on every call. Set `LLM_MODEL_RESOLVER_TIMEOUT_MS` or pass `timeoutMs` per call.

---

## Known-bad model tracking

A model can be listed in a provider's `/models` response and still fail the actual API
call. Gemini has returned 404 for models its own listing still showed (account-tier
gating). Mark it bad on 404 or 403 — not on 429 or 5xx — and every subsequent
`resolveModel()` skips it:

```js
const { resolveModel, markModelBad } = require('llm-model-resolver');

let r = await resolveModel('gemini', key, { fallback: 'gemini-flash-latest' });
try {
  return await callGemini(r.id, prompt);
} catch (e) {
  if (e.status !== 404 && e.status !== 403) throw e;
  markModelBad('gemini', r.id);
  r = await resolveModel('gemini', key, { fallback: 'gemini-flash-latest' });
  return await callGemini(r.id, prompt);   // second failure throws
}
```

The known-bad set is in-memory only (process lifetime). See the design note in `index.js`
before adding persistence or a TTL — it is intentional.

---

## Env-configurable fallbacks

```bash
XAI_MODEL_FALLBACK=…          # or GROK_MODEL_FALLBACK
ANTHROPIC_MODEL_FALLBACK=…
GEMINI_MODEL_FALLBACK=…
OPENROUTER_MODEL_FALLBACK=…   # or OPENROUTER_FREE_FALLBACK
LLM_MODEL_RESOLVER_TIMEOUT_MS=…
```

A config file takes precedence over these. `options.fallback` per call takes precedence
over both.

---

## Potential future work

Deliberately not built; listed here so the tradeoffs are visible to anyone extending
the package.

**Per-provider pricing files.** The suggestion was to split `knownPrices` into separate
`pricing/anthropic.yml`, `pricing/gemini.yml` files rather than keeping them inline in
`economy.yml`. The current inline approach is sufficient for a small table you update
quarterly; a separate file structure would make sense if pricing data grew large enough
to warrant it or if multiple profiles needed to share the same price data.

**External pricing catalogue as a source.** OpenRouter's `/api/v1/models` returns
`pricing.prompt` and `pricing.completion` for models from Anthropic, Google and others.
This could serve as a price-discovery mechanism for providers whose own APIs return no
pricing. It was intentionally not implemented: OpenRouter's prices are what you pay to
route *through* OpenRouter (including their margin), not what a direct Anthropic or
Gemini API call costs. Using it to compare against a direct xAI call would be comparing
apples to oranges. The `maintained` table is the correct level of trust for now; an
external catalogue could be added as a *validation* mechanism (flag when OpenRouter's
price deviates significantly from the table) rather than as the source of truth.

**Multi-dimensional pricing.** Providers charge differently for cached vs. uncached
input, long-context tiers, batch requests, and reasoning tokens. The current `priceIn`
is the base uncached input rate — a deliberate simplification for model *selection*,
explicitly documented as such. A more complete pricing model belongs in the application
doing cost accounting (Quarry's `MODEL_PRICES` table in `tagger.js`), not here.

**Version sorting for xAI.** The resolver sorts xAI models by the `created` timestamp
from the API rather than by parsing version numbers from the ID. This is correct because
xAI IDs like `grok-4.20-0309` and `grok-4.3` are not monotonic version numbers, so
timestamp is the only reliable ordering signal. If xAI ever stabilises a version-number
scheme, a version-aware sort could replace the timestamp sort for `order: newest`.

**Inference-time capability filtering.** The Anthropic and xAI model lists are filtered
by name patterns only; Gemini's list is additionally filtered by `supportedGenerationMethods`.
A future version could use an inference-time capability check (probe a model with a
minimal prompt before accepting it) to catch models that are listed but not callable for
this account. This was not built because it adds latency and a billed API call to every
cold startup.

---

## Design notes

- **In-memory cache** — one `/models` fetch per provider per process.
- **Pin skips the network** — use it when cost predictability matters more than "latest".
- **Cheapest never silently means newest** — if no price data exists, a warning is emitted.
- **Fails toward a known model** — network error, timeout, empty list → your fallback.
- **Zero core dependencies** — only what Node 18+ provides. `js-yaml` is optional and only
  needed for loading custom YAML files with `loadConfig()`; bundled profiles use `.js`.

---

## License

MIT
