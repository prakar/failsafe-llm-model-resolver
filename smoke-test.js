/**
 * smoke-test.js – run with:  node smoke-test.js
 *
 * Without real API keys the module correctly returns the env/hard-coded
 * fallbacks.  With keys present it will exercise the live paths.
 *
 *   XAI_API_KEY=... ANTHROPIC_API_KEY=... GEMINI_API_KEY=... OPENROUTER_API_KEY=... node smoke-test.js
 */

'use strict';

const {
  resolveModel,
  fetchFreeModels,
  getNextFreeModel,
  resetFreeModelIndex,
  clearCache,
  DEFAULT_FALLBACKS,
} = require('./');

async function run() {
  console.log('=== self-healing-models smoke test ===\n');
  console.log('Default fallbacks:', DEFAULT_FALLBACKS);
  console.log('');

  const keys = {
    xai:        process.env.XAI_API_KEY || process.env.GROK_API_KEY,
    anthropic:  process.env.ANTHROPIC_API_KEY,
    gemini:     process.env.GEMINI_API_KEY,
    openrouter: process.env.OPENROUTER_API_KEY,
  };

  for (const [provider, key] of Object.entries(keys)) {
    const result = await resolveModel(provider, key);
    console.log(`${provider.padEnd(12)} → ${result.id}  (${result.source})${key ? '' : '  [no key]'}`);
  }

  console.log('\n--- OpenRouter free round-robin ---');
  if (keys.openrouter) {
    resetFreeModelIndex();
    const free = await fetchFreeModels(keys.openrouter);
    console.log(`Free models available: ${free.size}`);
    for (let i = 0; i < Math.min(5, free.size || 1); i++) {
      const m = await getNextFreeModel(keys.openrouter);
      console.log(`  next → ${m}`);
    }
  } else {
    console.log('(skipped – no OPENROUTER_API_KEY)');
  }

  console.log('\nDone.');
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
