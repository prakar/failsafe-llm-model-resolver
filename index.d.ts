/**
 * llm-model-resolver
 *
 * Resolve the current model ID for an LLM provider at runtime instead of
 * hard-coding it. xAI, Anthropic, Gemini and OpenRouter.
 */

/** Provider names are the company names: 'xai' (not 'grok'), 'anthropic' (not 'claude'). */
export type Provider = 'xai' | 'anthropic' | 'gemini' | 'openrouter';

export type ResolveSource = 'live' | 'fallback';

/**
 * Which recency signal ordered the candidates:
 *  - 'created'  the provider's release timestamp (xAI `created`, Anthropic `created_at`)
 *  - 'version'  the generation number in the ID (Gemini, which publishes no timestamp)
 *  - 'provider' no usable signal (or order:'provider'): the provider's own order
 */
export type OrderedBy = 'created' | 'version' | 'provider';

export interface ResolveResult {
  /** Model ID ready to pass to the provider's chat/completions endpoint */
  id: string;
  /** Whether the ID came from a live /models fetch or from a pinned fallback */
  source: ResolveSource;
  /** Recency signal used to order the candidates; null when the fallback was returned */
  orderedBy: OrderedBy | null;
}

export interface ResolveOptions {
  /** Bypass the in-memory list cache and the fetch cool-down */
  forceRefresh?: boolean;
  /** Override the env/default fallback for this call only */
  fallback?: string;
  /** 'newest' (default) orders by recency; 'provider' keeps the provider's own order */
  order?: 'newest' | 'provider';
  /** Per-request timeout in ms. Default 10000, or the LLM_MODEL_RESOLVER_TIMEOUT_MS env var. */
  timeoutMs?: number;
  /** After a failed list fetch, don't retry that provider for this many ms (default 60000; 0 disables). */
  cooldownMs?: number;
}

/**
 * Resolve the best model ID for a provider.
 *
 * Paid providers: live list → drop known-bad → include/exclude rules → newest first.
 * OpenRouter returns the first currently free model.
 * On any failure (network, timeout, auth, empty list) returns the fallback so a
 * transient hiccup never kills a batch job. Throws ONLY for an unknown provider name.
 */
export function resolveModel(
  provider: Provider,
  apiKey: string | undefined | null,
  options?: ResolveOptions
): Promise<ResolveResult>;

export type CandidateStatus = 'chosen' | 'eligible' | 'excluded' | 'not-matching' | 'known-bad';

export interface Candidate {
  id: string;
  /** Release time as an ISO string, when the provider gives one */
  created: string | null;
  /** Generation parsed from the ID (Gemini only), e.g. "3.1" */
  generation: string | null;
  status: CandidateStatus;
  /** Position among the eligible candidates (1 = chosen); null for excluded / not-matching / known-bad */
  rank: number | null;
}

export type FallbackReason =
  | 'no-key' | 'fetch-failed' | 'cooldown' | 'empty-list' | 'all-known-bad' | 'error';

export interface Inspection {
  provider: Provider;
  id: string;
  source: ResolveSource;
  /** Why the fallback was returned; null when the answer is live */
  reason: FallbackReason | null;
  orderedBy: OrderedBy | null;
  /** 1 = include and not exclude; 2 = include only; 3 = first listed. Null when the fallback was returned. */
  tier: 1 | 2 | 3 | null;
  fallback: string;
  /** Last fetch error, if any (never contains the API key) */
  error: string | null;
  /** Every listed model: chosen first, then eligible by rank, then excluded, not-matching, known-bad */
  candidates: Candidate[];
}

/**
 * Explain a resolution: every listed model with its recency signal and status,
 * which ordering signal was used, and why the fallback was returned if it was.
 * Makes a real request unless the list is already cached. Same options as resolveModel().
 */
export function inspectModels(
  provider: Provider,
  apiKey: string | undefined | null,
  options?: ResolveOptions
): Promise<Inspection>;

/**
 * Fetch (and cache) the set of currently free OpenRouter model IDs.
 * Drop-in for the classic fetchOrFreeModels() pattern. The second argument is
 * either a boolean (forceRefresh, the original signature) or an options object.
 */
export function fetchFreeModels(
  apiKey: string,
  arg?: boolean | { forceRefresh?: boolean; timeoutMs?: number; cooldownMs?: number }
): Promise<Set<string>>;

/**
 * Round-robin through currently available OpenRouter free models.
 * Drop-in for the classic getNextOrModel() pattern.
 */
export function getNextFreeModel(
  apiKey: string,
  options?: { timeoutMs?: number; cooldownMs?: number }
): Promise<string>;

/** Reset the free-model round-robin index (call at the start of a batch). */
export function resetFreeModelIndex(): void;

/**
 * Record that a model failed the REAL call (generation/completion), not just
 * resolution. Every subsequent resolveModel() call for this provider, in
 * this process, will skip this id in favour of the next-best live candidate.
 *
 * Only mark for failures that are ABOUT THE MODEL (404 / 403) - not for 429,
 * 5xx or timeouts, which say nothing about the model.
 *
 * Deliberately in-memory/process-lifetime only - see the design comment
 * above _knownBad in index.js before adding persistence or a TTL here.
 * Not applicable to 'openrouter' (its free-tier round-robin already moves
 * on from a failing model via getNextFreeModel()'s own retry loop).
 */
export function markModelBad(
  provider: Exclude<Provider, 'openrouter'>,
  modelId: string
): void;

/** Clear all in-memory state: cached lists, known-bad models, fetch cool-downs (mainly for tests). */
export function clearCache(): void;

export const DEFAULT_FALLBACKS: Readonly<Record<Provider, string>>;
export const DEFAULT_TIMEOUT_MS: number;
export const DEFAULT_COOLDOWN_MS: number;

export const PREFERENCE: Readonly<
  Record<
    Exclude<Provider, 'openrouter'>,
    { include: RegExp; exclude: RegExp }
  >
>;
