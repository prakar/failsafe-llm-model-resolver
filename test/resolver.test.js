'use strict';
// Run: npm test   (Node's built-in runner; no dependencies, no network, no keys)
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');

const ENV_KEYS = [
  'XAI_MODEL_FALLBACK', 'GROK_MODEL_FALLBACK', 'ANTHROPIC_MODEL_FALLBACK', 'GEMINI_MODEL_FALLBACK',
  'OPENROUTER_MODEL_FALLBACK', 'OPENROUTER_FREE_FALLBACK', 'LLM_MODEL_RESOLVER_TIMEOUT_MS',
];
const realFetch = globalThis.fetch;
const realNow = Date.now;

/** Fresh module instance (module state is per-process), with a controlled env. */
function load(env = {}) {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, env);
  delete require.cache[require.resolve('../index.js')];
  return require('../index.js');
}

const XAI_LANG = 'https://api.x.ai/v1/language-models';
const XAI_ALL  = 'https://api.x.ai/v1/models';
const ANT      = 'https://api.anthropic.com/v1/models';
const GEM      = 'https://generativelanguage.googleapis.com/v1beta/models';
const OR       = 'https://openrouter.ai/api/v1/models';

let calls = [];
/**
 * Route table by URL prefix. A value can be: a JSON object (200), an Error (thrown),
 * { __status: n } (HTTP error), or a function (url, opts) => Promise for custom behavior.
 * Longest matching prefix wins, so '/v1/language-models' and '/v1/models' don't collide.
 */
function mockNet(routes) {
  calls = [];
  globalThis.fetch = async (url, opts) => {
    calls.push(url);
    const hit = Object.keys(routes).filter(p => url.startsWith(p)).sort((a, b) => b.length - a.length)[0];
    if (!hit) throw new Error('unmocked url ' + url);
    const v = routes[hit];
    if (typeof v === 'function') return v(url, opts);
    if (v instanceof Error) throw v;
    if (v && v.__status) return { ok: false, status: v.__status, statusText: 'x', text: async () => '', json: async () => ({}) };
    return { ok: true, json: async () => v };
  };
}
/**
 * Every test goes through this: it restores fetch and the clock in a finally block, so a failing
 * test can never leak a mock into the next one. (Deliberately not a global afterEach hook - hook
 * semantics differ across the Node versions this package supports.)
 */
function it(name, fn) {
  return test(name, async (t) => {
    try { await fn(t); } finally { globalThis.fetch = realFetch; Date.now = realNow; }
  });
}

const xaiLang = models => ({ models: models.map(([id, created]) => ({ id, created })) });
const xaiAll  = models => ({ data:   models.map(([id, created]) => ({ id, created, object: 'model', owned_by: 'xai' })) });
const G = (name, methods = ['generateContent']) => ({ name: 'models/' + name, supportedGenerationMethods: methods });
const stall = (ms) => new Promise(r => setTimeout(r, ms));
/** A fetch that never answers but, like real fetch, honors the AbortSignal it was given. */
const hang = (_url, opts) => new Promise((_, reject) => {
  // A real connection holds the event loop open; AbortSignal.timeout's own timer is deliberately
  // unref'd, so without this the runner sees "nothing left to do" and cancels the remaining tests.
  const keepAlive = setTimeout(() => {}, 30_000);
  opts.signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(opts.signal.reason); });
});

// 2026-03-09 and 2026-05-15 as Unix seconds
const MAR = 1773014400, MAY = 1778803200;

// ───────────────────────────── ordering ─────────────────────────────

it('xAI: sorts by created - the more recently created model wins even when its number is LOWER as a dotted version (4.3 < 4.20)', async () => {
  const m = load();
  // Why parsing versions out of xAI IDs is unsafe: as dotted versions 4.20 > 4.3, whatever the release order.
  const naive = ['4.20', '4.3'].sort((a, b) => b.split('.').map(Number).reduce((d, x, i) => d || x - a.split('.').map(Number)[i], 0))[0];
  assert.equal(naive, '4.20', 'premise: a naive version sort would pick the OLDER model');

  mockNet({ [XAI_LANG]: xaiLang([['grok-4.20-0309-reasoning', MAR], ['grok-4.3', MAY]]) });
  const r = await m.resolveModel('xai', 'k');
  assert.equal(r.id, 'grok-4.3');
  assert.equal(r.source, 'live');
  assert.equal(r.orderedBy, 'created');
});

it("order:'provider' restores first-in-list", async () => {
  const m = load();
  mockNet({ [XAI_LANG]: xaiLang([['grok-4.20-0309-reasoning', MAR], ['grok-4.3', MAY]]) });
  const r = await m.resolveModel('xai', 'k', { order: 'provider' });
  assert.equal(r.id, 'grok-4.20-0309-reasoning');
  assert.equal(r.orderedBy, 'provider');
});

it('recency ordering applies within the eligible set only (a newer excluded model is not chosen)', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: xaiLang([['grok-5-fast', MAY + 999], ['grok-4.3', MAY], ['grok-4.20-0309-non-reasoning', MAY + 500]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-4.3');
});

it('ties keep the provider order (stable sort)', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: xaiLang([['grok-a', MAY], ['grok-b', MAY], ['grok-c', MAY]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-a');
});

it('a model with no recency signal sorts AFTER models that have one', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: xaiLang([['grok-nodate', undefined], ['grok-dated', MAR]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-dated');
});

it('xAI: /v1/language-models is preferred and /v1/models is not touched when it works', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: xaiLang([['grok-4.3', MAY]]), [XAI_ALL]: xaiAll([['grok-2-image-1212', MAY + 1]]) });
  await m.resolveModel('xai', 'k');
  assert.deepEqual(calls, [XAI_LANG]);
});

it('xAI: falls back to /v1/models when language-models fails, and image models are excluded there', async () => {
  const m = load();
  mockNet({
    [XAI_LANG]: { __status: 404 },
    [XAI_ALL]: xaiAll([['grok-2-image-1212', MAY + 1], ['grok-imagine-video', MAY + 2], ['grok-4.3', MAY]]),
  });
  const r = await m.resolveModel('xai', 'k');
  assert.equal(r.id, 'grok-4.3', 'the newest entry is an image model and must not win');
  assert.deepEqual(calls, [XAI_LANG, XAI_ALL]);
});

it('xAI: an empty language-models answer falls through to /v1/models', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: { models: [] }, [XAI_ALL]: xaiAll([['grok-4.3', MAY]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-4.3');
});

it('xAI: the reasoning variant beats non-reasoning; bare "reasoning" is not excluded; nonreasoning spelling is', async () => {
  let m = load(); mockNet({ [XAI_LANG]: xaiLang([['grok-4.20-0309-non-reasoning', MAY], ['grok-4.20-0309-reasoning', MAR]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-4.20-0309-reasoning');
  m = load(); mockNet({ [XAI_LANG]: xaiLang([['grok-4-nonreasoning', MAY], ['grok-4-reasoning', MAR]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-4-reasoning');
  m = load(); mockNet({ [XAI_LANG]: xaiLang([['grok-4-fast-reasoning', MAY], ['grok-4.3', MAR]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-4.3', 'skipped for "fast", not for "reasoning"');
});

it('Anthropic: asks for limit=1000, sorts by created_at, skips haiku/instant/mini', async () => {
  const m = load();
  mockNet({ [ANT]: { data: [
    { id: 'claude-haiku-4-5', created_at: '2026-06-01T00:00:00Z' },
    { id: 'claude-sonnet-4', created_at: '2025-05-22T00:00:00Z' },
    { id: 'claude-opus-5', created_at: '2026-04-01T00:00:00Z' },
  ] } });
  const r = await m.resolveModel('anthropic', 'k');
  assert.equal(r.id, 'claude-opus-5');
  assert.equal(r.orderedBy, 'created');
  assert.ok(calls[0].includes('limit=1000'), 'without limit the API returns only 20 models: ' + calls[0]);
});

it('Anthropic: an epoch created_at means "unknown" and sorts after known dates; all-unknown keeps provider order', async () => {
  let m = load();
  mockNet({ [ANT]: { data: [
    { id: 'claude-unknown-date', created_at: '1970-01-01T00:00:00Z' },
    { id: 'claude-dated', created_at: '2025-01-01T00:00:00Z' },
  ] } });
  assert.equal((await m.resolveModel('anthropic', 'k')).id, 'claude-dated');

  m = load();
  mockNet({ [ANT]: { data: [{ id: 'claude-x', created_at: '1970-01-01T00:00:00Z' }, { id: 'claude-y', created_at: 'garbage' }] } });
  const r = await m.resolveModel('anthropic', 'k');
  assert.equal(r.id, 'claude-x');
  assert.equal(r.orderedBy, 'provider');
});

it('Gemini: orders by generation (2.5 < 3 < 3.1), skips image/flash/lite, unversioned aliases rank last', async () => {
  const m = load();
  mockNet({ [GEM]: { models: [
    G('gemini-2.5-pro'), G('gemini-3-pro-preview'), G('gemini-pro-latest'), G('gemini-3.1-pro-preview'),
    G('gemini-3-pro-image-preview'), G('gemini-3.5-flash'), G('gemini-2.5-flash-image'),
  ] } });
  const ev = await m.inspectModels('gemini', 'k');
  assert.equal(ev.id, 'gemini-3.1-pro-preview');
  assert.equal(ev.orderedBy, 'version');
  const by = Object.fromEntries(ev.candidates.map(c => [c.id, c]));
  assert.equal(by['gemini-3-pro-preview'].rank, 2);
  assert.equal(by['gemini-2.5-pro'].rank, 3);
  assert.equal(by['gemini-pro-latest'].rank, 4);
  assert.equal(by['gemini-pro-latest'].generation, null);
  for (const id of ['gemini-3-pro-image-preview', 'gemini-2.5-flash-image', 'gemini-3.5-flash']) assert.equal(by[id].status, 'excluded', id);
});

it('Gemini: with no version in any eligible ID the provider order is kept', async () => {
  const m = load();
  mockNet({ [GEM]: { models: [G('gemini-pro-latest'), G('gemini-exp-1206')] } });
  const r = await m.resolveModel('gemini', 'k');
  assert.equal(r.id, 'gemini-pro-latest');
  assert.equal(r.orderedBy, 'provider');
});

it('Gemini: models without generateContent are dropped at fetch time', async () => {
  const m = load();
  mockNet({ [GEM]: { models: [G('gemini-9-pro', ['embedContent']), G('gemini-2.5-pro')] } });
  assert.equal((await m.resolveModel('gemini', 'k')).id, 'gemini-2.5-pro');
});

it('Gemini: the API key travels in the URL, and pageSize=1000 is requested', async () => {
  const m = load();
  mockNet({ [GEM]: { models: [G('gemini-2.5-pro')] } });
  await m.resolveModel('gemini', 'secret key&1');
  assert.ok(calls[0].includes('key=secret%20key%261') && calls[0].includes('pageSize=1000'), calls[0]);
});

it('relaxation tiers: only excluded models -> tier 2 (still recency-ordered); nothing matching -> tier 3', async () => {
  let m = load(); mockNet({ [XAI_LANG]: xaiLang([['grok-4-fast', MAR], ['grok-4-mini', MAY]]) });
  let ev = await m.inspectModels('xai', 'k');
  assert.equal(ev.tier, 2); assert.equal(ev.id, 'grok-4-mini'); assert.equal(ev.source, 'live');

  m = load(); mockNet({ [XAI_LANG]: xaiLang([['something-else', MAY], ['other', MAR]]) });
  ev = await m.inspectModels('xai', 'k');
  assert.equal(ev.tier, 3); assert.equal(ev.id, 'something-else'); assert.equal(ev.orderedBy, 'provider');
});

// ───────────────────────────── timeouts ─────────────────────────────

it('a hung endpoint is abandoned after timeoutMs and the fallback is returned', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: hang, [XAI_ALL]: hang });
  const t0 = Date.now();
  const ev = await m.inspectModels('xai', 'k', { timeoutMs: 60, fallback: 'my-pin' });
  assert.ok(Date.now() - t0 < 1500, 'returned promptly, took ' + (Date.now() - t0) + 'ms');
  assert.equal(ev.id, 'my-pin'); assert.equal(ev.source, 'fallback'); assert.equal(ev.reason, 'fetch-failed');
  assert.match(ev.error, /Timed out after 60ms/);
});

it('timeout errors never contain the API key (Gemini puts it in the URL)', async () => {
  const m = load();
  mockNet({ [GEM]: hang });
  const ev = await m.inspectModels('gemini', 'SUPER-SECRET-KEY', { timeoutMs: 40 });
  assert.match(ev.error, /Timed out after 40ms waiting for generativelanguage\.googleapis\.com/);
  assert.ok(!ev.error.includes('SUPER-SECRET-KEY'));
});

it('timeout precedence: options.timeoutMs > env var > default; junk env values are ignored', async () => {
  let m = load({ LLM_MODEL_RESOLVER_TIMEOUT_MS: '5000' });
  mockNet({ [ANT]: hang });
  assert.match((await m.inspectModels('anthropic', 'k', { timeoutMs: 30 })).error, /after 30ms/);

  m = load({ LLM_MODEL_RESOLVER_TIMEOUT_MS: '45' });
  mockNet({ [ANT]: hang });
  assert.match((await m.inspectModels('anthropic', 'k')).error, /after 45ms/);

  for (const junk of ['abc', '-5', '0', '']) {
    m = load({ LLM_MODEL_RESOLVER_TIMEOUT_MS: junk });
    mockNet({ [ANT]: { data: [{ id: 'claude-opus-5', created_at: '2026-01-01T00:00:00Z' }] } });
    assert.equal((await m.resolveModel('anthropic', 'k')).id, 'claude-opus-5', 'junk value ' + JSON.stringify(junk));
  }
  assert.equal(load().DEFAULT_TIMEOUT_MS, 10000);
});

it('OpenRouter fetches time out too', async () => {
  const m = load();
  mockNet({ [OR]: hang });
  const t0 = Date.now();
  const set = await m.fetchFreeModels('k', { timeoutMs: 50 });
  assert.ok(Date.now() - t0 < 1500);
  assert.deepEqual(Array.from(set), ['openrouter/free']);
});

it('REAL sockets: a server that never answers, and one that stalls mid-body, are both abandoned', async () => {
  const servers = [];
  const listen = handler => new Promise(res => { const s = http.createServer(handler); servers.push(s); s.listen(0, '127.0.0.1', () => res(s.address().port)); });
  const headerStall = await listen(() => { /* accept the request, never reply */ });
  const bodyStall = await listen((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': '100000' });
    res.write('{"models":[');            // headers + partial body, then silence
  });
  try {
    for (const [name, port] of [['header stall', headerStall], ['body stall', bodyStall]]) {
      const m = load();
      // Route every provider URL to the local server, but hand real fetch the module's OWN options (incl. its signal).
      globalThis.fetch = (url, opts) => realFetch(`http://127.0.0.1:${port}/x`, opts);
      const t0 = Date.now();
      const ev = await m.inspectModels('anthropic', 'k', { timeoutMs: 250 });
      const took = Date.now() - t0;
      assert.equal(ev.source, 'fallback', name);
      assert.match(ev.error, /Timed out after 250ms/, name + ': ' + ev.error);
      assert.ok(took >= 200 && took < 3000, `${name}: took ${took}ms`);
    }
  } finally {
    globalThis.fetch = realFetch;
    for (const s of servers) { s.closeAllConnections && s.closeAllConnections(); s.close(); }
  }
});

// ───────────────────────────── cool-down ─────────────────────────────

it('after a failed fetch the endpoint is not retried during the cool-down, then is retried', async () => {
  const m = load();
  let t = 1_000_000; Date.now = () => t;
  mockNet({ [ANT]: new Error('ECONNRESET') });
  let ev = await m.inspectModels('anthropic', 'k', { fallback: 'pin' });
  assert.equal(ev.reason, 'fetch-failed'); assert.equal(calls.length, 1);

  t += 30_000;
  ev = await m.inspectModels('anthropic', 'k', { fallback: 'pin' });
  assert.equal(ev.reason, 'cooldown'); assert.equal(ev.source, 'fallback');
  assert.equal(calls.length, 1, 'no new request during the cool-down');
  assert.match(ev.error, /ECONNRESET/, 'the original error is still reported');

  t += 31_000;   // past 60s
  mockNet({ [ANT]: { data: [{ id: 'claude-opus-5', created_at: '2026-01-01T00:00:00Z' }] } });
  ev = await m.inspectModels('anthropic', 'k', { fallback: 'pin' });
  assert.equal(ev.source, 'live'); assert.equal(ev.id, 'claude-opus-5'); assert.equal(calls.length, 1);
});

it('the cool-down is what stops a hung endpoint costing the timeout on every call of a batch', async () => {
  const m = load();
  mockNet({ [ANT]: hang });
  const t0 = Date.now();
  for (let i = 0; i < 20; i++) await m.resolveModel('anthropic', 'k', { timeoutMs: 80, fallback: 'pin' });
  const took = Date.now() - t0;
  assert.equal(calls.length, 1, 'one attempt, then 19 instant fallbacks');
  assert.ok(took < 1000, `20 calls took ${took}ms (would be ~1600ms with a timeout but no cool-down)`);
});

it('forceRefresh and cooldownMs:0 both bypass the cool-down', async () => {
  let m = load();
  mockNet({ [ANT]: new Error('boom') });
  await m.resolveModel('anthropic', 'k');
  mockNet({ [ANT]: { data: [{ id: 'claude-opus-5', created_at: '2026-01-01T00:00:00Z' }] } });
  assert.equal((await m.resolveModel('anthropic', 'k', { forceRefresh: true })).source, 'live');

  m = load();
  mockNet({ [ANT]: new Error('boom') });
  await m.resolveModel('anthropic', 'k', { cooldownMs: 0 });
  mockNet({ [ANT]: { data: [{ id: 'claude-opus-5', created_at: '2026-01-01T00:00:00Z' }] } });
  assert.equal((await m.resolveModel('anthropic', 'k', { cooldownMs: 0 })).source, 'live');
});

it('the cool-down is per provider', async () => {
  const m = load();
  mockNet({ [ANT]: new Error('boom'), [XAI_LANG]: xaiLang([['grok-4.3', MAY]]) });
  await m.resolveModel('anthropic', 'k');
  assert.equal((await m.resolveModel('xai', 'k')).source, 'live');
});

it('a failed REFRESH keeps serving the list already held instead of dropping to the fallback', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: xaiLang([['grok-4.3', MAY]]) });
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-4.3');
  mockNet({ [XAI_LANG]: new Error('down'), [XAI_ALL]: new Error('down') });
  const ev = await m.inspectModels('xai', 'k', { forceRefresh: true, fallback: 'pin' });
  assert.equal(ev.id, 'grok-4.3'); assert.equal(ev.source, 'live'); assert.match(ev.error, /down/);
});

it('OpenRouter: one failure is no longer permanent, and a seeded fallback is not reported as live', async () => {
  const m = load();
  let t = 5_000_000; Date.now = () => t;
  mockNet({ [OR]: new Error('blip') });
  let r = await m.resolveModel('openrouter', 'k');
  assert.equal(r.id, 'openrouter/free'); assert.equal(r.source, 'fallback', 'was wrongly reported as live before');
  assert.equal(await m.getNextFreeModel('k'), 'openrouter/free');

  t += 61_000;
  mockNet({ [OR]: { data: [{ id: 'free/a', pricing: { prompt: '0', completion: '0' } }] } });
  r = await m.resolveModel('openrouter', 'k');
  assert.equal(r.id, 'free/a'); assert.equal(r.source, 'live');
});

it('OpenRouter: a failed refresh keeps the list it already had', async () => {
  const m = load();
  mockNet({ [OR]: { data: [{ id: 'free/a', pricing: { prompt: 0, completion: 0 } }] } });
  await m.fetchFreeModels('k');
  mockNet({ [OR]: new Error('down') });
  assert.deepEqual(Array.from(await m.fetchFreeModels('k', true)), ['free/a']);
});

// ───────────────────────────── inspectModels ─────────────────────────────

it('inspectModels: reasons for returning the fallback', async () => {
  let m = load();
  mockNet({});
  assert.equal((await m.inspectModels('xai', undefined)).reason, 'no-key');
  assert.equal(calls.length, 0, 'no key -> no network');

  m = load(); mockNet({ [XAI_LANG]: { models: [] }, [XAI_ALL]: { data: [] } });
  assert.equal((await m.inspectModels('xai', 'k')).reason, 'empty-list');

  m = load(); mockNet({ [XAI_LANG]: xaiLang([['grok-a', MAR]]) });
  m.markModelBad('xai', 'grok-a');
  const ev = await m.inspectModels('xai', 'k', { fallback: 'pin' });
  assert.equal(ev.reason, 'all-known-bad'); assert.equal(ev.id, 'pin');
  assert.equal(ev.candidates[0].status, 'known-bad');
});

it('inspectModels: candidate table groups and statuses', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: xaiLang([['other-model', MAY], ['grok-4-fast', MAY], ['grok-old', MAR], ['grok-4.3', MAY], ['grok-bad', MAY + 5]]) });
  m.markModelBad('xai', 'grok-bad');
  const ev = await m.inspectModels('xai', 'k');
  assert.deepEqual(ev.candidates.map(c => [c.id, c.status]), [
    ['grok-4.3', 'chosen'], ['grok-old', 'eligible'], ['grok-4-fast', 'excluded'], ['other-model', 'not-matching'], ['grok-bad', 'known-bad'],
  ]);
  assert.equal(ev.candidates[0].created, new Date(MAY * 1000).toISOString());
  assert.equal(ev.tier, 1); assert.equal(ev.fallback, 'grok-4');
});

it('resolveModel returns exactly { id, source, orderedBy }', async () => {
  const m = load(); mockNet({ [XAI_LANG]: xaiLang([['grok-4.3', MAY]]) });
  assert.deepEqual(Object.keys(await m.resolveModel('xai', 'k')).sort(), ['id', 'orderedBy', 'source']);
  assert.deepEqual(await m.resolveModel('xai', undefined, { fallback: 'p' }), { id: 'p', source: 'fallback', orderedBy: null });
});

// ───────────────────────────── markModelBad ─────────────────────────────

it('markModelBad: next-best candidate, cached list, all-bad -> fallback, clearCache resets everything', async () => {
  const m = load();
  mockNet({ [GEM]: { models: [G('gemini-2.5-pro'), G('gemini-3.1-pro-preview')] } });
  assert.equal((await m.resolveModel('gemini', 'k')).id, 'gemini-3.1-pro-preview');
  m.markModelBad('gemini', 'gemini-3.1-pro-preview');
  assert.equal((await m.resolveModel('gemini', 'k')).id, 'gemini-2.5-pro');
  assert.equal(calls.length, 1, 'list is cached: re-resolving makes no new request');
  m.markModelBad('gemini', 'gemini-2.5-pro');
  const r = await m.resolveModel('gemini', 'k', { fallback: 'my-pin' });
  assert.deepEqual([r.id, r.source], ['my-pin', 'fallback']);
  m.clearCache();
  assert.equal((await m.resolveModel('gemini', 'k')).id, 'gemini-3.1-pro-preview');
});

it('markModelBad: per provider, silent no-op for openrouter/unknown/empty', async () => {
  const m = load();
  assert.doesNotThrow(() => { m.markModelBad('openrouter', 'x'); m.markModelBad('nope', 'x'); m.markModelBad('xai', ''); });
  mockNet({ [XAI_LANG]: xaiLang([['grok-a', MAY], ['grok-b', MAR]]) });
  await m.resolveModel('xai', 'k');
  m.markModelBad('xai', 'grok-a'); m.markModelBad('anthropic', 'grok-b');
  assert.equal((await m.resolveModel('xai', 'k')).id, 'grok-b');
});

it('clearCache also clears fetch cool-downs', async () => {
  const m = load();
  mockNet({ [ANT]: new Error('boom') });
  await m.resolveModel('anthropic', 'k');
  m.clearCache();
  mockNet({ [ANT]: { data: [{ id: 'claude-opus-5', created_at: '2026-01-01T00:00:00Z' }] } });
  assert.equal((await m.resolveModel('anthropic', 'k')).source, 'live');
});

// ───────────────────────────── failure behavior ─────────────────────────────

it('only an unknown provider throws; "grok" and "claude" are rejected (must be xai / anthropic)', async () => {
  const m = load(); mockNet({});
  for (const bad of ['grok', 'claude', 'nope', '', undefined]) {
    await assert.rejects(() => m.resolveModel(bad, 'k'), /Unknown provider/, String(bad));
  }
});

it('no key -> fallback with zero network calls; network error / HTTP 429 -> fallback, no throw', async () => {
  let m = load(); mockNet({});
  assert.deepEqual(await m.resolveModel('xai', undefined, { fallback: 'p' }), { id: 'p', source: 'fallback', orderedBy: null });
  assert.equal(calls.length, 0);
  m = load(); mockNet({ [ANT]: new Error('ECONNRESET') });
  assert.equal((await m.resolveModel('anthropic', 'k', { fallback: 'p' })).source, 'fallback');
  m = load(); mockNet({ [ANT]: { __status: 429 } });
  assert.equal((await m.resolveModel('anthropic', 'k', { fallback: 'p' })).source, 'fallback');
});

it('an unexpected malformed payload falls back instead of throwing', async () => {
  const m = load();
  mockNet({ [XAI_LANG]: { models: 'not-an-array' }, [XAI_ALL]: null });
  const r = await m.resolveModel('xai', 'k', { fallback: 'p' });
  assert.equal(r.source, 'fallback');
});

// ───────────────────────────── defaults / env ─────────────────────────────

it('built-in defaults are the reviewed ones', () => {
  const m = load();
  assert.deepEqual({ ...m.DEFAULT_FALLBACKS }, {
    xai: 'grok-4', anthropic: 'claude-sonnet-5', gemini: 'gemini-flash-latest', openrouter: 'openrouter/free',
  });
});

it('fallback precedence: options.fallback > env var > default; aliases honoured; env is read once at load', async () => {
  let m = load({ XAI_MODEL_FALLBACK: 'env-pin' }); mockNet({});
  assert.equal((await m.resolveModel('xai', undefined)).id, 'env-pin');
  assert.equal((await m.resolveModel('xai', undefined, { fallback: 'opt-pin' })).id, 'opt-pin');
  assert.equal(load({ GROK_MODEL_FALLBACK: 'grok-alias' }).DEFAULT_FALLBACKS.xai, 'grok-alias');
  assert.equal(load({ OPENROUTER_FREE_FALLBACK: 'or-alias' }).DEFAULT_FALLBACKS.openrouter, 'or-alias');
  m = load(); process.env.XAI_MODEL_FALLBACK = 'too-late';
  assert.notEqual(m.DEFAULT_FALLBACKS.xai, 'too-late');
  delete process.env.XAI_MODEL_FALLBACK;
});

// ───────────────────────────── OpenRouter ─────────────────────────────

it('OpenRouter: free = BOTH prices zero (string or number); round-robin wraps; reset restarts; boolean forceRefresh still works', async () => {
  const m = load();
  mockNet({ [OR]: { data: [
    { id: 'paid/x', pricing: { prompt: '0.001', completion: '0.002' } },
    { id: 'free/a', pricing: { prompt: '0', completion: '0' } },
    { id: 'half/b', pricing: { prompt: '0', completion: '0.5' } },
    { id: 'free/c', pricing: { prompt: 0, completion: 0 } },
  ] } });
  assert.equal((await m.resolveModel('openrouter', 'k')).id, 'free/a');
  const rot = [await m.getNextFreeModel('k'), await m.getNextFreeModel('k'), await m.getNextFreeModel('k')];
  assert.deepEqual(rot, ['free/a', 'free/c', 'free/a']);
  m.resetFreeModelIndex();
  assert.equal(await m.getNextFreeModel('k'), 'free/a');
  const set = await m.fetchFreeModels('k', true);
  assert.ok(set instanceof Set && set.size === 2);
});

it('OpenRouter: an empty free list falls back', async () => {
  const m = load(); mockNet({ [OR]: { data: [] } });
  const ev = await m.inspectModels('openrouter', 'k');
  assert.equal(ev.reason, 'empty-list'); assert.equal(ev.id, 'openrouter/free');
  assert.equal(await m.getNextFreeModel('k'), 'openrouter/free');
});
