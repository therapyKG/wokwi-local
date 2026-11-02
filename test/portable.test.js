// OS-specific logic, checked with Windows-, Linux- and macOS-style inputs on whatever OS runs it.
const test = require('node:test');
const assert = require('node:assert');
const { skipFlags, safeRelPath, tidyPaths } = require('../server.js');

const values = (flags) => flags.filter((f) => f !== '--build-property');

test('Windows skips ESP32 steps with cmd, including the .windows recipe variants', () => {
  const flags = values(skipFlags('esp32', 'win32'));
  assert.strictEqual(flags.length, 6);
  assert.ok(flags.every((f) => f.endsWith('=cmd /c exit 0')));
  assert.ok(flags.includes('recipe.hooks.prebuild.4.pattern.windows=cmd /c exit 0'));
});

test('macOS and Linux skip ESP32 steps with true', () => {
  for (const platform of ['darwin', 'linux']) {
    assert.deepStrictEqual(values(skipFlags('esp32', platform)), [
      'recipe.hooks.prebuild.4.pattern=true',
      'recipe.objcopy.partitions.bin.pattern=true',
      'recipe.hooks.objcopy.postobjcopy.3.pattern=true',
    ]);
  }
});

test('other boards skip nothing', () => {
  assert.deepStrictEqual(skipFlags('arduino', 'win32'), []);
  assert.deepStrictEqual(skipFlags('rp2040', 'linux'), []);
});

test('compiler paths become /sketch and /build in any slash style', () => {
  const sketch = 'C:\\Users\\kurt\\wokwi-local\\.work\\esp32_esp32_esp32\\sketch';
  const build = 'C:\\Users\\kurt\\wokwi-local\\.work\\esp32_esp32_esp32\\build';
  const dirs = [[sketch, '/sketch'], [build, '/build']];
  assert.strictEqual(tidyPaths(`${sketch}\\sketch.ino:1:15: error: 'oops'`, dirs), "/sketch/sketch.ino:1:15: error: 'oops'");
  assert.strictEqual(
    tidyPaths('C:/Users/kurt/wokwi-local/.work/esp32_esp32_esp32/sketch/util.h:3: note', dirs),
    '/sketch/util.h:3: note',
  );
  assert.strictEqual(tidyPaths(`from ${build}\\sketch\\sketch.ino.cpp:1:`, dirs), 'from /build/sketch\\sketch.ino.cpp:1:');
  assert.strictEqual(
    tidyPaths('/home/k/wl/.work/x/sketch/sketch.ino:2:1: error', [['/home/k/wl/.work/x/sketch', '/sketch']]),
    '/sketch/sketch.ino:2:1: error',
  );
});

test('project file names are accepted the same way on every OS', () => {
  assert.strictEqual(safeRelPath('util.h'), 'util.h');
  assert.strictEqual(safeRelPath('notes (1).h'), 'notes (1).h');
  assert.deepStrictEqual(safeRelPath('src/lib/a.cpp').split(/[\\/]/), ['src', 'lib', 'a.cpp']);
});

test('unsafe file names are rejected on every OS', () => {
  for (const bad of ['../x.h', 'src/../../x', '/etc/passwd', 'C:\\x.h', 'C:x.h', '\\\\server\\share\\x', 'a\\..\\..\\b', '', 'x?.h']) {
    assert.throws(() => safeRelPath(bad), /Bad file name/, `should reject ${JSON.stringify(bad)}`);
  }
});
