'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { Simulator } = require('./src/engine');

const PORT = process.env.PORT || process.argv[2] || 3000;
const PUBLIC_DIR = path.join(__dirname, 'public');

const sim = new Simulator();

// Real-time loop: `speed` simulated seconds per real second (speed 0 = paused).
let carry = 0;
setInterval(() => {
  carry += sim.speed / 4;
  while (carry >= 1) {
    sim.tick();
    carry -= 1;
  }
}, 250);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function json(res, code, body) {
  const data = JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(data);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', c => {
      data += c;
      if (data.length > 1e6) { reject(new Error('body too large')); req.destroy(); }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try { resolve(JSON.parse(data)); }
      catch { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const parts = url.pathname.split('/').filter(Boolean); // ['api', ...]
  const route = `${req.method} /${parts.slice(0, 3).join('/')}`;

  // GET routes
  if (req.method === 'GET') {
    if (url.pathname === '/api/state') return json(res, 200, sim.getState());
    if (url.pathname === '/api/events') return json(res, 200, sim.events.slice(-200));
    if (parts[1] === 'pods' && parts[3] === 'logs') {
      const logs = sim.getPodLogs(decodeURIComponent(parts[2]));
      return logs ? json(res, 200, logs) : json(res, 404, { error: 'pod not found' });
    }
    if (parts[1] === 'components' && parts[3] === 'logs') {
      const logs = sim.getComponentLogs(decodeURIComponent(parts[2]));
      return logs ? json(res, 200, logs) : json(res, 404, { error: 'component not found' });
    }
    return json(res, 404, { error: `no route ${route}` });
  }

  const body = await readBody(req);

  try {
    if (req.method === 'POST' && url.pathname === '/api/reset') {
      sim.reset(body);
      return json(res, 200, { ok: true });
    }
    if (req.method === 'PUT' && url.pathname === '/api/cluster') {
      return json(res, 200, sim.updateCluster(body));
    }
    if (req.method === 'PUT' && url.pathname === '/api/nodegroup') {
      return json(res, 200, sim.updateNodeGroup(body));
    }
    if (req.method === 'POST' && url.pathname === '/api/deployments') {
      return json(res, 201, { ok: true, name: sim.addDeployment(body).name });
    }
    if (parts[1] === 'deployments' && parts[2]) {
      const name = decodeURIComponent(parts[2]);
      if (req.method === 'PUT') return json(res, 200, { ok: true, name: sim.updateDeployment(name, body).name });
      if (req.method === 'DELETE') { sim.deleteDeployment(name); return json(res, 200, { ok: true }); }
    }
    if (req.method === 'POST' && parts[1] === 'pods' && parts[3] === 'kill') {
      return json(res, 200, sim.killPod(decodeURIComponent(parts[2])));
    }
    if (req.method === 'POST' && url.pathname === '/api/chaos/kill-random-pod') {
      return json(res, 200, sim.killPod(null));
    }
    if (req.method === 'POST' && url.pathname === '/api/load') {
      return json(res, 200, sim.setLoad(body));
    }
    if (req.method === 'POST' && url.pathname === '/api/load/burst') {
      return json(res, 200, sim.burst(body.requests));
    }
    if (req.method === 'POST' && url.pathname === '/api/load/spike') {
      return json(res, 200, sim.spike(body.magnitude, body.durationSeconds));
    }
    if (req.method === 'POST' && url.pathname === '/api/load/ramp') {
      return json(res, 200, sim.ramp(body.to, body.durationSeconds));
    }
    if (req.method === 'POST' && url.pathname === '/api/speed') {
      return json(res, 200, { speed: sim.setSpeed(body.speed) });
    }
    if (req.method === 'POST' && url.pathname === '/api/advance') {
      return json(res, 200, sim.advance(body.seconds));
    }
    return json(res, 404, { error: `no route ${route}` });
  } catch (err) {
    return json(res, 400, { error: err.message });
  }
}

function serveStatic(req, res, url) {
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  file = path.normalize(file).replace(/^(\.\.[/\\])+/, '');
  const full = path.join(PUBLIC_DIR, file);
  if (!full.startsWith(PUBLIC_DIR)) {
    res.writeHead(403); return res.end('forbidden');
  }
  fs.readFile(full, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(req, res, url);
  } catch (err) {
    json(res, 500, { error: err.message });
  }
});

server.listen(PORT, () => {
  console.log(`EKS Simulator running at http://localhost:${PORT}`);
});
