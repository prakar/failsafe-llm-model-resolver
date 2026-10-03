#!/usr/bin/env node
/**
 * inspect.js — show WHY llm-model-resolver picked a model, using your real keys.
 *
 *   node inspect.js xai
 *   node inspect.js anthropic --all           show every listed model, not just the top 25
 *   node inspect.js gemini --order newest     override the profile's order for this run
 *   node inspect.js xai --force               bypass cache / cool-down
 *
 * Keys come from the environment (XAI_API_KEY or GROK_API_KEY, ANTHROPIC_API_KEY,
 * GEMINI_API_KEY, OPENROUTER_API_KEY). With Node >= 20.6 you can use a .env file:
 *   node --env-file=.env inspect.js xai
 *
 * Not published to npm — lives in the repo for verifying live resolution decisions,
 * especially after editing profiles/economy.yml.
 */
'use strict';
const { inspectModels, effectiveConfig, DEFAULT_TIMEOUT_MS } = require('./index.js');

const KEYS = {
  xai:        () => process.env.XAI_API_KEY || process.env.GROK_API_KEY,
  anthropic:  () => process.env.ANTHROPIC_API_KEY,
  gemini:     () => process.env.GEMINI_API_KEY,
  openrouter: () => process.env.OPENROUTER_API_KEY,
};
const KEY_HINT = {
  xai: 'XAI_API_KEY (or GROK_API_KEY)', anthropic: 'ANTHROPIC_API_KEY',
  gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY',
};

const args     = process.argv.slice(2);
const provider = args.find(a => !a.startsWith('--'));
const flag     = name => args.includes('--' + name);
const orderIdx = args.indexOf('--order');
const order    = orderIdx >= 0 ? args[orderIdx + 1] : undefined;

if (!provider || !KEYS[provider]) {
  console.error('usage: node inspect.js <xai|anthropic|gemini|openrouter> [--all] [--force] [--order newest|oldest|cheapest|provider]');
  process.exit(2);
}
const key = KEYS[provider]();
if (!key) {
  console.error(`No API key found. Set ${KEY_HINT[provider]} in the environment.`);
  process.exit(1);
}

(async () => {
  const t0 = Date.now();
  const ev = await inspectModels(provider, key, { forceRefresh: flag('force'), order });
  const ms = Date.now() - t0;
  const pc = effectiveConfig(provider);

  console.log(`provider     ${ev.provider}`);
  console.log(`chosen       ${ev.id}   (${ev.source}${ev.reason ? ', reason: ' + ev.reason : ''})`);
  console.log(`ordered by   ${ev.orderedBy || '-'}${ev.tier ? `   (rule tier ${ev.tier})` : ''}`);
  if (pc.pin) console.log(`pin          ${pc.pin}   (bypasses live list; use --force to override)`);
  console.log(`fallback     ${ev.fallback}`);
  console.log(`request      ${ms}ms  (timeout ${process.env.LLM_MODEL_RESOLVER_TIMEOUT_MS || DEFAULT_TIMEOUT_MS}ms)`);
  if (ev.error) console.log(`error        ${ev.error}`);
  if (pc.include) console.log(`include      ${pc.include}`);
  if (pc.exclude) console.log(`exclude      ${pc.exclude}`);
  if (pc.knownPrices) {
    const src = pc.knownPrices.source || 'maintained';
    const upd = pc.knownPrices.updated ? `, updated ${pc.knownPrices.updated}` : '';
    console.log(`prices       ${src}${upd}`);
  }

  const rows = flag('all') ? ev.candidates : ev.candidates.slice(0, 25);
  if (!rows.length) { console.log('\n(no models listed)'); return; }

  const wId    = Math.max(...rows.map(r => r.id.length), 5);
  const hasPrice = rows.some(r => r.priceIn != null);

  const header = ['rank', 'status'.padEnd(12), 'model'.padEnd(wId),
    hasPrice ? '$/M in  ' : null,
    'created / generation',
    hasPrice ? 'source' : null,
  ].filter(Boolean).join('  ');
  console.log('\n' + header);

  for (const r of rows) {
    const when  = r.created ? r.created.slice(0, 10) : (r.generation ? 'gen ' + r.generation : '-');
    const price = r.priceIn != null ? ('$' + r.priceIn.toFixed(3)).padEnd(8) : '        ';
    const src   = r.priceSource === 'provider-api' ? 'live' : r.priceSource === 'maintained' ? `maintained (${r.priceUpdated || '?'})` : '';
    const cols  = [
      String(r.rank ?? '').padStart(4),
      r.status.padEnd(12),
      r.id.padEnd(wId),
      hasPrice ? price : null,
      when,
      hasPrice ? src : null,
    ].filter(Boolean);
    console.log(cols.join('  '));
  }
  if (rows.length < ev.candidates.length) {
    console.log(`\n... ${ev.candidates.length - rows.length} more (use --all)`);
  }
})().catch(e => { console.error(e); process.exit(1); });
