#!/usr/bin/env node
// Local compile backend for wokwi.com. Speaks the same protocol as https://wokwi.com/build
// and compiles with arduino-cli, so the browser extension can route builds here.

const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

// Command-line options, used by the setup scripts' login services:
//   --arduino-cli <path>   arduino-cli to use (services don't get your shell's PATH)
//   --log <file>           also append log lines to this file
//   --install-cores <ids>  install cores (e.g. arduino:avr,esp32:esp32) and exit
function option(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const PORT = Number(process.env.PORT) || 9420;
const HOST = '127.0.0.1';
const ROOT = __dirname;
// Override with a short path (e.g. C:\wl) if Windows builds hit path-length limits.
const WORK = process.env.WOKWI_LOCAL_WORK || path.join(ROOT, '.work');
const ARDUINO_CLI = option('--arduino-cli') || process.env.ARDUINO_CLI || 'arduino-cli';
const LOG_FILE = option('--log');
const ALLOWED_ORIGINS = new Set(['https://wokwi.com']);
const CACHE_LIMIT = 50;

// Board package index URLs for cores that aren't in the default Arduino index.
const PACKAGE_URLS = {
  esp32: 'https://espressif.github.io/arduino-esp32/package_esp32_index.json',
  rp2040: 'https://github.com/earlephilhower/arduino-pico/releases/download/global/package_rp2040_index.json',
  ATTinyCore: 'http://drazzy.com/package_drazzy.com_index.json',
};

// Core versions pinned to what Wokwi's cloud compiler uses, so local firmware matches what its
// simulator is tested against. Wokwi's version shows up in the cloud build's app descriptor
// (IDF version and build date).
const PINNED_VERSIONS = {
  'esp32:esp32': '3.3.7',
};

// Build steps whose output Wokwi never uses: it brings its own bootloader and partition table and
// only needs the app image. Skipping them saves ~2s per ESP32 build, since each esptool run takes
// ~0.8s to start. The recipe names are from the pinned 3.3.7 platform.txt; recheck them if the
// pin changes.
const SKIPPED_RECIPES = {
  esp32: [
    'recipe.hooks.prebuild.4.pattern', // bootloader.bin
    'recipe.objcopy.partitions.bin.pattern', // partitions.bin
    'recipe.hooks.objcopy.postobjcopy.3.pattern', // 4 MB merged.bin
  ],
};

// arduino-cli runs recipes without a shell, so skipping one means swapping in a real program that
// does nothing. On Windows, platform.txt's ".windows" variants win, so those are replaced too.
function skipFlags(pkg, platform = process.platform) {
  const noop = platform === 'win32' ? 'cmd /c exit 0' : 'true';
  const keys = (SKIPPED_RECIPES[pkg] || []).flatMap((r) => (platform === 'win32' ? [r, `${r}.windows`] : [r]));
  return keys.flatMap((k) => ['--build-property', `${k}=${noop}`]);
}

// Hints for toolchain failures that come from the host machine rather than the sketch.
const HOST_HINTS = [
  ['bad CPU type', 'this toolchain is Intel-only. Install Rosetta: softwareupdate --install-rosetta'],
  ['exec format error', "this toolchain isn't built for this computer's CPU"],
];

const BOARDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'boards.json'), 'utf8'));

// Libraries go into a private sketchbook so they don't clutter ~/Documents/Arduino.
const cliEnv = { ...process.env, ARDUINO_DIRECTORIES_USER: path.join(ROOT, 'arduino-user') };

function run(args, { cwd } = {}) {
  return new Promise((resolve) => {
    const child = spawn(ARDUINO_CLI, args, { cwd, env: cliEnv });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('error', (err) => {
      const msg = err.code === 'ENOENT'
        ? `${ARDUINO_CLI} not found. Install arduino-cli (see README) or set ARDUINO_CLI to its full path.`
        : String(err);
      resolve({ code: -1, stdout, stderr: stderr + msg });
    });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

function log(...args) {
  const line = [new Date().toISOString().slice(11, 19), ...args].join(' ');
  console.log(line);
  if (LOG_FILE) {
    try {
      fs.appendFileSync(LOG_FILE, line + '\n');
    } catch {}
  }
}

// --- Cores ---------------------------------------------------------------

let dataDir = null;

async function installedVersions(pkg, arch) {
  if (!dataDir) {
    const res = await run(['config', 'get', 'directories.data']);
    if (res.code === 0) dataDir = res.stdout.trim();
  }
  if (!dataDir) return [];
  try {
    const entries = await fsp.readdir(path.join(dataDir, 'packages', pkg, 'hardware', arch));
    return entries.filter((e) => !e.startsWith('.'));
  } catch {
    return [];
  }
}

async function ensurePlatform(fqbn, notes) {
  const [pkg, arch] = fqbn.split(':');
  const id = `${pkg}:${arch}`;
  const wanted = PINNED_VERSIONS[id];
  // Checked on every build (it's only a directory listing): the Arduino IDE shares this folder
  // and can upgrade a pinned core while the server is running.
  const versions = await installedVersions(pkg, arch);
  if (wanted ? versions.includes(wanted) : versions.length > 0) return;

  const spec = wanted ? `${id}@${wanted}` : id;
  log(`installing core ${spec} (this can take a few minutes)`);
  const urlArgs = PACKAGE_URLS[pkg] ? ['--additional-urls', PACKAGE_URLS[pkg]] : [];
  await run(['core', 'update-index', ...urlArgs]);
  const res = await run(['core', 'install', spec, ...urlArgs]);
  if (res.code !== 0) throw new Error(`Failed to install core ${spec}:\n${res.stdout}${res.stderr}`);
  notes.push(`Installed core ${spec}`);
}

// --- Libraries -----------------------------------------------------------

const ensuredLibs = new Set();
let libIndexUpdated = false;

function parseLibraries(text) {
  return text
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}

async function ensureLibraries(specs, notes) {
  for (const spec of specs) {
    if (ensuredLibs.has(spec)) continue;
    if (spec.includes('@wokwi:')) {
      notes.push(`Skipping "${spec}": libraries uploaded to Wokwi can't be fetched locally`);
      continue;
    }
    if (!libIndexUpdated) {
      await run(['lib', 'update-index']);
      libIndexUpdated = true;
    }
    log(`installing library ${spec}`);
    const res = await run(['lib', 'install', spec]);
    if (res.code !== 0) throw new Error(`Failed to install library "${spec}":\n${res.stdout}${res.stderr}`);
    ensuredLibs.add(spec);
  }
}

// --- Output conversion ---------------------------------------------------

function binToIhex(buf, base) {
  const lines = [];
  const record = (type, addr, data) => {
    const bytes = [data.length, (addr >> 8) & 0xff, addr & 0xff, type, ...data];
    const sum = -bytes.reduce((a, b) => a + b, 0) & 0xff;
    lines.push(':' + [...bytes, sum].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase());
  };
  let upper = -1;
  for (let off = 0; off < buf.length; off += 16) {
    const addr = base + off;
    const hi = addr >>> 16;
    if (hi !== upper) {
      record(4, 0, [(hi >> 8) & 0xff, hi & 0xff]);
      upper = hi;
    }
    record(0, addr & 0xffff, [...buf.subarray(off, off + 16)]);
  }
  record(1, 0, []);
  return lines.join('\r\n') + '\r\n';
}

// Symbol table in Wokwi's "$wokwisym" format (name=addr[,size], hex), read from an ELF32 file.
function elfSymbols(elf) {
  if (elf.readUInt32BE(0) !== 0x7f454c46 || elf[4] !== 1 || elf[5] !== 1) return '';
  const shoff = elf.readUInt32LE(0x20);
  const shentsize = elf.readUInt16LE(0x2e);
  const shnum = elf.readUInt16LE(0x30);
  const section = (i) => {
    const o = shoff + i * shentsize;
    return {
      type: elf.readUInt32LE(o + 4),
      offset: elf.readUInt32LE(o + 16),
      size: elf.readUInt32LE(o + 20),
      link: elf.readUInt32LE(o + 24),
      entsize: elf.readUInt32LE(o + 36),
    };
  };
  const lines = ['$wokwisym,version=1'];
  const seen = new Set();
  for (let i = 0; i < shnum; i++) {
    const symtab = section(i);
    if (symtab.type !== 2) continue; // SHT_SYMTAB
    const strtab = section(symtab.link);
    for (let o = symtab.offset; o < symtab.offset + symtab.size; o += symtab.entsize || 16) {
      const nameOff = elf.readUInt32LE(o);
      const value = elf.readUInt32LE(o + 4);
      const size = elf.readUInt32LE(o + 8);
      const type = elf[o + 12] & 0xf;
      const shndx = elf.readUInt16LE(o + 14);
      if (!nameOff || shndx === 0 || type === 3 || type === 4) continue; // undefined, SECTION, FILE
      const start = strtab.offset + nameOff;
      const name = elf.toString('latin1', start, elf.indexOf(0, start));
      if (name.startsWith('$') || seen.has(name)) continue;
      seen.add(name);
      lines.push(`${encodeURIComponent(name)}=${value.toString(16)}${size ? ',' + size.toString(16) : ''}`);
    }
  }
  // No trailing newline: Wokwi's parser chokes on an empty last line.
  return lines.join('\n');
}

async function readIf(file, encoding) {
  try {
    return await fsp.readFile(file, encoding);
  } catch {
    return null;
  }
}

async function collectOutput(outDir, fqbn, target) {
  const base = path.join(outDir, 'sketch.ino');
  if (fqbn.startsWith('esp32:') || target.startsWith('esp32')) {
    const bin = await readIf(base + '.bin');
    if (!bin) throw new Error('Build produced no sketch.ino.bin');
    // Symbols are always kept so a later request that asks for them can reuse this build.
    const elf = await readIf(base + '.elf');
    return { hex: bin.toString('base64'), eep: '', symbols: elf ? elfSymbols(elf) : undefined };
  }
  if (target === 'rp2040') {
    const bin = await readIf(base + '.bin');
    if (!bin) throw new Error('Build produced no sketch.ino.bin');
    return { hex: binToIhex(bin, 0x10000000), eep: '' };
  }
  const hex = await readIf(base + '.hex', 'utf8');
  if (!hex) throw new Error(`Don't know how to package output for target "${target}" (no sketch.ino.hex)`);
  return { hex, eep: (await readIf(base + '.eep', 'utf8')) || '' };
}

// --- Build ---------------------------------------------------------------

const cache = new Map();
const inFlight = new Map();
const locks = new Map();

function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(key, next.catch(() => {}));
  return next;
}

function resolveFqbn(board) {
  if (board.includes(':')) return board;
  const fqbn = BOARDS[board];
  if (!fqbn) {
    const err = new Error(`unknown board "${board}" (add it to boards.json to build it locally)`);
    err.status = 422; // tells the extension to fall back to the cloud compiler
    throw err;
  }
  return fqbn;
}

// Project file names from Wokwi, checked the same way on every OS: no absolute paths, drive
// letters or "..", and none of the characters Windows can't store in a file name.
function safeRelPath(name) {
  const parts = name.split(/[\\/]/);
  const ok = (p) => /^[^<>:"|?*\x00-\x1f]+$/.test(p) && p !== '.' && p !== '..';
  if (!parts.every(ok)) throw new Error(`Bad file name: ${name}`);
  return path.join(...parts);
}

// Show toolchain paths as /sketch/... and /build/..., whichever slash style the toolchain printed.
function tidyPaths(text, replacements) {
  for (const [dir, alias] of replacements) {
    for (const form of new Set([dir, dir.replace(/\\/g, '/')])) {
      text = text.split(form + '\\').join(alias + '/').split(form + '/').join(alias + '/').split(form).join(alias);
    }
  }
  return text;
}

async function build(req) {
  const board = String(req.board || '');
  const target = String(req.target || '');
  const files = Array.isArray(req.files) ? req.files : [];
  const fqbn = resolveFqbn(board);

  // Wokwi often sends the same sketch twice (a prebuild on page load, then the play button),
  // so identical requests share one build, whether it's finished or still running.
  const key = crypto.createHash('sha256').update(JSON.stringify([fqbn, target, req.sketch, files])).digest('hex');
  let pending = !req.options?.skipCache && (cache.get(key) || inFlight.get(key));
  if (pending) {
    log(`${board}: reusing ${cache.has(key) ? 'cached' : 'in-progress'} build`);
  } else {
    pending = compile(req, board, target, files, fqbn, key).finally(() => inFlight.delete(key));
    inFlight.set(key, pending);
  }
  const { symbols, ...result } = await pending;
  return req.options?.symbols && symbols ? { ...result, symbols } : result;
}

async function compile(req, board, target, files, fqbn, key) {
  const started = Date.now();
  const slot = path.join(WORK, fqbn.replace(/[^\w.-]+/g, '_'));
  return withLock(slot, async () => {
    const notes = [];
    await ensurePlatform(fqbn, notes);
    const libsFile = files.find((f) => f.name === 'libraries.txt');
    if (libsFile) await ensureLibraries(parseLibraries(String(libsFile.content)), notes);

    const sketchDir = path.join(slot, 'sketch');
    const buildDir = path.join(slot, 'build');
    const outDir = path.join(slot, 'out');
    // Retries cover Windows, where antivirus can briefly lock fresh build output.
    await fsp.rm(sketchDir, { recursive: true, force: true, maxRetries: 5 });
    await fsp.rm(outDir, { recursive: true, force: true, maxRetries: 5 });
    await fsp.mkdir(sketchDir, { recursive: true });
    await fsp.writeFile(path.join(sketchDir, 'sketch.ino'), String(req.sketch ?? ''));
    for (const f of files) {
      if (f.name === 'libraries.txt' || f.name === 'diagram.json') continue;
      const dest = path.join(sketchDir, safeRelPath(String(f.name)));
      await fsp.mkdir(path.dirname(dest), { recursive: true });
      await fsp.writeFile(dest, String(f.content ?? ''));
    }

    // A persistent build path per board lets arduino-cli reuse the compiled core between builds.
    const res = await run([
      'compile', '--fqbn', fqbn, '--no-color', ...skipFlags(fqbn.split(':')[0]),
      '--build-path', buildDir, '--output-dir', outDir, sketchDir,
    ]);
    const tidy = (s) => tidyPaths(s, [[sketchDir, '/sketch'], [buildDir, '/build']]);
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const header = [...notes, `Built locally by wokwi-local in ${secs}s (${fqbn})`].join('\n') + '\n';

    if (res.code !== 0) {
      log(`${board}: build failed in ${secs}s`);
      let stderr = tidy(res.stderr);
      for (const [needle, hint] of HOST_HINTS) {
        if (stderr.includes(needle)) stderr += `\nwokwi-local: ${hint}\n`;
      }
      return { stdout: header + tidy(res.stdout), stderr, hex: '', eep: '' };
    }
    const output = await collectOutput(outDir, fqbn, target);
    const result = { stdout: header + tidy(res.stdout), stderr: tidy(res.stderr), ...output };
    cache.set(key, result);
    if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
    log(`${board}: built in ${secs}s`);
    return result;
  });
}

// --- HTTP ----------------------------------------------------------------

function send(res, status, body, origin) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' };
  if (ALLOWED_ORIGINS.has(origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS';
    headers['Access-Control-Allow-Headers'] = 'Content-Type';
    headers['Access-Control-Allow-Private-Network'] = 'true';
    headers['Vary'] = 'Origin';
  }
  res.writeHead(status, headers);
  res.end(body === null ? '' : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !ALLOWED_ORIGINS.has(origin)) return send(res, 403, { error: 'origin not allowed' });
  if (req.method === 'OPTIONS') return send(res, 204, null, origin);

  const url = new URL(req.url, `http://${HOST}`);
  if (req.method === 'GET' && url.pathname === '/health') return send(res, 200, { ok: true }, origin);
  if (req.method !== 'POST' || url.pathname !== '/build') return send(res, 404, { error: 'not found' }, origin);

  let raw = '';
  for await (const chunk of req) raw += chunk;
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return send(res, 400, { error: 'invalid JSON' }, origin);
  }

  try {
    send(res, 200, await build(body), origin);
  } catch (err) {
    log(`error: ${err.message}`);
    send(res, err.status || 200, { stdout: '', stderr: `wokwi-local: ${err.message}\n`, hex: '', eep: '' }, origin);
  }
});

async function installCores(ids) {
  for (const id of ids.split(',').filter(Boolean)) {
    const notes = [];
    await ensurePlatform(id, notes);
    log(notes.length ? notes.join('\n') : `core ${id} already installed`);
  }
}

if (require.main === module) {
  if (LOG_FILE) {
    // Keep the log from growing forever: start over once it passes 5 MB.
    try {
      if (fs.statSync(LOG_FILE).size > 5e6) fs.renameSync(LOG_FILE, LOG_FILE + '.old');
    } catch {}
  }
  if (option('--install-cores')) {
    installCores(option('--install-cores')).catch((err) => {
      log(`error: ${err.message}`);
      process.exitCode = 1;
    });
  } else {
    // If another copy holds the port (say, one started by hand), wait for it rather than exiting,
    // so a login service takes over when it stops instead of restarting over and over.
    let waiting = false;
    server.on('error', (err) => {
      if (err.code !== 'EADDRINUSE') {
        log(`error: ${err.message}`);
        process.exit(1);
      }
      if (!waiting) log(`port ${PORT} is in use (another wokwi-local?); retrying every 10s`);
      waiting = true;
      setTimeout(() => server.listen(PORT, HOST), 10000);
    });
    server.listen(PORT, HOST, () => log(`wokwi-local listening on http://${HOST}:${PORT}`));
  }
}

module.exports = { skipFlags, safeRelPath, tidyPaths };
