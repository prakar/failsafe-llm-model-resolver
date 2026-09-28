'use strict';
// Keeps README.md honest. The README went stale once already (it described filters the code no
// longer had and missed ones it did); these checks make the next drift fail the build instead.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const os = require('node:os');

const root = path.join(__dirname, '..');
const README = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const SRC = fs.readFileSync(path.join(root, 'index.js'), 'utf8');
const DTS = fs.readFileSync(path.join(root, 'index.d.ts'), 'utf8');
const m = require('../index.js');

test('the rules block in the README is exactly PREFERENCE', () => {
  const block = README.match(/```js\nxai:[\s\S]*?```/);
  assert.ok(block, 'rules block not found');
  for (const p of ['xai', 'anthropic', 'gemini']) {
    const line = block[0].split('\n').find(l => l.startsWith(p + ':'));
    assert.ok(line, p + ' line missing');
    const inc = line.match(/include: (\/.*?\/i)/)[1];
    const exc = line.match(/exclude: (\/.*?\/i)/)[1];
    assert.equal(inc, String(m.PREFERENCE[p].include), p + ' include');
    assert.equal(exc, String(m.PREFERENCE[p].exclude), p + ' exclude');
  }
});

test('the defaults table lists exactly DEFAULT_FALLBACKS', () => {
  const section = README.slice(README.indexOf('## Fallbacks'));
  const rows = [...section.matchAll(/^\| `(xai|anthropic|gemini|openrouter)`\s*\| `([^`]+)`/gm)];
  assert.equal(rows.length, 4, 'expected one row per provider');
  // The exported defaults can be overridden by env vars; compare to the built-in values.
  const clean = { ...process.env };
  for (const k of ['XAI_MODEL_FALLBACK', 'GROK_MODEL_FALLBACK', 'ANTHROPIC_MODEL_FALLBACK', 'GEMINI_MODEL_FALLBACK', 'OPENROUTER_MODEL_FALLBACK', 'OPENROUTER_FREE_FALLBACK']) delete clean[k];
  const out = cp.execFileSync(process.execPath, ['-e', "console.log(JSON.stringify(require('./index.js').DEFAULT_FALLBACKS))"], { cwd: root, env: clean }).toString();
  const defaults = JSON.parse(out);
  for (const [, provider, id] of rows) assert.equal(id, defaults[provider], provider);
});

test('the documented timeout and cool-down defaults are the real ones', () => {
  assert.equal(m.DEFAULT_TIMEOUT_MS, 10000);
  assert.equal(m.DEFAULT_COOLDOWN_MS, 60000);
  assert.match(README, /default 10000/);
  assert.match(README, /default 60000/);
  assert.match(README, /\*\*10 seconds\*\*/);
  assert.match(README, /60 seconds/);
});

test('every export is documented in the README and declared in the types', () => {
  for (const name of Object.keys(m)) {
    assert.ok(README.includes(name), 'README never mentions ' + name);
    assert.ok(new RegExp('export (function|const) ' + name + '\\b').test(DTS), 'index.d.ts does not declare ' + name);
  }
});

test('every option, reason, status and orderedBy value in the types is in the README', () => {
  for (const opt of ['forceRefresh', 'fallback', 'order', 'timeoutMs', 'cooldownMs']) {
    assert.ok(README.includes(opt + '?'), 'option missing from README API block: ' + opt);
    assert.ok(DTS.includes(opt + '?'), 'option missing from types: ' + opt);
  }
  for (const v of ['no-key', 'fetch-failed', 'cooldown', 'empty-list', 'all-known-bad', 'error',
                   'chosen', 'eligible', 'excluded', 'not-matching', 'known-bad', 'created', 'version', 'provider']) {
    assert.ok(README.includes(v), 'README never mentions the value ' + v);
    assert.ok(DTS.includes(v), 'types never mention the value ' + v);
  }
  for (const k of ['provider', 'id', 'source', 'reason', 'orderedBy', 'tier', 'fallback', 'error', 'candidates', 'created', 'generation', 'status', 'rank']) {
    assert.ok(README.includes(k + ':'), 'inspectModels example is missing the field ' + k);
  }
});

test('the documented endpoints are the ones the code calls', () => {
  for (const url of [
    'https://api.x.ai/v1/language-models', 'https://api.x.ai/v1/models',
    'https://api.anthropic.com/v1/models?limit=1000',
    'https://generativelanguage.googleapis.com/v1beta/models',
    'https://openrouter.ai/api/v1/models',
  ]) {
    assert.ok(README.includes(url), 'README does not mention ' + url);
    assert.ok(SRC.includes(url.replace('?limit=1000', '')), 'code does not call ' + url);
  }
  assert.ok(SRC.includes('limit=1000'), 'the Anthropic limit the README describes is not in the code');
  assert.ok(SRC.includes('pageSize=1000'), 'the Gemini page size the README describes is not in the code');
});

test('every code example parses as JavaScript', () => {
  const blocks = [...README.matchAll(/```js\n([\s\S]*?)```/g)].map(x => x[1]).filter(b => !b.startsWith('xai:'));
  assert.ok(blocks.length >= 6, 'expected several examples, found ' + blocks.length);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'readme-ex-'));
  blocks.forEach((b, i) => {
    const f = path.join(dir, `ex${i}.js`);
    fs.writeFileSync(f, '(async () => {\n' + b + '\n})();\n');
    const r = cp.spawnSync(process.execPath, ['--check', f]);
    assert.equal(r.status, 0, `example ${i + 1} does not parse: ${b.split('\n').find(l => l.trim())}\n${r.stderr}`);
  });
});

test('markdown tables have consistent columns (a bare | inside a cell would split it)', () => {
  const tables = []; let cur = [];
  for (const l of README.split('\n')) { if (l.startsWith('|')) cur.push(l); else if (cur.length) { tables.push(cur); cur = []; } }
  if (cur.length) tables.push(cur);
  assert.ok(tables.length >= 3);
  tables.forEach((tb, i) => {
    const counts = new Set(tb.map(r => (r.match(/(?<!\\)\|/g) || []).length));
    assert.equal(counts.size, 1, `table ${i + 1} has uneven columns: ${[...counts]}`);
  });
});

test('the old package name appears only in the "formerly published as" note', () => {
  const hits = README.split('\n').filter(l => l.includes('failsafe-llm-model-resolver'));
  assert.equal(hits.length, 1, hits.join('\n'));
  assert.match(hits[0], /Formerly published as/);
});

test('the README does not claim things the code no longer does', () => {
  for (const stale of ['does not sort', 'no version sorting', 'No request timeout', 'No version sorting', 'aren\'t filtered by capability']) {
    assert.ok(!README.includes(stale), 'stale claim still in the README: ' + stale);
  }
});
