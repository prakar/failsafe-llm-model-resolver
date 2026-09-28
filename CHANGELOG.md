# Changelog

## 1.2.0

**Behavior change — read this.** The default is now **newest first**. Before, the resolver took the first
match in the provider's own order, which for xAI and Gemini is not guaranteed to be newest. This can change
which model you get. Pass `{ order: 'provider' }` for the old behavior, and run `node inspect.js <provider>`
to see what a resolution would pick before upgrading.

### Added
- **Recency ordering.** xAI by `created`, Anthropic by `created_at`, Gemini by the generation number in the ID
  (Gemini publishes no release date). Models with no signal sort after models that have one. `resolveModel()`
  now also returns `orderedBy`. Option: `order: 'newest' | 'provider'`.
- **`inspectModels()`** — explains a resolution: every listed model, its recency signal, and its status.
- **Request timeout** (default 10s, `timeoutMs` / `LLM_MODEL_RESOLVER_TIMEOUT_MS`), covering the body as well as
  the headers.
- **Fetch cool-down** (default 60s, `cooldownMs`) so a hung endpoint costs one timeout, not one per call.
- `fetchFreeModels()` / `getNextFreeModel()` accept an options object (`fetchFreeModels(key, true)` still works).
- `DEFAULT_TIMEOUT_MS`, `DEFAULT_COOLDOWN_MS` exports; `inspect.js` for checking against live keys.
- An offline test suite (`npm test`) and a README drift guard.

### Changed
- **xAI** is read from `/v1/language-models` (chat and image-understanding models only), falling back to `/v1/models`.
- **Anthropic** is requested with `limit=1000`; the API returns only 20 models per page otherwise.
- **Exclude rules.** xAI: added `image|imagine|video`. Gemini: added `image|audio`
  (`gemini-3-pro-image-preview` and similar advertise `generateContent` and would otherwise rank as a "pro" text model).
- **Default fallbacks:** `anthropic` → `claude-sonnet-5`, `gemini` → `gemini-flash-latest`
  (was `gemini-2.5-pro`, which is gated to accounts that used it before). `xai` and `openrouter` unchanged.

### Fixed
- OpenRouter: one failed fetch pinned the fallback for the rest of the process, and it was reported as `source: 'live'`.
- A failed refresh threw away a perfectly good cached list instead of continuing to serve it.
- Timeout errors never contain the API key (Gemini carries it in the URL).
- Comments no longer claim the lists are sorted "newest first" (only Anthropic documents that).

## 1.1.0 — changes made after the rename (all included in 1.2.0)
- `markModelBad()` and the in-memory known-bad set: a listed model can still fail the real call.
- Gemini: fixed a `ReferenceError` that made live resolution fall back on every real call.
- xAI: `non-reasoning` variants are skipped so the reasoning variant is preferred.
- Renamed from `failsafe-llm-model-resolver`.

## 1.0.0
- Initial release as `failsafe-llm-model-resolver`.
