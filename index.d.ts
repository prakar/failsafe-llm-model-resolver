/** llm-model-resolver */

export type Provider  = 'xai' | 'anthropic' | 'gemini' | 'openrouter';
export type ResolveSource = 'live' | 'pinned' | 'fallback';
export type OrderedBy = 'created' | 'version' | 'provider';

export interface ProviderConfig {
  pin?:      string | null;
  include?:  RegExp | null;
  exclude?:  RegExp | null;
  fallback?: string;
}

export interface GlobalConfig {
  timeoutMs?:  number;
  cooldownMs?: number;
  order?:      'newest' | 'oldest' | 'provider';
}

export interface Config {
  global?:    GlobalConfig;
  providers?: Partial<Record<Provider, ProviderConfig>>;
}

export interface ResolveOptions {
  forceRefresh?: boolean;
  fallback?:     string;
  order?:        'newest' | 'oldest' | 'provider';
  timeoutMs?:    number;
  cooldownMs?:   number;
}

export interface ResolveResult {
  id:        string;
  source:    ResolveSource;
  orderedBy: OrderedBy | null;
}

export type CandidateStatus = 'chosen' | 'eligible' | 'excluded' | 'not-matching' | 'known-bad';

export interface Candidate {
  id:         string;
  created:    string | null;
  generation: string | null;
  status:     CandidateStatus;
  rank:       number | null;
}

export type FallbackReason = 'no-key' | 'fetch-failed' | 'cooldown' | 'empty-list' | 'all-known-bad' | 'error';

export interface Inspection {
  provider:   Provider;
  id:         string;
  source:     ResolveSource;
  reason:     FallbackReason | null;
  orderedBy:  OrderedBy | null;
  tier:       1 | 2 | 3 | null;
  fallback:   string;
  error:      string | null;
  candidates: Candidate[];
}

/** Apply a config object. Clears the model-list cache. */
export function configure(cfg: Config): void;

/**
 * Load a YAML (.yml/.yaml) or JSON (.json) config file and apply it.
 * YAML requires js-yaml: npm install js-yaml
 */
export function loadConfig(filePath: string): Config;

/** Return the effective rules for a provider (reflects the active config). */
export function effectiveConfig(provider: Provider): Required<ProviderConfig>;

/** Resolve the best model ID for a provider. */
export function resolveModel(provider: Provider, apiKey: string | undefined | null, options?: ResolveOptions): Promise<ResolveResult>;

/** Explain a resolution: every listed model with status and recency signal. */
export function inspectModels(provider: Provider, apiKey: string | undefined | null, options?: ResolveOptions): Promise<Inspection>;

/** Fetch (and cache) the set of currently free OpenRouter model IDs. */
export function fetchFreeModels(apiKey: string, arg?: boolean | ResolveOptions): Promise<Set<string>>;

/** Round-robin through currently available OpenRouter free models. */
export function getNextFreeModel(apiKey: string, options?: ResolveOptions): Promise<string>;

/** Reset the free-model round-robin index (call at the start of a batch). */
export function resetFreeModelIndex(): void;

/**
 * Record that a model failed the REAL call (404/403 only — not 429 or 5xx).
 * Every subsequent resolveModel() for this provider skips it.
 */
export function markModelBad(provider: Exclude<Provider, 'openrouter'>, modelId: string): void;

/** Clear all in-memory state (mainly for tests). */
export function clearCache(): void;

/** Live view into the active config — reflects configure() immediately. */
export const DEFAULT_FALLBACKS:  Readonly<Record<Provider, string>>;
export const DEFAULT_TIMEOUT_MS:  number;
export const DEFAULT_COOLDOWN_MS: number;
export const PREFERENCE: Readonly<Record<Exclude<Provider,'openrouter'>, { include: RegExp | null; exclude: RegExp | null }>>;
