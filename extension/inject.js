// Runs in the wokwi.com page. Sends POST /build to the local server when it's running,
// and falls back to Wokwi's cloud compiler when it isn't.
// Turn off temporarily from the devtools console with: localStorage.wokwiLocal = 'off'
(() => {
  const LOCAL = 'http://127.0.0.1:9420';
  const realFetch = window.fetch;
  let localAlive = false;
  let inFlight = 0;

  function enabled() {
    try {
      return localStorage.getItem('wokwiLocal') !== 'off';
    } catch {
      return true;
    }
  }

  async function checkLocal() {
    try {
      localAlive = (await realFetch(LOCAL + '/health', { cache: 'no-store' })).ok;
    } catch {
      localAlive = false;
    }
    return localAlive;
  }

  function json(body) {
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } });
  }

  window.fetch = async function (input, init = {}) {
    let url;
    try {
      url = new URL(input instanceof Request ? input.url : String(input), location.href);
    } catch {
      return realFetch.apply(this, arguments);
    }
    if (url.origin !== location.origin || !enabled()) return realFetch.apply(this, arguments);

    const method = (init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();

    if (url.pathname === '/build' && method === 'POST' && (await checkLocal())) {
      const body = init.body ?? (input instanceof Request ? await input.clone().text() : undefined);
      inFlight++;
      try {
        const res = await realFetch(LOCAL + '/build', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
          signal: init.signal,
        });
        if (res.status !== 422) {
          console.info('[wokwi-local] compiled locally');
          return res;
        }
        console.info('[wokwi-local]', (await res.json()).stderr.trim(), '- using the cloud');
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        console.warn('[wokwi-local] local build failed, falling back to the cloud', err);
      } finally {
        inFlight--;
      }
    }

    // Queue-position polling: report our own state instead of the cloud queue.
    if (url.pathname === '/build/position' && localAlive) {
      return json({ state: inFlight ? 'running' : 'none', ahead: 0, capacity: 1, queueSize: 0 });
    }

    return realFetch.apply(this, arguments);
  };
})();
