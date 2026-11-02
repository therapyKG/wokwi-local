// Real builds through the server with arduino-cli. The first run installs each board's core,
// which takes several minutes (ESP32 is a few GB).
// Limit boards with WOKWI_TEST_BOARDS, e.g. WOKWI_TEST_BOARDS=uno,pipico npm test
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = 9500 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const ONLY = process.env.WOKWI_TEST_BOARDS ? process.env.WOKWI_TEST_BOARDS.split(',') : null;
const LONG = { timeout: 45 * 60 * 1000 };

const SKETCH = 'void setup() {\n  Serial.begin(115200);\n  Serial.println("hi");\n}\n\nvoid loop() {\n  delay(10);\n}\n';

let server;
let serverLog = '';

test.before(async () => {
  server = spawn(process.execPath, [path.join(__dirname, '..', 'server.js')], {
    env: { ...process.env, PORT: String(PORT) },
  });
  server.stdout.on('data', (d) => (serverLog += d));
  server.stderr.on('data', (d) => (serverLog += d));
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`server didn't start:\n${serverLog}`);
});

test.after(() => {
  server.kill();
  console.log(`--- server log ---\n${serverLog}`);
});

async function build(body) {
  const res = await fetch(`${BASE}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files: [], options: { skipCache: false, symbols: false }, ...body }),
  });
  return { status: res.status, ...(await res.json()) };
}

function boardTest(name, board, fn) {
  const skip = ONLY !== null && !ONLY.includes(board) ? 'not in WOKWI_TEST_BOARDS' : false;
  test(name, { ...LONG, skip }, fn);
}

function assertBuilt(res) {
  assert.strictEqual(res.status, 200);
  assert.ok(res.hex, `no firmware; stderr:\n${res.stderr}`);
  assert.match(res.stdout, /Built locally by wokwi-local/);
}

boardTest('Uno: builds with an extra file and a library', 'uno', async () => {
  const res = await build({
    board: 'uno',
    target: 'atmega328p',
    sketch: `#include "helper.h"\n#include <Servo.h>\nServo s;\n${SKETCH}`,
    files: [
      { name: 'helper.h', content: '#define GREETING "hi"\n' },
      { name: 'libraries.txt', content: '# Wokwi Library List\nServo\n' },
    ],
  });
  assertBuilt(res);
  assert.match(res.hex, /^:[0-9A-F]{10}/);
  assert.match(res.hex, /:00000001FF\r\n$/);
});

boardTest('Uno: compile errors point at /sketch/sketch.ino', 'uno', async () => {
  const res = await build({ board: 'uno', target: 'atmega328p', sketch: 'void setup() { oops }\nvoid loop() {}\n' });
  assert.strictEqual(res.hex, '');
  assert.match(res.stderr, /\/sketch\/sketch\.ino:1:\d+: error/);
});

boardTest('Pi Pico: builds Intel HEX at 0x10000000', 'pipico', async () => {
  const res = await build({ board: 'pipico', target: 'rp2040', sketch: SKETCH });
  assertBuilt(res);
  assert.ok(res.hex.startsWith(':020000041000EA'));
});

for (const [board, target] of [['esp32:esp32:esp32', 'esp32'], ['esp32:esp32:esp32s3', 'esp32-s3']]) {
  boardTest(`${target}: builds an app image with symbols`, board, async () => {
    const res = await build({ board, target, sketch: SKETCH, options: { symbols: true } });
    assertBuilt(res);
    assert.strictEqual(Buffer.from(res.hex, 'base64')[0], 0xe9, 'ESP image magic byte');
    assert.ok(res.symbols.startsWith('$wokwisym,version=1\n'));
    assert.ok(!res.symbols.endsWith('\n'), "Wokwi's parser fails on a trailing newline");
  });
}

test('unknown boards get 422 so the extension falls back to the cloud', async () => {
  const res = await build({ board: 'nonsense', target: 'x', sketch: SKETCH });
  assert.strictEqual(res.status, 422);
});

test('unsafe file names are refused', async () => {
  const res = await build({ board: 'uno', target: 'atmega328p', sketch: SKETCH, files: [{ name: '../evil.h', content: '' }] });
  assert.strictEqual(res.hex, '');
  assert.match(res.stderr, /Bad file name/);
});
