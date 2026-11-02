// The extension's fetch redirect, run against a fake page and a fake local server.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const src = fs.readFileSync(path.join(__dirname, '..', 'extension', 'inject.js'), 'utf8');

function loadPage() {
  const state = { serverUp: true, store: {} };
  const realFetch = async (url, init = {}) => {
    if (url.startsWith('http://127.0.0.1')) {
      if (!state.serverUp) throw new TypeError('Failed to fetch');
      if (url.endsWith('/health')) return new Response('{"ok":true}');
      if (JSON.parse(init.body).board === 'weird') {
        return new Response('{"stderr":"wokwi-local: unknown board \\"weird\\"\\n"}', { status: 422 });
      }
      return new Response('{"hex":"LOCAL"}');
    }
    return new Response(url.includes('position') ? '{"state":"cloud"}' : '{"hex":"CLOUD"}');
  };
  globalThis.window = { fetch: realFetch };
  globalThis.location = { href: 'https://wokwi.com/projects/x', origin: 'https://wokwi.com' };
  globalThis.localStorage = { getItem: (k) => state.store[k] ?? null };
  new Function('console', src)({ info() {}, warn() {} });

  const build = (board) =>
    window.fetch('https://wokwi.com/build', { method: 'POST', body: JSON.stringify({ board }) }).then((r) => r.json());
  const position = () => window.fetch('https://wokwi.com/build/position?hash=1').then((r) => r.json());
  return { state, build, position };
}

test('builds go to the local server when it is running', async () => {
  const { build, position } = loadPage();
  assert.strictEqual((await build('uno')).hex, 'LOCAL');
  assert.strictEqual((await position()).state, 'none');
});

test('unknown boards fall back to the cloud', async () => {
  const { build } = loadPage();
  assert.strictEqual((await build('weird')).hex, 'CLOUD');
});

test('other requests are untouched', async () => {
  loadPage();
  assert.strictEqual((await (await window.fetch('https://wokwi.com/api/x')).json()).hex, 'CLOUD');
});

test("localStorage.wokwiLocal = 'off' sends builds to the cloud", async () => {
  const { state, build } = loadPage();
  state.store.wokwiLocal = 'off';
  assert.strictEqual((await build('uno')).hex, 'CLOUD');
});

test('builds fall back to the cloud when the server is down', async () => {
  const { state, build, position } = loadPage();
  state.serverUp = false;
  assert.strictEqual((await build('uno')).hex, 'CLOUD');
  assert.strictEqual((await position()).state, 'cloud');
});
