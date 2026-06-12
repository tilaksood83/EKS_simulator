'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const sim = new ResilienceSim();

// wall-clock driven tick loop (background tabs throttle timers)
let carry = 0;
let last = Date.now();
setInterval(() => {
  const now = Date.now();
  carry += ((now - last) / 1000) * sim.speed;
  last = now;
  carry = Math.min(carry, 30);
  while (carry >= 1) { sim.tick(); carry -= 1; }
}, 250);

function fmtClock(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  return `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function drawChart(canvasId, series, opts = {}) {
  const canvas = $(canvasId);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w) return;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const all = series.flatMap(s => s.data);
  const max = Math.max(opts.minMax || 1, ...all) * 1.1;
  const n = Math.max(2, series[0].data.length);
  const x = i => (i / (n - 1)) * w;
  const y = v => h - (v / max) * (h - 4) - 2;
  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    s.data.forEach((v, i) => i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)));
    ctx.stroke();
    if (s.fill) {
      ctx.lineTo(x(s.data.length - 1), h); ctx.lineTo(0, h); ctx.closePath();
      ctx.fillStyle = s.fill; ctx.fill();
    }
  }
  const lastVal = series[0].data[series[0].data.length - 1];
  ctx.fillStyle = '#aab8cc'; ctx.font = '10px Segoe UI'; ctx.textAlign = 'right';
  ctx.fillText(String(Math.round(lastVal)) + (opts.suffix || ''), w - 4, 11);
}

function svcBox(s, state) {
  const cls = s.util > 150 || s.pFail > 50 ? 'burning' : s.util > 90 || s.pFail > 15 ? 'hot' : '';
  const barCls = s.util > 100 ? 'bad' : s.util > 80 ? 'warn' : '';
  const inj = [];
  if (s.injLatency) inj.push(`+${s.injLatency}ms`);
  if (s.injErrorPct) inj.push(`${s.injErrorPct}% err`);
  return `<div class="svc-box ${cls}">
    <h3>${s.name === 'db' ? '🗄' : s.name === 'api' ? '⚙️' : '🌐'} ${s.name}${inj.length ? ` <span class="dim">(${inj.join(', ')})</span>` : ''}</h3>
    <div class="dim">${s.load} / ${s.capacity} req/s · ${s.latency}ms · fail ${s.pFail}%</div>
    <div class="util-bar"><i class="${barCls}" style="width:${Math.min(100, s.util)}%"></i></div>
  </div>`;
}

function arrow(hopName, hop) {
  const badge = hop.breakerEnabled
    ? `<span class="cb-badge ${hop.breakerState}">CB ${hop.breakerState}${hop.breakerState === 'open' ? ` ${hop.breakerRemaining}s` : ''}</span>`
    : '<span class="dim">no breaker</span>';
  return `<div class="arrow">➜<br>${hop.timeoutMs}ms · ${hop.retries}r<br>${badge}</div>`;
}

function render() {
  const s = sim.getState();
  $('#sim-clock').textContent = fmtClock(s.simTime);
  $$('.speed-controls button[data-speed]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.speed) === s.speed));

  const h = s.history;
  const lastH = h[h.length - 1] || {};
  const sEl = $('#stat-success');
  sEl.textContent = `${lastH.clientSuccess ?? 100}%`;
  sEl.className = 'stat-value' + ((lastH.clientSuccess ?? 100) < 70 ? ' bad' : (lastH.clientSuccess ?? 100) < 95 ? ' warn' : '');
  const lEl = $('#stat-latency');
  lEl.textContent = `${lastH.e2eLatency ?? 0}ms`;
  lEl.className = 'stat-value' + ((lastH.e2eLatency ?? 0) > 1500 ? ' bad' : (lastH.e2eLatency ?? 0) > 400 ? ' warn' : '');

  const db = s.services[2];
  const dEl = $('#stat-dbload');
  dEl.textContent = db.load;
  dEl.className = 'stat-value' + (db.util > 150 ? ' bad' : db.util > 90 ? ' warn' : '');
  $('#stat-dbload-sub').textContent = `req/s (cap ${db.capacity})`;

  const api = s.services[1];
  const amp = api.load > 0 ? (db.load / Math.max(1, api.load)) : 1;
  const aEl = $('#stat-amp');
  aEl.textContent = `${amp.toFixed(1)}×`;
  aEl.className = 'stat-value' + (amp > 2.5 ? ' bad' : amp > 1.5 ? ' warn' : '');

  $('#pipeline').innerHTML =
    `<div class="arrow">👥<br>${s.clientRps} req/s<br>➜</div>` +
    svcBox(s.services[0], s) + arrow('web->api', s.hops['web->api']) +
    svcBox(s.services[1], s) + arrow('api->db', s.hops['api->db']) +
    svcBox(s.services[2], s);

  if (h.length >= 2) {
    const col = k => h.map(p => p[k] || 0);
    drawChart('#chart-success', [
      { data: col('clientSuccess'), color: '#4cc38a', fill: 'rgba(76,195,138,0.12)' },
    ], { minMax: 100, suffix: '%' });
    drawChart('#chart-load', [
      { data: col('dbLoad'), color: '#e05c5c', fill: 'rgba(224,92,92,0.10)' },
      { data: col('apiLoad'), color: '#e8a33d' },
      { data: col('webLoad'), color: '#6ca0f6' },
    ], { minMax: 100 });
  }

  $('#events-box').innerHTML = [...s.events].reverse().map(e =>
    `<div class="event-row ${e.type}">
      <span class="ev-time">${fmtClock(e.time)}</span><span class="ev-reason">${e.reason}</span>
      <span>${e.message}</span>
    </div>`).join('');
}
setInterval(render, 1000);

// ---------------------------------------------------------------- controls

$$('.speed-controls button[data-speed]').forEach(b =>
  b.addEventListener('click', () => { sim.setSpeed(Number(b.dataset.speed)); render(); }));
$('#btn-ff').addEventListener('click', () => { sim.advance(60); render(); });
$('#btn-reset').addEventListener('click', () => {
  if (!confirm('Reset the resilience simulation?')) return;
  sim.reset();
  syncControls();
  render();
});

$('#rps-slider').addEventListener('input', e => {
  $('#rps-label').textContent = e.target.value;
  sim.setClientRps(e.target.value);
});

function wireHop(prefix, hopName) {
  $(`#${prefix}-timeout`).addEventListener('input', e => {
    $(`#${prefix}-timeout-label`).textContent = e.target.value;
    sim.setHop(hopName, { timeoutMs: e.target.value });
  });
  $(`#${prefix}-retries`).addEventListener('change', e => sim.setHop(hopName, { retries: e.target.value }));
  $(`#${prefix}-backoff`).addEventListener('change', e => sim.setHop(hopName, { backoff: e.target.value }));
  $(`#${prefix}-breaker`).addEventListener('change', e => { sim.setHop(hopName, { breakerEnabled: e.target.checked }); render(); });
}
wireHop('wa', 'web->api');
wireHop('ad', 'api->db');

$('#btn-db-slow').addEventListener('click', () => {
  sim.inject('db', { injLatency: 800 });
  sim.event('Warning', 'ChaosInjected', 'db latency +800ms (brownout)');
  syncControls(); render();
});
$('#btn-api-err').addEventListener('click', () => {
  sim.inject('api', { injErrorPct: 30 });
  sim.event('Warning', 'ChaosInjected', 'api now failing 30% of requests');
  syncControls(); render();
});
$('#btn-heal').addEventListener('click', () => { sim.healAll(); syncControls(); render(); });

$('#dblat-slider').addEventListener('input', e => {
  $('#dblat-label').textContent = e.target.value;
  sim.inject('db', { injLatency: e.target.value });
});
$('#apierr-slider').addEventListener('input', e => {
  $('#apierr-label').textContent = e.target.value;
  sim.inject('api', { injErrorPct: e.target.value });
});

function syncControls() {
  $('#rps-slider').value = sim.clientRps; $('#rps-label').textContent = sim.clientRps;
  const wa = sim.hops['web->api'], ad = sim.hops['api->db'];
  $('#wa-timeout').value = wa.timeoutMs; $('#wa-timeout-label').textContent = wa.timeoutMs;
  $('#wa-retries').value = wa.retries; $('#wa-backoff').value = wa.backoff; $('#wa-breaker').checked = wa.breakerEnabled;
  $('#ad-timeout').value = ad.timeoutMs; $('#ad-timeout-label').textContent = ad.timeoutMs;
  $('#ad-retries').value = ad.retries; $('#ad-backoff').value = ad.backoff; $('#ad-breaker').checked = ad.breakerEnabled;
  $('#dblat-slider').value = sim.services.db.injLatency; $('#dblat-label').textContent = sim.services.db.injLatency;
  $('#apierr-slider').value = sim.services.api.injErrorPct; $('#apierr-label').textContent = sim.services.api.injErrorPct;
}

syncControls();
render();
