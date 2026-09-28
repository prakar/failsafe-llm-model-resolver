# llm-model-resolver

**Resolve the current model ID for an LLM provider at runtime, instead of hard-coding it.**

Live `/models` fetch → skip models that already failed → preference rules → newest first → pinned fallback.
A network error, a hung endpoint, or a bad model never kills a batch job.

> Formerly published as `failsafe-llm-model-resolver`.

```js
const { resolveModel } = require('llm-model-resolver');

const { id, source, orderedBy } = await resolveModel('xai', process.env.XAI_API_KEY);
// → { id: 'grok-…', source: 'live', orderedBy: 'created' }    the newest eligible model
//   { id: <your pin>, source: 'fallback', orderedBy: null }   list unreachable, or nothing usable left
```

Provider names are the company names: `'xai'`, `'anthropic'`, `'gemini'`, `'openrouter'` — **not** `'grok'` or `'claude'`. An unknown name is the one thing `resolveModel` throws on; every other failure returns your fallback.

---

## Why this exists

Hard-coding model IDs is fragile. Providers ship new versions constantly, retire old ones, and change what your account can call:

```js
const grokModel   = 'grok-4';         // an alias xAI later retired and redirected elsewhere
const geminiModel = 'gemini-2.5-pro'; // still listed, but 404s for accounts that hadn't used it before
```

Both of those really happened. This package does the boring but critical work once:

1. Asks each provider's own model-list endpoint what exists right now
2. Skips anything you've told it already failed a real call
3. Applies a stable preference rule (flagship models, not the fast/mini/lite tiers, and no image or audio models)
4. Picks the **newest** of what's left, using the provider's own release timestamps where they exist
5. Falls back to an ID **you** pin if anything goes wrong — including a request that simply never returns

You get the current model when the network works, and a known-good model when it doesn't.

---

## How a model is chosen

1. Fetch the provider's live list (cached in memory for the life of the process).
2. Drop every ID reported with `markModelBad()` (see below).
3. Keep the models the provider's include/exclude rules allow.
4. Order those **newest first** (see the next section).
5. Take the first. Nothing usable → your pinned fallback, `source: 'fallback'`.

Step 3 relaxes rather than giving up. In order, it takes:

1. IDs that match **include** and do **not** match **exclude**;
2. failing that, IDs that match **include** (exclude ignored) — so if a provider only lists `fast` models you still get one;
3. failing that, the first ID in the list, whatever it is (there is no basis for ranking it, so it keeps the provider's order).

Recency ordering applies within steps 1 and 2 only, so a newer model your rules excluded is never chosen over an older one they allow. Only an empty list, or every ID marked bad, reaches your fallback.

### Newest first

"Newest" means different things to each provider's API, so the resolver uses the best signal each one actually publishes:

| Provider  | Recency signal | How it's used |
|-----------|----------------|---------------|
| xAI       | `created` (Unix time) | sorted by release time |
| Anthropic | `created_at` (RFC 3339) | sorted by release time |
| Gemini    | none — the API publishes no release date | sorted by the generation number in the ID: `2.5` < `3` < `3.1` |

The result's `orderedBy` tells you which signal was used: `'created'`, `'version'`, or `'provider'` (no usable signal, so the provider's own order was kept).

- **A model with no signal sorts after models that have one**, in the provider's order. Anthropic sets `created_at` to the epoch when a release date is unknown; that is treated as "unknown", not as "the oldest model ever".
- **Ties keep the provider's order** (the sort is stable).
- **Pass `{ order: 'provider' }`** to skip recency ordering and take the first match in the provider's own order.

**Why xAI isn't sorted by the version in its IDs.** xAI ships names like `grok-4.20-0309-reasoning` and `grok-4.3`. Read as dotted versions, 4.20 ranks above 4.3 — but those numbers are product names (sometimes with a date suffix), not a release counter. The release timestamp is the only trustworthy order. Parsing versions out of IDs is reasonable only where the numbering really is monotonic, which is true of Gemini and not of xAI.

**Previews are eligible.** A newer `-preview` model outranks an older stable one. That is usually what "current frontier" means, but if you need stable-only, pin your own ID.

---

## Supported providers

| Provider       | Name         | Endpoint | What it picks |
|----------------|--------------|----------|---------------|
| **xAI / Grok** | `xai`        | `GET https://api.x.ai/v1/language-models`, falling back to `GET https://api.x.ai/v1/models` | `grok-*`, skipping fast, mini, lite, code-fast, **non-reasoning**, and image/video models |
| **Anthropic**  | `anthropic`  | `GET https://api.anthropic.com/v1/models?limit=1000` | `claude-*`, skipping haiku, instant and mini |
| **Gemini**     | `gemini`     | `GET https://generativelanguage.googleapis.com/v1beta/models?key=…` | `gemini-*` that support `generateContent`, skipping flash, lite, image, audio, and the embedding / aqa / imagen / veo / tts / live families |
| **OpenRouter** | `openrouter` | `GET https://openrouter.ai/api/v1/models` | free models only (prompt **and** completion price both zero), with round-robin |

No heavy SDKs. Native `fetch` only (Node ≥ 18). TypeScript types are included.

Two details worth knowing:

- **xAI** is read from `/v1/language-models`, which lists only chat and image-understanding models. The general `/v1/models` list also contains image-generation models (for example `grok-2-image-1212`), so it is used only if the language-models call fails, and the name rules below then keep image and video models out.
- **Anthropic** returns 20 models per page unless asked for more. The resolver asks for the maximum (1000), so recency ordering sees the whole list rather than just page one.

### The exact rules

These are exported as `PREFERENCE`. This block is the source of truth — the table above is a summary:

```js
xai:       include: /^grok-/i    exclude: /fast|mini|lite|code-fast|non-?reasoning|image|imagine|video/i
anthropic: include: /^claude-/i  exclude: /haiku|instant|mini/i
gemini:    include: /gemini-/i   exclude: /flash|lite|embedding|aqa|imagen|veo|tts|live|image|audio/i
```

Why the excludes:

- **fast / mini / lite / haiku / instant / flash** — the smaller, cheaper tiers. The defaults are biased toward the flagship model. If you want a cheap tier, pin it yourself rather than resolving it.
- **code-fast** — xAI's code-specialised fast variant.
- **non-reasoning** — xAI ships paired `…-reasoning` and `…-non-reasoning` variants of the same generation. The non-reasoning one is skipped so that work which benefits from reasoning gets the reasoning variant. The pattern is `non-?reasoning`, **not** `reasoning`, on purpose: `non-reasoning` contains the word `reasoning`, so excluding the bare word would throw away both variants. The optional hyphen also catches a `nonreasoning` spelling.
- **image / imagine / video** (xAI) — non-chat models that the general model list mixes in with the chat ones.
- **image / audio** (Gemini) — models such as `gemini-3-pro-image-preview` carry ordinary "pro" names and advertise `generateContent`, so a name-only rule would happily rank an image-output model as the best text model.
- **embedding / aqa / imagen / veo / tts / live** — Gemini's other non-chat families. On top of the name rules, the Gemini fetch drops any model that doesn't advertise `generateContent`.

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
  id: string;                                   // ready to pass to the provider's chat endpoint
  source: 'live' | 'fallback';
  orderedBy: 'created' | 'version' | 'provider' | null;
}

interface ResolveOptions {
  forceRefresh?: boolean;                       // bypass the cached list and the fetch cool-down
  fallback?: string;                            // override the env/default pin for this call
  order?: 'newest' | 'provider';                // default 'newest'
  timeoutMs?: number;                           // per-request timeout, default 10000
  cooldownMs?: number;                          // pause after a failed fetch, default 60000 (0 disables)
}

function resolveModel(provider: Provider, apiKey: string | null | undefined, options?: ResolveOptions): Promise<ResolveResult>;
function inspectModels(provider: Provider, apiKey: string | null | undefined, options?: ResolveOptions): Promise<Inspection>;
function markModelBad(provider: 'xai' | 'anthropic' | 'gemini', modelId: string): void;
```

### `resolveModel(provider, apiKey, options?)`

- **Paid providers** → live list, minus known-bad, plus the preference rules, newest first → one ID.
- **OpenRouter** → the first currently free model (use `getNextFreeModel` to rotate).
- **No API key** → your fallback immediately, with no network call (handy offline and in tests).
- **Network error, timeout, HTTP error, empty list** → your fallback. It does not throw.
- `options.fallback` overrides the env/default pin for this call only.
- `options.forceRefresh` bypasses the cached list **and** the fetch cool-down.

### `inspectModels(provider, apiKey, options?)`

Explains a resolution instead of just returning it — every model the provider listed, the recency signal it had, and what happened to it:

```js
const { inspectModels } = require('llm-model-resolver');

const ev = await inspectModels('gemini', process.env.GEMINI_API_KEY);
// {
//   provider: 'gemini', id: 'gemini-3.1-pro-preview', source: 'live',
//   reason: null,               // when the fallback was returned: 'no-key' | 'fetch-failed' | 'cooldown'
//                               //                                  | 'empty-list' | 'all-known-bad' | 'error'
//   orderedBy: 'version', tier: 1, fallback: 'gemini-flash-latest', error: null,
//   candidates: [
//     { id: 'gemini-3.1-pro-preview',      created: null, generation: '3.1', status: 'chosen',   rank: 1 },
//     { id: 'gemini-2.5-pro',              created: null, generation: '2.5', status: 'eligible', rank: 2 },
//     { id: 'gemini-3-pro-image-preview',  created: null, generation: '3',   status: 'excluded', rank: null },
//     …
//   ]
// }
```

`status` is one of `chosen`, `eligible`, `excluded`, `not-matching`, `known-bad`. `tier` is which relaxation step of the rules produced the answer. It makes a real request unless the list is cached, and `error` never contains your API key. Use it to check why a model was (or wasn't) picked before you trust a resolution in production.

From a clone of the repo, `node inspect.js xai` prints the same thing as a table using your environment's keys.

### `markModelBad(provider, modelId)`

Records that a model failed a **real call**. Every later `resolveModel()` for that provider, in this process, skips it and returns the next-best live candidate. Unknown providers and OpenRouter are silent no-ops.

### OpenRouter free-tier helpers

```js
const free  = await fetchFreeModels(process.env.OPENROUTER_API_KEY);   // Set<string>
const model = await getNextFreeModel(process.env.OPENROUTER_API_KEY);  // round-robin
resetFreeModelIndex();                                                  // start of a batch
```

`fetchFreeModels(apiKey, forceRefresh)` still takes a boolean; it also accepts an options object (`forceRefresh`, `timeoutMs`, `cooldownMs`), as does `getNextFreeModel`.

### `clearCache()`

Wipes every in-memory cache **including the known-bad sets and fetch cool-downs** — mainly for tests.

---

## Timeouts and the fetch cool-down

Every `/models` request has a timeout (default **10 seconds**, covering the whole exchange including reading the body). A server that never answers, or answers headers and then stalls, is abandoned and the fallback is returned.

Set it per call, or for a whole process:

```js
await resolveModel('xai', key, { timeoutMs: 3000 });
```
```bash
LLM_MODEL_RESOLVER_TIMEOUT_MS=3000     # options.timeoutMs wins; invalid values are ignored
```

**After a failed list fetch the resolver doesn't retry that provider for 60 seconds** (`options.cooldownMs`; `0` disables) and returns the fallback in the meantime. Without this, a timeout alone would only turn one long stall into many short ones: a hung endpoint would cost the full timeout on *every* `resolveModel()` call of a long batch. With it, a hung endpoint costs one timeout, then instant fallbacks until the minute is up.

- The cool-down is **per provider**; `forceRefresh` bypasses it.
- A failed **refresh** keeps serving the list you already have, rather than dropping to the fallback.
- Timeout errors name only the host, never the URL — Gemini's API key travels in its query string, and these messages end up in logs.
- The timeout is also applied to the OpenRouter helpers.
- The defaults are exported as `DEFAULT_TIMEOUT_MS` (10000) and `DEFAULT_COOLDOWN_MS` (60000).

(The cool-down only suppresses re-fetching a *list*. It is unrelated to the known-bad set below, which deliberately has no timer.)

---

## Listed is not the same as callable

A model can appear in a provider's own `/models` list and still fail the actual call. This was observed in production: Gemini returned `404 … no longer available to new users` for a model its listing still showed. Google's documentation explains it: access to the 2.5 models was limited to accounts that had used them before. The models weren't retired, only gated by account history, which no list endpoint exposes. Deprecated models are likewise reported to stay in the list until they are shut down. `resolveModel` cannot see any of this — it only knows what was listed.

The fix belongs in the caller, and it is two lines: report the failure, then resolve again.

```js
const { resolveModel, markModelBad } = require('llm-model-resolver');

async function generate(prompt) {
  const key  = process.env.GEMINI_API_KEY;
  const opts = { fallback: 'gemini-flash-latest' };  // an ID you have confirmed works for your account

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

## Fallbacks

Set any of these to an ID you have confirmed works for your account. They are read **once, when the module is first required**, so set them before the process starts:

```bash
XAI_MODEL_FALLBACK=…          # or GROK_MODEL_FALLBACK
ANTHROPIC_MODEL_FALLBACK=…
GEMINI_MODEL_FALLBACK=…
OPENROUTER_MODEL_FALLBACK=…   # or OPENROUTER_FREE_FALLBACK
```

Precedence: `options.fallback` → env var → built-in default.

**The built-in defaults are last-resort pins, reviewed on 2026-09-28 against provider documentation and production use — not tested against your account.** They are chosen for durability, not for being the newest:

| Provider     | Default               | Why |
|--------------|-----------------------|-----|
| `xai`        | `grok-4`              | worked in production the day before this review; xAI has retired dated grok-4 IDs but redirects them, so the alias keeps resolving |
| `anthropic`  | `claude-sonnet-5`     | Anthropic's published model string |
| `gemini`     | `gemini-flash-latest` | Google's auto-updating alias. It replaces `gemini-2.5-pro`, which is gated to accounts that used it before, and it stays valid when Google retires a specific version |
| `openrouter` | `openrouter/free`     | OpenRouter's own router |

Pins go stale too — providers retire IDs, gate them by account, and retarget "latest" aliases. Always pass `options.fallback` or set the env var to something you've verified. `DEFAULT_FALLBACKS` is exported if you want to see what you'd get.

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

**Force a refresh, or keep the provider's own order**

```js
const { id } = await resolveModel('xai', key, { forceRefresh: true });
const { id: first } = await resolveModel('xai', key, { order: 'provider' });
```

---

## Design notes

- **In-memory cache** — one list fetch per provider per process.
- **Preference rules choose who is eligible; recency chooses among them** — when the next generation ships you get it without a code change.
- **Relaxed matching** — an over-strict exclude rule degrades to a slightly-less-preferred model rather than to nothing.
- **OpenRouter free is special** — an exact free filter plus round-robin over the list as returned. A failed fetch is retried after the cool-down rather than pinning the fallback for the rest of the process.
- **Fails toward a known model** — network error, timeout, HTTP error (including 429 on the models endpoint), empty list, missing key → your pin.
- **Zero dependencies** — only what Node 18+ provides.

## Known limitations

- **Gemini ordering is a heuristic.** Google publishes no release date, so recency comes from the generation number in the ID. IDs with no number (`gemini-pro-latest`) rank after numbered ones, and two models of the same generation keep the provider's order.
- **"Latest" aliases retarget.** An alias like `gemini-flash-latest` is a good pin precisely because it moves — and for the same reason the model behind it can change under you.
- **The chosen model can change when a provider ships a new one**, and its price and behaviour can change with it. If you track cost or quality per model, key it on the resolved `id`, not on the provider name.
- **Name rules are a heuristic.** They exclude the known non-chat and small-tier families; a new family with an unexpected name could slip through, which is what `inspectModels()` is for.
- **No per-call rule overrides** — the include/exclude rules are fixed per provider. Pin a model yourself if you want something the rules skip.
- **Lists are read as one page** — Anthropic up to 1000 models, Gemini up to 1000 — which comfortably exceeds today's catalogues.
- **`markModelBad` doesn't apply to OpenRouter** — its rotation already moves on from a failing model.

---

## Smoke test

```bash
npm test
# or with live keys:
XAI_API_KEY=… ANTHROPIC_API_KEY=… GEMINI_API_KEY=… OPENROUTER_API_KEY=… npm test
```

`npm test` runs the offline suite (a mocked network, plus real local sockets for the timeout tests) and then the smoke test. Without keys the smoke test returns every provider's fallback (`source: 'fallback'`), so the live-fetch paths are only exercised when keys are present — use `node inspect.js <provider>` to see a live resolution in full.

---

## License

MIT
