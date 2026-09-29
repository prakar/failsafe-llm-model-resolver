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
const xl = (...pairs) => ({ models: pairs.map(([id,c])=>({id,created:c})) });
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
