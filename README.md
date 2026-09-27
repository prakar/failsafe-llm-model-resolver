# self-healing-models

**Self-healing, failsafe resolver for the current frontier model.**

Live `/models` fetch → preference rules → env-pinned fallback.  
A transient network hiccup never kills a batch job.

```js
const { resolveModel, getNextFreeModel } = require('self-healing-models');

const { id, source } = await resolveModel('xai', process.env.XAI_API_KEY);
// → { id: 'grok-4', source: 'live' }
//    or { id: 'grok-4', source: 'fallback' } when the live list is unreachable
```

---

## Why this exists

Hard-coding model IDs is fragile. Providers ship new versions weekly; free tiers rotate; rate-limits appear and disappear. The classic pattern:

```js
const model = 'grok-4';          // stale next month
const model = 'openrouter/free'; // may 404 or be rate-limited
```

…breaks batch jobs and agents at the worst moment.

**self-healing-models** does the boring but critical work once:

1. Hits each provider’s native model-list endpoint
2. Applies a stable preference rule (newest non-fast / non-mini / non-haiku)
3. Caches the result for the process lifetime
4. Falls back to an env-configurable pinned ID if anything fails

You get the current frontier model when the network works, and a known-good model when it doesn’t.

---

## Supported providers

| Provider       | Endpoint                                              | Preference rule                                      |
|----------------|-------------------------------------------------------|------------------------------------------------------|
| **xAI / Grok** | `GET https://api.x.ai/v1/models`                      | newest `grok-*`, skip `fast` / `mini` / `lite`       |
| **Anthropic**  | `GET https://api.anthropic.com/v1/models`             | newest `claude-*`, skip `haiku` / `instant` (newest-first) |
| **Gemini**     | `GET …/v1beta/models?key=…`                           | newest non-`flash` / non-`lite`                      |
| **OpenRouter** | `GET https://openrouter.ai/api/v1/models`             | free models (`pricing.prompt/completion === "0"`) + round-robin |

No heavy SDKs. Native `fetch` only (Node ≥ 18).

---

## Install

```bash
npm install self-healing-models
```

Or, for personal multi-project reuse without publishing:

```bash
# place index.js somewhere shared, e.g. ~/dev/shared-lib/self-healing-models/
export NODE_PATH="$HOME/dev/shared-lib:$NODE_PATH"
# then: require('self-healing-models')
```

---

## API

### `resolveModel(provider, apiKey, options?)`

```ts
type Provider = 'xai' | 'anthropic' | 'gemini' | 'openrouter';

interface ResolveResult {
  id: string;                 // ready to pass to the provider’s chat endpoint
  source: 'live' | 'fallback';
}

function resolveModel(
  provider: Provider,
  apiKey: string | null | undefined,
  options?: { forceRefresh?: boolean; fallback?: string }
): Promise<ResolveResult>;
```

- **Paid providers** → live list + preference rule → single best ID  
- **OpenRouter** → first currently free model (use `getNextFreeModel` for rotation)  
- **Any failure / missing key** → env-pinned fallback, `source: 'fallback'`

### OpenRouter free-tier helpers

Drop-in replacements for the classic `fetchOrFreeModels` / `getNextOrModel` pattern:

```js
const free = await fetchFreeModels(process.env.OPENROUTER_API_KEY); // Set<string>
const model = await getNextFreeModel(process.env.OPENROUTER_API_KEY); // round-robin
resetFreeModelIndex(); // call at the start of a batch if desired
```

### Cache control

```js
clearCache(); // wipe all in-memory caches (mainly for tests)
```

---

## Env-configurable fallbacks

Never let a transient error kill a job. Set any of:

```bash
XAI_MODEL_FALLBACK=grok-4
# or GROK_MODEL_FALLBACK=grok-4

ANTHROPIC_MODEL_FALLBACK=claude-sonnet-4-20250514
GEMINI_MODEL_FALLBACK=gemini-2.5-pro
OPENROUTER_MODEL_FALLBACK=openrouter/free
# or OPENROUTER_FREE_FALLBACK=openrouter/free
```

Defaults are sensible current frontier IDs; override them for your own pins.

---

## Quick examples

**Simple resolve**

```js
const { resolveModel } = require('self-healing-models');

async function chat(prompt) {
  const { id } = await resolveModel('anthropic', process.env.ANTHROPIC_API_KEY);
  // use `id` with the Anthropic SDK / fetch …
}
```

**Self-healing OpenRouter free rotation** (matches the original working code)

```js
const { getNextFreeModel, resetFreeModelIndex } = require('self-healing-models');

async function callOpenRouter(prompt) {
  resetFreeModelIndex();
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    const model = await getNextFreeModel(process.env.OPENROUTER_API_KEY);
    try {
      // … POST /api/v1/chat/completions with model …
      return result;
    } catch (e) {
      lastErr = e; // rate-limit / empty → try next free model
    }
  }
  throw lastErr;
}
```

**Force a refresh**

```js
const { id } = await resolveModel('xai', key, { forceRefresh: true });
```

---

## Design notes

- **In-memory cache** – one fetch per provider per process. Matches the proven `_orFreeModels` pattern.
- **Preference, not exact IDs** – paid providers use regex + “first match after newest-first”. When the next `grok-5` or `claude-sonnet-5` ships, you get it automatically.
- **OpenRouter free is special** – exact free filter + ordered round-robin. The free pool rotates; the code adapts.
- **Fail-closed to a known model** – network, 429 on the models endpoint, empty list, missing key → pinned fallback. Batch jobs keep running.
- **Zero dependencies** – only what Node 18+ already provides.

---

## Smoke test

```bash
npm test
# or with live keys:
XAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… OPENROUTER_API_KEY=… npm test
```

Without keys the module correctly returns every fallback (`source: 'fallback'`).

---

## License

MIT
