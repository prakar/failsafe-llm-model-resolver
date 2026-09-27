/**
 * self-healing-models
 *
 * Self-healing, failsafe resolver for the current frontier model.
 */

export type Provider = 'xai' | 'anthropic' | 'gemini' | 'openrouter';

export type ResolveSource = 'live' | 'fallback';

export interface ResolveResult {
  /** Model ID ready to pass to the provider's chat/completions endpoint */
  id: string;
  /** Whether the ID came from a live /models fetch or from a pinned fallback */
  source: ResolveSource;
}

export interface ResolveOptions {
  /** Bypass the in-memory process cache */
  forceRefresh?: boolean;
  /** Override the env/hard-coded fallback for this call only */
  fallback?: string;
}

/**
 * Resolve the best model ID for a provider.
 *
 * Paid providers use live /models + preference rules (newest non-fast/non-mini).
 * OpenRouter returns the first currently free model.
 * On any failure (network, auth, empty list) returns the env-configured fallback
 * so a transient hiccup never kills a batch job.
 */
export function resolveModel(
  provider: Provider,
  apiKey: string | undefined | null,
  options?: ResolveOptions
): Promise<ResolveResult>;

/**
 * Fetch (and cache) the set of currently free OpenRouter model IDs.
 * Drop-in for the classic fetchOrFreeModels() pattern.
 */
export function fetchFreeModels(
  apiKey: string,
  forceRefresh?: boolean
): Promise<Set<string>>;

/**
 * Round-robin through currently available OpenRouter free models.
 * Drop-in for the classic getNextOrModel() pattern.
 */
export function getNextFreeModel(apiKey: string): Promise<string>;

/** Reset the free-model round-robin index (call at the start of a batch). */
export function resetFreeModelIndex(): void;

/**
 * Record that a model failed the REAL call (generation/completion), not just
 * resolution. Every subsequent resolveModel() call for this provider, in
 * this process, will skip this id in favour of the next-best live candidate.
 * Deliberately in-memory/process-lifetime only - see the design comment
 * above _knownBad in index.js before adding persistence or a TTL here.
 * Not applicable to 'openrouter' (its free-tier round-robin already moves
 * on from a failing model via getNextFreeModel()'s own retry loop).
 */
export function markModelBad(
  provider: Exclude<Provider, 'openrouter'>,
  modelId: string
): void;

/** Clear all in-memory caches, including known-bad models (mainly for tests). */
export function clearCache(): void;

export const DEFAULT_FALLBACKS: Readonly<Record<Provider, string>>;

export const PREFERENCE: Readonly<
  Record<
    Exclude<Provider, 'openrouter'>,
    { include: RegExp; exclude: RegExp }
  >
>;
