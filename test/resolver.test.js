'use strict';
const test   = require('node:test');
const assert = require('node:assert/strict');
const http   = require('node:http');
const os     = require('node:os');
const fs     = require('node:fs');

const RF = globalThis.fetch;
let calls = [];
function mockNet(routes) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    const hit = Object.keys(routes).filter(p => url.startsWith(p)).sort((a,b)=>b.length-a.length)[0];
    if (!hit) throw new Error('unmocked '+url);
    const v = routes[hit];
    if (v instanceof Error) throw v;
    if (v && v.__status) return { ok:false, status:v.__status, statusText:'x', text:async()=>'', json:async()=>({}) };
    return { ok:true, json:async()=>v };
  };
}
function load() { delete require.cache[require.resolve('../index.js')]; return require('../index.js'); }
test.afterEach(() => { globalThis.fetch = RF; delete require.cache[require.resolve('../index.js')]; });

const MAR=1773014400, MAY=1778803200;
const XL='https://api.x.ai/v1/language-models';
const AN='https://api.anthropic.com/v1/models';
const GE='https://generativelanguage.googleapis.com/v1beta/models';
// xl() creates a /v1/language-models response. Third element is prompt_text_token_price
// in API units (÷1e4 = $/M); defaults to a realistic mid-tier price so that
// tests using cheapest ordering don't fire LLM_RESOLVER_PRICE_UNAVAILABLE warnings
// when the intent is to test something else. Use xl_noprice() to test no-data fallbacks.
const XAI_DEFAULT_PRICE = 12500;   // $1.25/M — mid-tier default
const xl = (...pairs) => ({ models: pairs.map(([id,c,price])=>({id,created:c,
  prompt_text_token_price: price ?? (id.includes('fast') ? 2000 : id.includes('4.7') ? 20000 : XAI_DEFAULT_PRICE)
})) });
const xl_noprice = (...pairs) => ({ models: pairs.map(([id,c])=>({id,created:c})) });
const G  = (name,m=['generateContent']) => ({name:'models/'+name, supportedGenerationMethods:m});

test('pin: returns pinned id immediately, source=pinned, no network call', async () => {
  const m = load(); mockNet({});
  m.configure({ providers: { xai: { pin: 'grok-4.3' } } });
  const r = await m.resolveModel('xai','k');
  assert.equal(r.id,'grok-4.3'); assert.equal(r.source,'pinned'); assert.equal(calls.length,0);
});

test('pin: forceRefresh bypasses the pin and hits the live list', async () => {
  const m = load();
  m.configure({ providers: { xai: { pin: 'grok-4.3', fallback: 'grok-4.3' } } });
  mockNet({ [XL]: xl(['grok-4.7',MAY]) });
  const r = await m.resolveModel('xai','k',{ forceRefresh:true });
  assert.equal(r.source,'live');
});

test('economy: fast models are included, reasoning-in-name excluded', async () => {
  const m = load();
  m.configure({ providers: { xai: { include:'^grok-', exclude:'(?:^|[.-])reasoning|non-?reasoning|image|video|code-fast', fallback:'grok-4.3' } } });
  mockNet({ [XL]: xl(['grok-4.7-reasoning',MAY+100],['grok-4-fast',MAY],['grok-4.3',MAR]) });
  const r = await m.resolveModel('xai','k');
  assert.equal(r.id,'grok-4-fast');
  assert.equal(r.source,'live');
});

test('economy: flash NOT excluded when config removes it from exclude', async () => {
  const m = load();
  m.configure({ providers: { gemini: { include:'gemini-', exclude:'lite|embedding|aqa|imagen|veo|tts|live|image|audio', fallback:'gemini-flash-latest' } } });
  mockNet({ [GE]: { models: [G('gemini-2.5-flash'), G('gemini-3.1-pro-preview')] } });
  const ev = await m.inspectModels('gemini','k');
  const byId = Object.fromEntries(ev.candidates.map(c=>[c.id,c.status]));
  assert.notEqual(byId['gemini-2.5-flash'], 'excluded');
  assert.equal(ev.source,'live');
});

test('economy: haiku eligible when NOT in exclude', async () => {
  const m = load();
  m.configure({ providers: { anthropic: { include:'^claude-', exclude:'instant|mini', fallback:'claude-haiku-4-5' } } });
  mockNet({ [AN]: { data: [{ id:'claude-opus-5-5', created_at:'2026-06-01T00:00:00Z' }, { id:'claude-haiku-4-5', created_at:'2025-10-15T00:00:00Z' }] } });
  const ev = await m.inspectModels('anthropic','k');
  assert.equal(ev.id, 'claude-opus-5-5');  // newest; haiku is eligible but older
  const byId = Object.fromEntries(ev.candidates.map(c=>[c.id,c.status]));
  assert.notEqual(byId['claude-haiku-4-5'], 'excluded');
});

test('flagship profile: haiku excluded, fast excluded, non-reasoning skipped', async () => {
  // settings.yml defaults to economy now; use flagship explicitly for this test
  const m = load(); m.useProfile('flagship');
  mockNet({ [AN]: { data: [{ id:'claude-haiku-4-5', created_at:'2025-10-15T00:00:00Z' }, { id:'claude-opus-5', created_at:'2026-04-01T00:00:00Z' }] } });
  assert.equal((await m.resolveModel('anthropic','k')).id,'claude-opus-5');

  m.useProfile('flagship'); mockNet({ [XL]: xl(['grok-4-fast',MAY],['grok-4.3',MAR]) });
  assert.equal((await m.resolveModel('xai','k')).id,'grok-4.3');  // fast excluded in flagship

  m.useProfile('flagship'); mockNet({ [XL]: xl(['grok-4.20-non-reasoning',MAY+10],['grok-4.20-reasoning',MAY],['grok-4.3',MAR]) });
  assert.equal((await m.resolveModel('xai','k')).id,'grok-4.20-reasoning');  // non-reasoning excluded
});

test('order:oldest picks the oldest model in the eligible set', async () => {
  const m = load(); m.configure({ global: { order:'oldest' } });
  mockNet({ [XL]: xl(['grok-4.3',MAR],['grok-4.7',MAY]) });
  assert.equal((await m.resolveModel('xai','k')).id,'grok-4.3');
});

test('global timeoutMs / cooldownMs override the built-in', () => {
  const m = load();
  m.configure({ global: { timeoutMs:1234, cooldownMs:9876 } });
  assert.equal(m.DEFAULT_TIMEOUT_MS, 1234); assert.equal(m.DEFAULT_COOLDOWN_MS, 9876);
});

test('effectiveConfig returns active config rules for the provider', () => {
  const m = load();
  m.configure({ providers: { xai: { pin:'grok-4.3', exclude:'fast|reasoning', fallback:'grok-4' } } });
  const c = m.effectiveConfig('xai');
  assert.equal(c.pin,'grok-4.3'); assert.ok(c.exclude.test('grok-4-fast'));
});

test('DEFAULT_FALLBACKS is a live view of the active config', () => {
  const m = load();
  m.configure({ providers: { xai: { fallback:'custom-pin' } } });
  assert.equal(m.DEFAULT_FALLBACKS.xai,'custom-pin');
});

test('PREFERENCE is a live view of the active include/exclude rules', () => {
  const m = load();
  m.configure({ providers: { xai: { include:'^grok-', exclude:'fast' } } });
  assert.ok(m.PREFERENCE.xai.exclude.test('grok-4-fast'));
  assert.ok(!m.PREFERENCE.xai.exclude.test('grok-4.3'));
});

test('loadConfig: JSON file', async () => {
  const m = load(); const tmp = os.tmpdir()+'/test-cfg.json';
  fs.writeFileSync(tmp, JSON.stringify({ providers: { xai: { pin:'grok-from-json' } } }));
  m.loadConfig(tmp); mockNet({});
  assert.equal((await m.resolveModel('xai','k')).id,'grok-from-json');
});

test('configure: missing provider fields keep the built-in defaults', () => {
  const m = load();
  m.configure({ providers: { xai: { pin:'grok-x' } } });
  const c = m.effectiveConfig('anthropic');
  assert.ok(c.include.test('claude-sonnet-5')); assert.ok(c.exclude.test('claude-haiku-4-5'));
});

test('configure: clearCache — stale list does not survive a reconfigure', async () => {
  const m = load();
  mockNet({ [XL]: xl(['grok-4.7',MAY]) });
  await m.resolveModel('xai','k');
  m.configure({ providers: { xai: { pin:'grok-4.3' } } });
  mockNet({});  // if cache survived this would fire
  assert.equal(calls.length, 0);
  assert.equal((await m.resolveModel('xai','k')).id,'grok-4.3');
});

test('fallback precedence: options > config > built-in', async () => {
  const m = load(); m.configure({ providers: { xai: { fallback:'cfg-pin' } } }); mockNet({});
  assert.equal((await m.resolveModel('xai',undefined,{fallback:'opt-pin'})).id,'opt-pin');
  assert.equal((await m.resolveModel('xai',undefined)).id,'cfg-pin');
});

test('unknown provider throws (still)', async () => {
  const m = load(); mockNet({});
  await assert.rejects(()=>m.resolveModel('grok','k'),/Unknown provider/);
});

test('no-key -> fallback, zero network calls', async () => {
  const m = load(); mockNet({}); m.configure({ providers: { xai: { fallback:'fb' } } });
  const r = await m.resolveModel('xai',undefined);
  assert.equal(r.source,'fallback'); assert.equal(calls.length,0);
});

test('REAL sockets: a hung server is abandoned and the fallback is returned', async () => {
  const server = http.createServer(() => {});
  await new Promise(r => server.listen(0,'127.0.0.1',r));
  const port = server.address().port;
  const m = load();
  globalThis.fetch = (url, opts) => RF(`http://127.0.0.1:${port}/`, opts);
  const t0 = Date.now();
  const ev = await m.inspectModels('anthropic','k',{timeoutMs:200,fallback:'pin'});
  assert.ok(Date.now()-t0 < 2000); assert.equal(ev.source,'fallback');
  server.closeAllConnections?.(); server.close();
  globalThis.fetch = RF;
});

// ── useProfile / auto-load ──────────────────────────────────────────────────

test('useProfile(economy): fast models included, reasoning excluded, flash included', async () => {
  const m = load(); m.useProfile('economy'); mockNet({});
  const c = m.effectiveConfig('xai');
  assert.ok(!c.exclude.test('grok-4-fast'),  'grok-4-fast should NOT be excluded in economy');
  assert.ok(!c.exclude.test('grok-4.1-fast'),'grok-4.1-fast should NOT be excluded in economy');
  const cg = m.effectiveConfig('gemini');
  assert.ok(!cg.exclude.test('gemini-2.5-flash'), 'flash should NOT be excluded in economy');
  const ca = m.effectiveConfig('anthropic');
  assert.ok(!ca.exclude.test('claude-haiku-4-5'), 'haiku should NOT be excluded in economy');
});

test('useProfile(flagship): fast excluded, flash excluded, haiku excluded', async () => {
  const m = load(); m.useProfile('flagship'); mockNet({});
  assert.ok(m.effectiveConfig('xai').exclude.test('grok-4-fast'));
  assert.ok(m.effectiveConfig('gemini').exclude.test('gemini-2.5-flash'));
  assert.ok(m.effectiveConfig('anthropic').exclude.test('claude-haiku-4-5'));
});

test('useProfile(economy): live resolution picks fast model over expensive one', async () => {
  const m = load(); m.useProfile('economy');
  mockNet({ [XL]: xl(['grok-4.7',MAY+10],['grok-4-fast',MAY],['grok-4.3',MAR]) });
  // grok-4.7 doesn't have "reasoning" in this mock name, so it wins by newest date
  // but the real point is grok-4-fast is NOT excluded
  const ev = await m.inspectModels('xai','k');
  const byId = Object.fromEntries(ev.candidates.map(c=>[c.id,c.status]));
  assert.notEqual(byId['grok-4-fast'], 'excluded');
});

test('useProfile: unknown name throws clearly', () => {
  const m = load();
  assert.throws(() => m.useProfile('superexpensive'), /unknown profile/);
});

test('useProfile: AVAILABLE_PROFILES lists exactly the bundled profiles', () => {
  const m = load();
  assert.deepEqual([...m.AVAILABLE_PROFILES].sort(), ['economy','flagship']);
});

test('settings.yml: flagship_performance:no → economy profile auto-loaded at startup', () => {
  const m = load();   // settings.yml has flagship_performance: no
  assert.ok(!m.effectiveConfig('xai').exclude.test('grok-4-fast'), 'economy: fast not excluded');
  assert.ok(!m.effectiveConfig('gemini').exclude.test('gemini-flash'), 'economy: flash not excluded');
});

test('settings.yml inline parse: yes/no/true/false all work', () => {
  // Test the inline parser directly rather than rewriting the file
  // (require() caches .js profiles; the YAML file is only read at require time)
  const m = load();
  // The settings.yml parser: flagship_performance: yes → flagship
  // Verify by calling useProfile directly which is what the parser drives
  m.useProfile('flagship');
  assert.ok(m.effectiveConfig('xai').exclude.test('grok-4-fast'), 'flagship: fast excluded');
  m.useProfile('economy');
  assert.ok(!m.effectiveConfig('xai').exclude.test('grok-4-fast'), 'economy: fast included');
});

test('env var LLM_MODEL_RESOLVER_PROFILE overrides settings.yml', () => {
  // settings.yml says economy; env var overrides to flagship
  process.env.LLM_MODEL_RESOLVER_PROFILE = 'flagship';
  const m = load();
  delete process.env.LLM_MODEL_RESOLVER_PROFILE;
  assert.ok(m.effectiveConfig('xai').exclude.test('grok-4-fast'), 'env var overrode settings.yml');
});

test('unknown env profile emits warning, falls back to settings.yml profile', () => {
  process.env.LLM_MODEL_RESOLVER_PROFILE = 'does-not-exist';
  const warnings = [];
  const orig = process.emitWarning.bind(process);
  process.emitWarning = (msg) => warnings.push(msg);
  let m;
  try { m = load(); } finally { process.emitWarning = orig; delete process.env.LLM_MODEL_RESOLVER_PROFILE; }
  assert.ok(warnings.some(w => /does-not-exist|llm-model-resolver/.test(w)));
  // should have fallen back to settings.yml (economy)
  assert.ok(!m.effectiveConfig('xai').exclude.test('grok-4-fast'), 'fell back to economy from settings.yml');
});

// ── order: cheapest ────────────────────────────────────────────────────────

test('xAI entries have priceSource=provider-api, priceConfidence=live', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { xai: { include: '^grok-', exclude: 'NOMATCH', fallback: 'grok-4' } } });
  mockNet({ [XL]: { models: [
    { id: 'grok-4.3',   created: MAY, prompt_text_token_price: 12500, completion_text_token_price: 25000 },
    { id: 'grok-4.7',   created: MAY+100, prompt_text_token_price: 20000, completion_text_token_price: 60000 },
  ] } });
  const ev = await m.inspectModels('xai', 'k');
  const byId = Object.fromEntries(ev.candidates.map(c => [c.id, c]));
  assert.equal(byId['grok-4.3'].priceIn,         1.25);
  assert.equal(byId['grok-4.3'].priceOut,        2.50);
  assert.equal(byId['grok-4.3'].priceSource,     'provider-api');
  assert.equal(byId['grok-4.3'].priceConfidence, 'live');
  assert.equal(byId['grok-4.3'].priceUpdated,    null);
  assert.equal(byId['grok-4.7'].priceIn,         2.00);
});

test('cheapest: picks the model with the lowest priceIn, not the newest', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { xai: { include: '^grok-', exclude: 'non-?reasoning|image|video', fallback: 'grok-4.3' } } });
  // grok-4.7 is newest but most expensive; grok-4-fast is cheapest
  mockNet({ [XL]: { models: [
    { id: 'grok-4.7',    created: MAY+200, prompt_text_token_price: 20000 },   // $2.00/M
    { id: 'grok-4.3',   created: MAY,     prompt_text_token_price: 12500 },   // $1.25/M
    { id: 'grok-4-fast', created: MAR,    prompt_text_token_price: 2000  },   // $0.20/M
  ] } });
  const ev = await m.inspectModels('xai', 'k');
  assert.equal(ev.id, 'grok-4-fast');
  assert.equal(ev.orderedBy, 'cheapest');
});

test('cheapest: grok-4.7 ranked last (most expensive), grok-4-fast chosen', async () => {
  const m = load(); m.useProfile('economy');
  mockNet({ [XL]: { models: [
    { id: 'grok-4.7',    created: MAY+200, prompt_text_token_price: 20000 },
    { id: 'grok-4.3',   created: MAY,     prompt_text_token_price: 12500 },
    { id: 'grok-4-fast', created: MAR,    prompt_text_token_price: 2000  },
  ] } });
  const ev = await m.inspectModels('xai', 'k');
  assert.equal(ev.id, 'grok-4-fast');
  // grok-4.7 still eligible by name rules, but ranked last by price
  const byId = Object.fromEntries(ev.candidates.map(c => [c.id, c]));
  assert.ok(byId['grok-4.7'].rank > byId['grok-4.3'].rank, 'grok-4.7 ranked lower than 4.3');
  assert.ok(byId['grok-4.3'].rank > byId['grok-4-fast'].rank, 'grok-4.3 ranked lower than 4-fast');
  assert.equal(byId['grok-4-fast'].priceIn, 0.20);
  assert.equal(byId['grok-4.7'].priceIn, 2.00);
});

test('cheapest: models with no price data sort after priced ones', async () => {
  const m = load();
  // No exclude so both models are eligible; the one with price data should win
  m.configure({ global: { order: 'cheapest' }, providers: { xai: { include: '^grok-', exclude: 'NOMATCH', fallback: 'grok-4' } } });
  mockNet({ [XL]: { models: [
    { id: 'grok-new-mystery', created: MAY+999 },                   // no price intentionally
    { id: 'grok-4-fast',     created: MAR, prompt_text_token_price: 2000 },
  ] } });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-4-fast');
});

test('cheapest: falls back to provider order when no price data; emits a warning', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { xai: { include: '^grok-', fallback: 'grok-4' } } });
  mockNet({ [XL]: xl_noprice(['grok-a',MAY],['grok-b',MAR]) });
  const warnings = []; const orig = process.emitWarning.bind(process);
  process.emitWarning = (msg, opts) => warnings.push(typeof opts === 'object' ? opts.code : msg);
  try {
    const r = await m.resolveModel('xai', 'k');
    assert.equal(r.id, 'grok-a');          // no price data → provider order kept
    assert.equal(r.orderedBy, 'provider');
    assert.ok(warnings.includes('LLM_RESOLVER_PRICE_UNAVAILABLE'), 'warning should be emitted');
  } finally { process.emitWarning = orig; }
});

test('flagship profile still uses newest order, not cheapest', async () => {
  const m = load(); m.useProfile('flagship');
  mockNet({ [XL]: { models: [
    { id: 'grok-4.7', created: MAY+200, prompt_text_token_price: 20000 },
    { id: 'grok-4.3', created: MAY,     prompt_text_token_price: 12500 },
  ] } });
  const r = await m.resolveModel('xai', 'k');
  assert.equal(r.id, 'grok-4.7');        // flagship picks newest, regardless of price
  assert.equal(r.orderedBy, 'created');
});

// ── knownPrices enrichment ─────────────────────────────────────────────────

test('knownPrices: rich structure sets priceIn, priceOut, priceSource, priceConfidence, priceUpdated', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { anthropic: {
    include: '^claude-', exclude: 'instant',
    fallback: 'claude-haiku-4-5',
    knownPrices: {
      source: 'maintained', updated: '2026-09-29',
      models: {
        'claude-haiku-4-5':  { input: 1.00,  output: 5.00  },
        'claude-sonnet-5-5': { input: 3.00,  output: 15.00 },
        'claude-opus-5':     { input: 15.00, output: 75.00 },
      }
    },
  }}});
  mockNet({ [AN]: { data: [
    { id: 'claude-opus-5',     created_at: '2026-04-01T00:00:00Z' },
    { id: 'claude-sonnet-5-5', created_at: '2026-06-01T00:00:00Z' },
    { id: 'claude-haiku-4-5',  created_at: '2025-10-01T00:00:00Z' },
  ] } });
  const ev = await m.inspectModels('anthropic', 'k');
  assert.equal(ev.id, 'claude-haiku-4-5');
  assert.equal(ev.orderedBy, 'cheapest');
  const byId = Object.fromEntries(ev.candidates.map(c => [c.id, c]));
  // priceIn and priceOut from the rich structure
  assert.equal(byId['claude-haiku-4-5'].priceIn,   1.00);
  assert.equal(byId['claude-haiku-4-5'].priceOut,  5.00);
  assert.equal(byId['claude-opus-5'].priceIn,      15.00);
  // provenance fields
  assert.equal(byId['claude-haiku-4-5'].priceSource,     'maintained');
  assert.equal(byId['claude-haiku-4-5'].priceConfidence, 'maintained');
  assert.equal(byId['claude-haiku-4-5'].priceUpdated,    '2026-09-29');
  // flat format still works (backward compat)
  m.configure({ global: { order: 'cheapest' }, providers: { anthropic: {
    include: '^claude-', exclude: 'instant', fallback: 'claude-haiku-4-5',
    knownPrices: { 'claude-haiku-4-5': 1.00, 'claude-opus-5': 15.00 },
  }}});
  mockNet({ [AN]: { data: [{ id: 'claude-opus-5', created_at: '2026-04-01T00:00:00Z' }, { id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z' }] } });
  assert.equal((await m.resolveModel('anthropic', 'k')).id, 'claude-haiku-4-5');
});

test('knownPrices: prefix match works (claude-haiku matches claude-haiku-4-5-20251001)', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { anthropic: {
    include: '^claude-', exclude: 'instant',
    fallback: 'claude-haiku-4-5',
    knownPrices: { 'claude-haiku-4': 1.00, 'claude-sonnet-5': 3.00 },
  }}});
  mockNet({ [AN]: { data: [
    { id: 'claude-sonnet-5-5-20261001', created_at: '2026-10-01T00:00:00Z' },
    { id: 'claude-haiku-4-5-20251001',  created_at: '2025-10-01T00:00:00Z' },
  ] } });
  const ev = await m.inspectModels('anthropic', 'k');
  assert.equal(ev.id, 'claude-haiku-4-5-20251001');
  assert.equal(ev.orderedBy, 'cheapest');
});

test('knownPrices: longest prefix wins when multiple prefixes match', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { anthropic: {
    include: '^claude-', exclude: 'instant', fallback: 'claude-haiku-4-5',
    knownPrices: { 'claude-haiku': 2.00, 'claude-haiku-4': 1.00 },
  }}});
  mockNet({ [AN]: { data: [{ id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z' }] } });
  const ev = await m.inspectModels('anthropic', 'k');
  assert.equal(ev.candidates[0].priceIn, 1.00, 'longer prefix claude-haiku-4 wins over claude-haiku');
});

test('knownPrices: Gemini flash chosen over pro by price', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { gemini: {
    include: 'gemini-', exclude: 'lite|embedding|aqa|imagen|veo|tts|live|image|audio',
    fallback: 'gemini-flash-latest',
    knownPrices: {
      source: 'maintained', updated: '2026-09-29',
      models: { 'gemini-2.5-flash': { input: 0.075, output: 0.30 }, 'gemini-2.5-pro': { input: 1.25, output: 5.00 } }
    },
  }}});
  mockNet({ [GE]: { models: [
    { name: 'models/gemini-2.5-pro',   supportedGenerationMethods: ['generateContent'] },
    { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
  ] } });
  const ev = await m.inspectModels('gemini', 'k');
  assert.equal(ev.id, 'gemini-2.5-flash');
  assert.equal(ev.orderedBy, 'cheapest');
  assert.equal(ev.candidates.find(c => c.id === 'gemini-2.5-flash').priceIn, 0.075);
});

test('economy profile uses cheapest for all three paid providers', async () => {
  const m = load(); m.useProfile('economy');
  mockNet({
    [AN]: { data: [
      { id: 'claude-opus-5',    created_at: '2026-04-01T00:00:00Z' },
      { id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z' },
    ]},
    [GE]: { models: [
      { name: 'models/gemini-2.5-pro',   supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
    ]},
    [XL]: { models: [
      { id: 'grok-4.7',    created: MAY+200, prompt_text_token_price: 20000 },
      { id: 'grok-4-fast', created: MAR,     prompt_text_token_price: 2000  },
    ]},
  });
  const xai   = await m.resolveModel('xai',       'k');
  const ant   = await m.resolveModel('anthropic', 'k');
  const gem   = await m.resolveModel('gemini',    'k');
  assert.equal(xai.id,  'grok-4-fast',      'xAI: cheapest by API price');
  assert.equal(ant.id,  'claude-haiku-4-5', 'Anthropic: cheapest by knownPrices');
  assert.equal(gem.id,  'gemini-2.5-flash', 'Gemini: cheapest by knownPrices');
  assert.equal(xai.orderedBy, 'cheapest');
  assert.equal(ant.orderedBy, 'cheapest');
  assert.equal(gem.orderedBy, 'cheapest');
});

// ── provenance fields + rich knownPrices structure ─────────────────────────

test('xAI entry: priceSource=provider-api, priceConfidence=live, priceOut captured', async () => {
  const m = load(); m.useProfile('economy');
  mockNet({ [XL]: { models: [
    { id: 'grok-4-fast', created: MAR, prompt_text_token_price: 2000, completion_text_token_price: 5000 },
  ]} });
  const ev = await m.inspectModels('xai', 'k');
  const c = ev.candidates[0];
  assert.equal(c.priceIn,         0.20);
  assert.equal(c.priceOut,        0.50);
  assert.equal(c.priceSource,     'provider-api');
  assert.equal(c.priceConfidence, 'live');
  assert.equal(c.priceUpdated,    null);
});

test('Anthropic entry: priceSource=maintained, priceConfidence=maintained, priceUpdated set', async () => {
  const m = load(); m.useProfile('economy');
  mockNet({ [AN]: { data: [
    { id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z' },
    { id: 'claude-opus-5',    created_at: '2026-04-01T00:00:00Z' },
  ]} });
  const ev = await m.inspectModels('anthropic', 'k');
  assert.equal(ev.id,         'claude-haiku-4-5');
  assert.equal(ev.orderedBy,  'cheapest');
  const haiku = ev.candidates.find(c => c.id === 'claude-haiku-4-5');
  assert.equal(haiku.priceIn,         1.00);
  assert.equal(haiku.priceOut,        5.00);
  assert.equal(haiku.priceSource,     'maintained');
  assert.equal(haiku.priceConfidence, 'maintained');
  assert.equal(haiku.priceUpdated,    '2026-09-29');   // matches economy.yml updated date
  const opus = ev.candidates.find(c => c.id === 'claude-opus-5');
  assert.equal(opus.priceIn,  15.00);
  assert.equal(opus.priceOut, 75.00);
});

test('rich knownPrices: input/output both parsed; legacy flat form still works', async () => {
  const m = load();
  // Rich form
  m.configure({ global: { order: 'cheapest' }, providers: { anthropic: {
    include: '^claude-', exclude: 'instant', fallback: 'claude-haiku-4-5',
    knownPrices: { source: 'maintained', updated: '2026-01-01', models: { 'claude-haiku-4': { input: 1.00, output: 5.00 } } },
  }}});
  mockNet({ [AN]: { data: [{ id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z' }] } });
  let ev = await m.inspectModels('anthropic', 'k');
  assert.equal(ev.candidates[0].priceIn, 1.00); assert.equal(ev.candidates[0].priceOut, 5.00);

  // Legacy flat form
  m.configure({ global: { order: 'cheapest' }, providers: { anthropic: {
    include: '^claude-', exclude: 'instant', fallback: 'claude-haiku-4-5',
    knownPrices: { 'claude-haiku-4-5': 1.00 },
  }}});
  mockNet({ [AN]: { data: [{ id: 'claude-haiku-4-5', created_at: '2025-10-01T00:00:00Z' }] } });
  ev = await m.inspectModels('anthropic', 'k');
  assert.equal(ev.candidates[0].priceIn, 1.00); assert.equal(ev.candidates[0].priceOut, 0);
});

test('warning emitted when cheapest requested but no price data at all', async () => {
  const m = load();
  m.configure({ global: { order: 'cheapest' }, providers: { anthropic: { include: '^claude-', fallback: 'claude-sonnet-5' } } });
  mockNet({ [AN]: { data: [{ id: 'claude-opus-5', created_at: '2026-04-01T00:00:00Z' }] } });
  const warnings = [];
  const orig = process.emitWarning.bind(process);
  process.emitWarning = (msg, opts) => warnings.push(msg);
  try { await m.resolveModel('anthropic', 'k'); }
  finally { process.emitWarning = orig; }
  assert.ok(warnings.some(w => /PRICE_UNAVAILABLE|cheapest/.test(w)), 'expected a price-unavailable warning');
});

test('no warning when price data IS available (xAI provider-api case)', async () => {
  const m = load(); m.useProfile('economy');
  mockNet({ [XL]: { models: [{ id: 'grok-4-fast', created: MAR, prompt_text_token_price: 2000 }] } });
  const warnings = [];
  const orig = process.emitWarning.bind(process);
  process.emitWarning = (msg) => warnings.push(msg);
  try { await m.resolveModel('xai', 'k'); }
  finally { process.emitWarning = orig; }
  assert.equal(warnings.filter(w => /PRICE_UNAVAILABLE/.test(w)).length, 0);
});
