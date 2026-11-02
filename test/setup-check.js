// Run after a setup script (CI does): waits for the installed server on port 9420 and compiles a
// sketch through it. Not part of `npm test`, which starts its own server.
const BASE = 'http://127.0.0.1:9420';

async function main() {
  for (let i = 0; i < 150; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  const res = await fetch(`${BASE}/build`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sketch: 'void setup() {\n  pinMode(13, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(13, HIGH);\n}\n',
      files: [],
      board: 'uno',
      target: 'atmega328p',
      options: {},
    }),
  });
  const body = await res.json();
  console.log(body.stdout);
  if (!body.hex) {
    console.error(body.stderr);
    process.exit(1);
  }
  console.log('OK: compiled through the installed server');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
