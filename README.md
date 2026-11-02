# wokwi-local

Compile wokwi.com sketches on your own machine instead of waiting in Wokwi's cloud build queue.
The simulator still runs in the wokwi.com page as usual; only the compile step moves local.

- `server.js`: a small Node server (no dependencies) on `127.0.0.1:9420` that speaks the same
  protocol as `https://wokwi.com/build` and compiles with `arduino-cli`.
- `extension/`: a Chrome extension that sends wokwi.com's compile requests to that server.
  If the server isn't running, Wokwi's cloud compiler is used as normal.

## Setup

You need Node 18 or newer and `arduino-cli`. The server runs on macOS, Windows and Linux.

| OS | Install arduino-cli | Notes |
| --- | --- | --- |
| macOS | `brew install arduino-cli` | On Apple Silicon, also run `softwareupdate --install-rosetta` once: some tools Arduino bundles (`ctags`, used for every board, and the AVR compiler) are Intel-only. |
| Windows | `winget install ArduinoSA.CLI` | If ESP32 builds fail with path-length errors, set `WOKWI_LOCAL_WORK` to a short folder such as `C:\wl`. |
| Linux | `curl -fsSL https://raw.githubusercontent.com/arduino/arduino-cli/master/install.sh \| BINDIR=~/.local/bin sh` | Make sure `~/.local/bin` is on your `PATH`. |

If `arduino-cli` isn't on your `PATH`, point the server at it with the `ARDUINO_CLI` environment
variable.

1. Load the extension: open `chrome://extensions`, turn on **Developer mode**, click
   **Load unpacked**, and pick the `extension` folder. Edge, Brave and Arc work the same way.
2. Start the server from this folder: `node server.js`

The first time Chrome asks whether wokwi.com may access devices on your local network, click
**Allow**: that permission lets the page reach the server on localhost.

## Usage

Press play on wokwi.com as usual. To confirm a build ran locally, check that the server's
terminal printed a `built in …` line for it, or that the page's devtools console shows
`[wokwi-local] compiled locally`.

- Missing board cores (ESP32, Pi Pico, ATtiny) are installed automatically on first use, which takes
  a few minutes once.
- The ESP32 core is pinned to 3.3.7, the version Wokwi's cloud compiler uses, so local builds
  match what Wokwi's simulator is tested against. If Wokwi upgrades, change `PINNED_VERSIONS` in
  `server.js`. Wokwi's version is visible in its cloud build's app descriptor (IDF version and
  build date).
- `arduino-cli` shares its board folder with the Arduino IDE. If the IDE upgrades the ESP32 core,
  the next build puts 3.3.7 back, which re-downloads a few GB. To keep them apart, start the
  server with `ARDUINO_DIRECTORIES_DATA` set to a separate folder; that folder then holds its own
  copy of every core.
- Libraries in `libraries.txt` are installed with `arduino-cli lib install` into `arduino-user/`,
  so they don't end up in your regular Arduino sketchbook. Custom libraries uploaded to Wokwi
  (`@wokwi:` entries) can't be fetched and are skipped.
- To use the cloud compiler for a while without unloading the extension, run
  `localStorage.wokwiLocal = 'off'` in the page's devtools console (`'on'` turns it back on).

## Boards

Boards Wokwi sends as an FQBN (all ESP32 variants) work as-is. Short names are mapped in
`boards.json`. A board that isn't listed is compiled by Wokwi's cloud as before, and the
server logs `unknown board "xyz"`; add that name with the FQBN you want arduino-cli to use.

| Wokwi board | Output sent back |
| --- | --- |
| Uno, Mega, Nano, ATtiny85 | Intel HEX + EEPROM |
| Raspberry Pi Pico (Arduino) | Intel HEX at 0x10000000 (arduino-pico core) |
| ESP32, -S2, -S3, -C3, -C6, -H2 | base64 app `.bin` + symbol table |

Only compile requests are redirected. Everything else on wokwi.com goes to Wokwi untouched.

## Tests

`npm test` starts a copy of the server on a random port and runs real builds for Uno, Pi Pico,
ESP32 and ESP32-S3, plus tests of the extension and the OS-specific code. The first run installs
any missing cores, which takes a while (ESP32 is a few GB). To test only some boards, list them:
`WOKWI_TEST_BOARDS=uno,pipico npm test`.

GitHub Actions runs the same tests on Windows, Linux and macOS for every push
(`.github/workflows/test.yml`).
