'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

const sim = new KafkaSim();

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

function fmtNum(n) {
  return n >= 10000 ? `${Math.round(n / 1000)}k` : String(Math.round(n));
}

// ---- sparklines (same approach as the EKS dashboard) ----
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
  ctx.fillText(fmtNum(lastVal), w - 4, 11);
}

// ---------------------------------------------------------------- render

function render() {
  const s = sim.getState();

  $('#sim-clock').textContent = fmtClock(s.simTime);
  $$('.speed-controls button[data-speed]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.speed) === s.speed));

  const h = s.history;
  const lastH = h[h.length - 1] || {};
  $('#stat-produce').textContent = fmtNum(lastH.produceRate || 0);
  $('#stat-consume').textContent = fmtNum(lastH.consumeRate || 0);
  const lagEl = $('#stat-lag');
  lagEl.textContent = fmtNum(lastH.totalLag || 0);
  lagEl.className = 'stat-value' + ((lastH.totalLag || 0) > 3000 ? ' bad' : (lastH.totalLag || 0) > 500 ? ' warn' : '');
  const errEl = $('#stat-errors');
  errEl.textContent = fmtNum(lastH.errors || 0);
  errEl.className = 'stat-value' + ((lastH.errors || 0) > 0 ? ' bad' : '');

  if (h.length >= 2) {
    const col = k => h.map(p => p[k] || 0);
    drawChart('#chart-throughput', [
      { data: col('produceRate'), color: '#e8a33d', fill: 'rgba(232,163,61,0.12)' },
      { data: col('consumeRate'), color: '#4cc38a' },
    ]);
    drawChart('#chart-lag', [
      { data: col('totalLag'), color: '#e05c5c', fill: 'rgba(224,92,92,0.12)' },
    ], { minMax: 100 });
  }

  // rebalance banner
  $('#rebalance-note').innerHTML = s.consumerGroup.rebalanceRemaining > 0
    ? `<div class="rebalance-banner">⏳ Rebalancing (generation ${s.consumerGroup.generation}) — consumption paused ${s.consumerGroup.rebalanceRemaining}s. Lag is building!</div>`
    : '';

  // partitions
  const maxLag = Math.max(100, ...s.partitions.map(p => p.lag));
  $('#partitions-box').innerHTML = s.partitions.map(p => {
    const pct = Math.min(100, (p.lag / maxLag) * 100);
    const leader = s.brokers[p.leader].alive && !p.electing
      ? `broker-${p.leader}` : (p.electing ? '⚡ electing…' : '☠ no leader');
    return `<div class="partition-row ${p.electing ? 'electing' : ''}">
      <b>P${p.id}${p.id === 0 && s.producer.keySkew > 0 ? ' 🔥' : ''}</b>
      <span class="dim">${leader}</span>
      <span class="dim">${p.consumer || '— unassigned'}</span>
      <div class="lag-bar" title="lag: ${fmtNum(p.lag)} messages"><i class="${pct > 60 ? 'hot' : ''}" style="width:${pct}%"></i></div>
      <span style="text-align:right">${fmtNum(p.lag)}</span>
    </div>`;
  }).join('');

  // consumers
  $('#consumers-box').innerHTML = s.consumerGroup.consumers.map(c => {
    const owned = s.partitions.filter(p => p.consumer === c.id).length;
    return `<span class="consumer-chip">${c.id} · ${owned}p${owned === 0 ? ' 💤 idle' : ''}</span>`;
  }).join('') || '<span class="dim">no consumers — lag grows forever</span>';

  // brokers
  $('#brokers-box').innerHTML = s.brokers.map(b =>
    `<span class="broker-chip ${b.alive ? '' : 'dead'}">broker-${b.id}
      <button data-broker="${b.id}" data-action="${b.alive ? 'kill' : 'restart'}" class="${b.alive ? 'danger' : ''}">${b.alive ? '💀 kill' : '🔁 restart'}</button>
    </span>`).join('');
  $$('#brokers-box button').forEach(btn => btn.addEventListener('click', () => {
    try {
      if (btn.dataset.action === 'kill') sim.killBroker(Number(btn.dataset.broker));
      else sim.restartBroker(Number(btn.dataset.broker));
      render();
    } catch (err) { alert(err.message); }
  }));

  // events
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
  if (!confirm('Reset the Kafka simulation?')) return;
  sim.reset();
  syncSliders();
  render();
});

function bindSlider(slider, label, fmt, apply) {
  $(slider).addEventListener('input', e => {
    $(label).textContent = fmt(e.target.value);
    apply(Number(e.target.value));
  });
}
bindSlider('#rps-slider', '#rps-label', v => v, v => sim.setProducer({ rps: v }));
bindSlider('#skew-slider', '#skew-label', v => v, v => sim.setProducer({ keySkew: v / 100 }));
bindSlider('#cap-slider', '#cap-label', v => v, v => sim.setConsumerCapacity(v));
$('#part-slider').addEventListener('change', e => {
  try {
    const n = sim.setPartitionCount(Number(e.target.value));
    e.target.value = n;
    $('#part-label').textContent = n;
  } catch (err) {
    alert(err.message);
    e.target.value = sim.partitions.length;
    $('#part-label').textContent = sim.partitions.length;
  }
});
$('#part-slider').addEventListener('input', e => { $('#part-label').textContent = e.target.value; });

$('#btn-add-consumer').addEventListener('click', () => { sim.addConsumer(); render(); });
$('#btn-rm-consumer').addEventListener('click', () => { sim.removeConsumer(); render(); });

function syncSliders() {
  $('#rps-slider').value = sim.producer.rps; $('#rps-label').textContent = sim.producer.rps;
  $('#skew-slider').value = sim.producer.keySkew * 100; $('#skew-label').textContent = Math.round(sim.producer.keySkew * 100);
  $('#cap-slider').value = sim.consumerGroup.perConsumerCapacity; $('#cap-label').textContent = sim.consumerGroup.perConsumerCapacity;
  $('#part-slider').value = sim.partitions.length; $('#part-label').textContent = sim.partitions.length;
}

syncSliders();
render();
