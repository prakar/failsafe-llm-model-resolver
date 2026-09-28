# llm-model-resolver

**Resolve the current model ID for an LLM provider at runtime, instead of hard-coding it.**

Live `/models` fetch → skip models that already failed → preference rules → pinned fallback.
A transient network error never kills a batch job.

> Formerly published as `failsafe-llm-model-resolver`.

```js
const { resolveModel } = require('llm-model-resolver');

const { id, source } = await resolveModel('xai', process.env.XAI_API_KEY);
// → { id: 'grok-…', source: 'live' }        the provider's own current list
//   { id: <your pin>, source: 'fallback' }  list unreachable, or nothing usable left
```

Provider names are the company names: `'xai'`, `'anthropic'`, `'gemini'`, `'openrouter'` — **not** `'grok'` or `'claude'`. An unknown name is the one thing `resolveModel` throws on; every other failure returns your fallback.

---

## Why this exists

Hard-coding model IDs is fragile. Providers ship new versions constantly, retire old ones, and change what your account can call:

```js
const grokModel   = 'grok-4';         // an alias xAI later retired and redirected elsewhere
const geminiModel = 'gemini-2.5-pro'; // still listed, but 404s for accounts created after its deprecation
```

Both of those really happened. This package does the boring but critical work once:

1. Asks each provider's own model-list endpoint what exists right now
2. Skips anything you've told it already failed a real call
3. Applies a stable preference rule (flagship models, not the fast/mini/lite tiers)
4. Falls back to an ID **you** pin if anything goes wrong

You get the current model when the network works, and a known-good model when it doesn't.

---

## How a model is chosen

1. Fetch the provider's live list (cached in memory for the life of the process).
2. Drop every ID reported with `markModelBad()` (see below).
3. Apply the provider's include/exclude rules and take the **first survivor, in the order the provider returned the list**.
4. Nothing usable → your pinned fallback, `source: 'fallback'`.

Step 3 relaxes rather than giving up. In order, it takes:

1. the first ID that matches **include** and does **not** match **exclude**;
2. failing that, the first that matches **include** (exclude ignored) — so if a provider only lists `fast` models you still get one;
3. failing that, the first ID in the list, whatever it is.

Only an empty list (or every ID marked bad) reaches your fallback.

---

## Supported providers

| Provider       | Name         | Endpoint                                                    | What it picks |
|----------------|--------------|-------------------------------------------------------------|---------------|
| **xAI / Grok** | `xai`        | `GET https://api.x.ai/v1/models`                            | `grok-*`, skipping fast, mini, lite, code-fast and **non-reasoning** variants |
| **Anthropic**  | `anthropic`  | `GET https://api.anthropic.com/v1/models`                   | `claude-*`, skipping haiku, instant and mini |
| **Gemini**     | `gemini`     | `GET https://generativelanguage.googleapis.com/v1beta/models?key=…` | `gemini-*` that support `generateContent`, skipping flash, lite, and the embedding / aqa / imagen / veo / tts / live families |
| **OpenRouter** | `openrouter` | `GET https://openrouter.ai/api/v1/models`                   | free models only (prompt **and** completion price both zero), with round-robin |

No heavy SDKs. Native `fetch` only (Node ≥ 18). TypeScript types are included.

### The exact rules

These are exported as `PREFERENCE`. This block is the source of truth — the table above is a summary:

```js
xai:       include: /^grok-/i    exclude: /fast|mini|lite|code-fast|non-?reasoning/i
anthropic: include: /^claude-/i  exclude: /haiku|instant|mini/i
gemini:    include: /gemini-/i   exclude: /flash|lite|embedding|aqa|imagen|veo|tts|live/i
```

Why the excludes:

- **fast / mini / lite / haiku / instant / flash** — the smaller, cheaper tiers. The defaults are biased toward the flagship model. If you want a cheap tier, pin it yourself rather than resolving it.
- **code-fast** — xAI's code-specialised fast variant.
- **non-reasoning** — xAI ships paired `…-reasoning` and `…-non-reasoning` variants of the same generation. The non-reasoning one is skipped so that work which benefits from reasoning gets the reasoning variant. The pattern is `non-?reasoning`, **not** `reasoning`, on purpose: `non-reasoning` contains the word `reasoning`, so excluding the bare word would throw away both variants. The optional hyphen also catches a `nonreasoning` spelling.
- **embedding / aqa / imagen / veo / tts / live** — Gemini's non-chat families. On top of the name rules, the Gemini fetch drops any model that doesn't advertise `generateContent`.

### "Newest" means "first in the provider's list"

**The resolver does not sort.** There is no version or date comparison anywhere in it — it takes the first match in the order the provider returns. Anthropic documents its list as newest-first. xAI and Gemini don't guarantee any order, so the first match is not necessarily the highest version. If you need a specific generation, pin it with `options.fallback` or rule out the unwanted one with `markModelBad()`.

---

## Install

```bash
npm install llm-model-resolver
```

---

## API

```ts
type Provider = 'xai' | 'anthropic' | 'gemini' | 'openrouter';

interface ResolveResult {
  id: string;                     // ready to pass to the provider's chat endpoint
  source: 'live' | 'fallback';
}

function resolveModel(
  provider: Provider,
  apiKey: string | null | undefined,
  options?: { forceRefresh?: boolean; fallback?: string }
): Promise<ResolveResult>;

function markModelBad(provider: 'xai' | 'anthropic' | 'gemini', modelId: string): void;
```

### `resolveModel(provider, apiKey, options?)`

- **Paid providers** → live list, minus known-bad, plus the preference rules → one ID.
- **OpenRouter** → the first currently free model (use `getNextFreeModel` to rotate).
- **No API key** → your fallback immediately, with no network call (handy offline and in tests).
- **Network error, HTTP error, empty list** → your fallback. It does not throw.
- `options.fallback` overrides the env/default pin for this call only.
- `options.forceRefresh` bypasses the cached list.

### `markModelBad(provider, modelId)`

Records that a model failed a **real call**. Every later `resolveModel()` for that provider, in this process, skips it and returns the next-best live candidate. Unknown providers and OpenRouter are silent no-ops.

### OpenRouter free-tier helpers

```js
const free  = await fetchFreeModels(process.env.OPENROUTER_API_KEY);   // Set<string>
const model = await getNextFreeModel(process.env.OPENROUTER_API_KEY);  // round-robin
resetFreeModelIndex();                                                  // start of a batch
```

### `clearCache()`

Wipes every in-memory cache **including the known-bad sets** — mainly for tests.

---

## Listed is not the same as callable

A model can appear in a provider's own `/models` list and still fail the actual call. This was observed in production: Gemini returned `404 … no longer available to new users` for a model its listing still showed. That is an account-tier mismatch the list endpoint doesn't expose, and `resolveModel` cannot see it — it only knows what was listed.

The fix belongs in the caller, and it is two lines: report the failure, then resolve again.

```js
const { resolveModel, markModelBad } = require('llm-model-resolver');

async function generate(prompt) {
  const key  = process.env.GEMINI_API_KEY;
  const opts = { fallback: 'gemini-2.5-flash' };  // an ID you have confirmed works for your account

  let resolved = await resolveModel('gemini', key, opts);
  try {
    return await callGemini(resolved.id, prompt);
  } catch (err) {
    if (err.status !== 404 && err.status !== 403) throw err;  // not a model problem, don't blame the model
    markModelBad('gemini', resolved.id);                      // remembered for the rest of this process
    resolved = await resolveModel('gemini', key, opts);       // now returns the next-best candidate
    return await callGemini(resolved.id, prompt);             // let a second failure throw
  }
}
```

**Only mark a model bad for failures that are about the model** — typically `404` (not found / not available to you) or `403` (no access). Do **not** mark on `429`, `5xx` or timeouts: those say nothing about the model, and marking it would sideline a perfectly good one for the rest of the process.

Keep the retry bounded, as above. If every live candidate ends up marked bad you get your pinned fallback; if that fails too, fail loudly rather than looping.

Because the known-bad set lives inside `resolveModel`, one discovery protects **every** later call in the process — a long batch job pays for a bad model once, not once per item.

### Why the known-bad set is in-memory only

Read this before adding persistence or a TTL. It is deliberate, not a missing feature.

If "known-bad" were saved to disk with no expiry, this package would recreate the exact bug it exists to prevent: the day the provider fixes the model, or your account tier changes, a persisted list keeps avoiding a model that now works — silently, forever, with nothing telling you it's wrong. A TTL "fixes" that by inventing its own failure surface (wrong duration, clock skew, time zones).

Scoping the list to the process needs none of that. It disappears when the process exits, so the next run re-checks a previously bad model exactly once before skipping it again. For a long batch (thousands of calls, one process) that is where the saving matters; for a short one-off call, one wasted request is trivial. Correctness comes from where the boundary naturally sits, not from logic you have to get right.

If you genuinely need memory across processes, that belongs in the calling application's own monitoring, not here.

---

## Env-configurable fallbacks

Set any of these to an ID you have confirmed works for your account. They are read **once, when the module is first required**, so set them before the process starts:

```bash
XAI_MODEL_FALLBACK=…          # or GROK_MODEL_FALLBACK
ANTHROPIC_MODEL_FALLBACK=…
GEMINI_MODEL_FALLBACK=…
OPENROUTER_MODEL_FALLBACK=…   # or OPENROUTER_FREE_FALLBACK
```

Precedence: `options.fallback` → env var → built-in default.

**The built-in defaults are last-resort pins, not guaranteed current.** Pins go stale too, and two of the shipped defaults have already been affected (a retired alias that now redirects, and a model that returned 404 for newer accounts). Always pass `options.fallback` or set the env var. `DEFAULT_FALLBACKS` is exported if you want to inspect what you'd get.

---

## More examples

**Simple resolve**

```js
const { resolveModel } = require('llm-model-resolver');

async function chat(prompt) {
  const { id } = await resolveModel('anthropic', process.env.ANTHROPIC_API_KEY);
  // use `id` with the Anthropic SDK / fetch …
}
```

**OpenRouter free rotation**

```js
const { getNextFreeModel, resetFreeModelIndex } = require('llm-model-resolver');

async function callOpenRouter(prompt) {
  resetFreeModelIndex();
  let lastErr;
  for (let attempt = 0; attempt < 10; attempt++) {
    const model = await getNextFreeModel(process.env.OPENROUTER_API_KEY);
    try {
      // … POST /api/v1/chat/completions with model …
      return result;
    } catch (e) {
      lastErr = e; // rate-limited / empty → the next call returns the next free model
    }
  }
  throw lastErr;
}
```

The free pool rotates, so a failing model is skipped by simply asking for the next one; `markModelBad` isn't needed (or supported) here.

**Force a refresh**

```js
const { id } = await resolveModel('xai', key, { forceRefresh: true });
```

---

## Design notes

- **In-memory cache** — one list fetch per provider per process.
- **Preference rules, not exact IDs** — when the next generation ships you get it without a code change, provided the provider lists it ahead of older ones (see "Newest means first in the list").
- **Relaxed matching** — an over-strict exclude rule degrades to a slightly-less-preferred model rather than to nothing.
- **OpenRouter free is special** — an exact free filter plus round-robin over the list as returned.
- **Fails toward a known model** — network error, HTTP error (including 429 on the models endpoint), empty list, missing key → your pin.
- **Zero dependencies** — only what Node 18+ provides.

## Known limitations

- **No version sorting** — see above. First match in the provider's order, nothing more.
- **Name rules only for xAI and Anthropic** — those lists aren't filtered by capability (only Gemini's is), so a non-chat model whose name matches the include rule and isn't excluded could be chosen if the provider lists it first.
- **No per-call rule overrides** — the include/exclude rules are fixed per provider. Pin a model yourself if you want something the rules skip.
- **No request timeout of its own** — a hung `/models` endpoint is bounded only by Node's built-in `fetch` timeouts.
- **`markModelBad` doesn't apply to OpenRouter** — its rotation already moves on from a failing model.

---

## Smoke test

```bash
npm test
# or with live keys:
XAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… OPENROUTER_API_KEY=… npm test
```

Without keys every provider correctly returns its fallback (`source: 'fallback'`) — which means the live-fetch paths are only exercised when keys are present.

---

## License

MIT
