'use strict';

// Solo mode: the simulation runs entirely in this browser tab. This shim
// intercepts the app's fetch('/api/...') calls and routes them to a local
// Simulator instance instead of the server, mirroring server.js routing —
// so ../app.js is reused byte-for-byte in both shared and solo modes.
(() => {
  const sim = new EKS.Simulator();

  // Real-time loop: `speed` simulated seconds per wall-clock second. Driven
  // by elapsed time (not fixed increments) because browsers throttle timers
  // in background tabs; the cap keeps the catch-up burst sane after a long
  // time away.
  let carry = 0;
  let last = Date.now();
  setInterval(() => {
    const now = Date.now();
    carry += ((now - last) / 1000) * sim.speed;
    last = now;
    carry = Math.min(carry, 30);
    while (carry >= 1) {
      sim.tick();
      carry -= 1;
    }
  }, 250);

  const realFetch = window.fetch.bind(window);
  const json = (code, body) => new Response(JSON.stringify(body), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
  });

  function route(method, pathname, body) {
    const parts = pathname.split('/').filter(Boolean); // ['api', ...]
    const name = parts[2] ? decodeURIComponent(parts[2]) : null;

    if (method === 'GET') {
      if (pathname === '/api/state') return json(200, sim.getState());
      if (pathname === '/api/events') return json(200, sim.events.slice(-200));
      if (parts[1] === 'pods' && parts[3] === 'logs') {
        const logs = sim.getPodLogs(name);
        return logs ? json(200, logs) : json(404, { error: 'pod not found' });
      }
      if (parts[1] === 'components' && parts[3] === 'logs') {
        const logs = sim.getComponentLogs(name);
        return logs ? json(200, logs) : json(404, { error: 'component not found' });
      }
      return json(404, { error: `no route GET ${pathname}` });
    }

    if (method === 'POST' && pathname === '/api/reset') { sim.reset(body); return json(200, { ok: true }); }
    if (method === 'PUT' && pathname === '/api/cluster') return json(200, sim.updateCluster(body));
    if (method === 'PUT' && pathname === '/api/nodegroup') return json(200, sim.updateNodeGroup(body));
    if (method === 'POST' && pathname === '/api/deployments') return json(201, { ok: true, name: sim.addDeployment(body).name });
    if (parts[1] === 'deployments' && parts[2]) {
      if (method === 'PUT') return json(200, { ok: true, name: sim.updateDeployment(name, body).name });
      if (method === 'DELETE') { sim.deleteDeployment(name); return json(200, { ok: true }); }
    }
    if (method === 'POST' && parts[1] === 'pods' && parts[3] === 'kill') return json(200, sim.killPod(name));
    if (method === 'POST' && pathname === '/api/chaos/kill-random-pod') return json(200, sim.killPod(null));
    if (method === 'POST' && pathname === '/api/load') return json(200, sim.setLoad(body));
    if (method === 'POST' && pathname === '/api/load/burst') return json(200, sim.burst(body.requests));
    if (method === 'POST' && pathname === '/api/load/spike') return json(200, sim.spike(body.magnitude, body.durationSeconds));
    if (method === 'POST' && pathname === '/api/load/ramp') return json(200, sim.ramp(body.to, body.durationSeconds));
    if (method === 'POST' && pathname === '/api/speed') return json(200, { speed: sim.setSpeed(body.speed) });
    if (method === 'POST' && pathname === '/api/advance') return json(200, sim.advance(body.seconds));
    return json(404, { error: `no route ${method} ${pathname}` });
  }

  window.fetch = (input, init = {}) => {
    const target = typeof input === 'string' ? input : input.url;
    const url = new URL(target, location.origin);
    if (!url.pathname.startsWith('/api/')) return realFetch(input, init);
    const method = (init.method || 'GET').toUpperCase();
    let body = {};
    if (init.body) {
      try { body = JSON.parse(init.body); } catch { return Promise.resolve(json(400, { error: 'invalid JSON body' })); }
    }
    try {
      return Promise.resolve(route(method, url.pathname, body));
    } catch (err) {
      return Promise.resolve(json(400, { error: err.message }));
    }
  };
})();
