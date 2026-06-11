'use strict';

const $ = sel => document.querySelector(sel);
const $$ = sel => [...document.querySelectorAll(sel)];

let state = null;
let selectedPod = null;
let editingDeployment = 'web-api';
let lastSeenEventCount = 0;
let explainerTimer = null;

// ---------------------------------------------------------------- API helpers

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${method} ${path} failed (${res.status})`);
  return data;
}

// ------------------------------------------------------------------- polling

async function poll() {
  try {
    state = await api('GET', '/api/state');
    render();
  } catch (err) {
    $('#cluster-status').textContent = 'UNREACHABLE';
  }
}
setInterval(poll, 1000);

// -------------------------------------------------------------------- render

function fmtClock(s) {
  const m = Math.floor(s / 60), sec = s % 60;
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
               : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function render() {
  const s = state;

  // header
  $('#cluster-name').textContent = s.cluster.name;
  $('#cluster-status').textContent = s.cluster.status;
  $('#cluster-meta').textContent = `v${s.cluster.version} · ${s.cluster.region}`;
  $('#sim-clock').textContent = fmtClock(s.simTime);
  $('#cost-hourly').textContent = `$${s.cost.hourly.toFixed(3)}/hr`;
  $('#cost-total').textContent = `($${s.cost.total.toFixed(3)} total)`;
  $$('.speed-controls button[data-speed]').forEach(b =>
    b.classList.toggle('active', Number(b.dataset.speed) === s.speed));

  renderStats();
  renderCharts();
  renderTopology();
  renderEvents();
  renderLogSelect();
  refreshSelectedPodLogs();
  syncForms();
  maybeExplain();
}

function renderStats() {
  const s = state;
  const pods = s.deployments.flatMap(d => d.pods);
  const running = pods.filter(p => p.phase === 'Running').length;
  const pending = pods.filter(p => p.phase === 'Pending').length;
  const creating = pods.filter(p => p.phase === 'ContainerCreating').length;
  const ready = s.nodes.filter(n => n.status === 'Ready').length;
  const booting = s.nodes.filter(n => n.status === 'Provisioning').length;
  const last = s.history[s.history.length - 1] || {};
  const avgCpu = last.avgCpuUtil || 0;
  const p99 = last.p99 || 0;
  const errors = last.errors || 0;

  $('#stat-rps').textContent = Math.round(s.load.currentRps);
  const cpuEl = $('#stat-cpu');
  cpuEl.textContent = `${Math.round(avgCpu)}%`;
  cpuEl.className = 'stat-value' + (avgCpu > 100 ? ' bad' : avgCpu > 75 ? ' warn' : '');
  $('#stat-pods').textContent = running;
  $('#stat-pods-sub').textContent =
    (pending || creating) ? `running · ${creating} starting · ${pending} pending` : 'running';
  $('#stat-nodes').textContent = ready;
  $('#stat-nodes-sub').textContent = booting ? `ready · ${booting} booting` : 'ready';
  const p99El = $('#stat-p99');
  p99El.textContent = `${p99}ms`;
  p99El.className = 'stat-value' + (p99 > 150 ? ' bad' : p99 > 60 ? ' warn' : '');
  const errEl = $('#stat-errors');
  errEl.textContent = Math.round(errors);
  errEl.className = 'stat-value' + (errors > 0 ? ' bad' : '');
}

// ---- charts (hand-rolled sparklines) ----

function drawChart(canvasId, series, opts = {}) {
  const canvas = $(canvasId);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const all = series.flatMap(s => s.data);
  let max = Math.max(opts.minMax || 1, ...all) * 1.1;
  const n = Math.max(2, series[0].data.length);
  const x = i => (i / (n - 1)) * w;
  const y = v => h - (v / max) * (h - 4) - 2;

  if (opts.refLine !== undefined) {
    max = Math.max(max, opts.refLine * 1.2);
    ctx.strokeStyle = '#666';
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(0, y(opts.refLine));
    ctx.lineTo(w, y(opts.refLine));
    ctx.stroke();
    ctx.setLineDash([]);
  }

  for (const s of series) {
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.width || 1.6;
    if (s.dash) ctx.setLineDash(s.dash);
    ctx.beginPath();
    s.data.forEach((v, i) => i === 0 ? ctx.moveTo(x(i), y(v)) : ctx.lineTo(x(i), y(v)));
    ctx.stroke();
    ctx.setLineDash([]);
    if (s.fill) {
      ctx.lineTo(x(s.data.length - 1), h);
      ctx.lineTo(0, h);
      ctx.closePath();
      ctx.fillStyle = s.fill;
      ctx.fill();
    }
  }
  // current value label
  const lastVal = series[0].data[series[0].data.length - 1];
  ctx.fillStyle = '#aab8cc';
  ctx.font = '10px Segoe UI';
  ctx.textAlign = 'right';
  ctx.fillText(opts.fmt ? opts.fmt(lastVal) : String(Math.round(lastVal)), w - 4, 11);
}

function renderCharts() {
  const h = state.history;
  if (h.length < 2) return;
  const col = key => h.map(p => p[key] || 0);
  const target = state.deployments[0]?.hpa.targetCPUUtilization;

  drawChart('#chart-rps', [
    { data: col('rps'), color: '#e8a33d', fill: 'rgba(232,163,61,0.12)' },
    { data: col('errors'), color: '#e05c5c' },
  ]);
  drawChart('#chart-cpu', [
    { data: col('avgCpuUtil'), color: '#4cc38a', fill: 'rgba(76,195,138,0.12)' },
  ], { refLine: target, minMax: 100, fmt: v => `${Math.round(v)}%` });
  drawChart('#chart-pods', [
    { data: col('replicas'), color: '#6ca0f6', fill: 'rgba(108,160,246,0.12)' },
    { data: col('desiredReplicas'), color: '#888', dash: [3, 3], width: 1 },
  ], { minMax: 4 });
  drawChart('#chart-nodes', [
    { data: col('nodes'), color: '#b48ce8', fill: 'rgba(180,140,232,0.12)' },
    { data: col('provisioningNodes'), color: '#888', dash: [3, 3], width: 1 },
  ], { minMax: 4 });
}

// ---- topology ----

function podChip(pod) {
  let cls = `pod-chip ${pod.phase}`;
  if (pod.phase === 'Running') {
    if (pod.throttled) cls += ' burn';
    else if (pod.cpuUtil > 80) cls += ' hot';
  }
  const restarts = pod.restarts ? ` ↻${pod.restarts}` : '';
  const label = pod.phase === 'Running'
    ? `${pod.name.split('-').slice(-1)[0]} ${pod.cpuUtil}%${restarts}`
    : `${pod.name.split('-').slice(-1)[0]} ${pod.phase}${restarts}`;
  const tip = `${pod.name}\nphase: ${pod.phase}\ncpu: ${pod.cpuUsage}m / req ${pod.cpuRequest}m / lim ${pod.cpuLimit}m (${pod.cpuUtil}% of request)\nmem: ${pod.memUsage}Mi / lim ${pod.memLimit}Mi\ntraffic: ${pod.rps} req/s\nrestarts: ${pod.restarts}${pod.throttled ? '\n⚠ CPU THROTTLED (at limit)' : ''}\n\nclick to view logs`;
  return `<span class="${cls}" title="${tip}" data-pod="${pod.name}" data-dep="${pod.deployment || ''}">${label}</span>`;
}

function renderTopology() {
  const s = state;
  const pods = s.deployments.flatMap(d => d.pods.map(p => ({ ...p, deployment: d.name })));
  const grid = $('#nodes-grid');
  let html = '';

  for (const node of s.nodes) {
    const nodePods = pods.filter(p => p.nodeName === node.name);
    const cpuReqPct = Math.min(100, (node.requested.cpu / node.allocatable.cpu) * 100);
    const cpuUsePct = Math.min(100, (node.used.cpu / node.allocatable.cpu) * 100);
    const memReqPct = Math.min(100, (node.requested.mem / node.allocatable.mem) * 100);
    const statusTxt = node.status === 'Provisioning'
      ? `Provisioning ${node.bootRemaining}s` : node.status;

    html += `<div class="node-card ${node.status.toLowerCase()}">
      <div class="node-head">
        <span class="node-name" title="${node.name}\n${node.instanceId}">🖥 ${node.name.split('.')[0]}</span>
        <span class="node-status ${node.status}">${statusTxt}</span>
      </div>
      <div class="node-sub">${node.instanceType} · allocatable ${node.allocatable.cpu}m / ${Math.round(node.allocatable.mem / 1024 * 10) / 10}Gi</div>
      <div class="node-bar" title="CPU — dark: requested by pods (${node.requested.cpu}m), green: actually used (${node.used.cpu}m)">
        <i class="req" style="width:${cpuReqPct}%"></i><i class="use" style="width:${cpuUsePct}%"></i>
      </div>
      <div class="node-bar-label"><span>cpu req ${Math.round(cpuReqPct)}% · used ${Math.round(cpuUsePct)}%</span><span>mem req ${Math.round(memReqPct)}%</span></div>
      <div class="node-pods">
        ${DAEMONSET_NAMES.map(d => `<span class="pod-chip sys" title="DaemonSet — runs on every node">${d}</span>`).join('')}
        ${nodePods.map(podChip).join('')}
      </div>
    </div>`;
  }

  const pendingPods = pods.filter(p => p.phase === 'Pending');
  if (pendingPods.length) {
    html += `<div class="node-card" id="pending-row">
      <div class="node-head"><span class="node-name">⏳ Unscheduled (Pending)</span>
      <span class="node-status Provisioning">${pendingPods.length} pod${pendingPods.length > 1 ? 's' : ''}</span></div>
      <div class="node-sub">No node has enough free requested CPU/memory — the Cluster Autoscaler should react.</div>
      <div class="node-pods">${pendingPods.map(podChip).join('')}</div>
    </div>`;
  }

  grid.innerHTML = html;
  grid.querySelectorAll('.pod-chip[data-pod]').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedPod = chip.dataset.pod;
      switchTab('logs');
      renderLogSelect();
      refreshSelectedPodLogs(true);
    });
  });
}

const DAEMONSET_NAMES = ['aws-node', 'kube-proxy'];

// ---- events ----

function renderEvents() {
  const box = $('#tab-events');
  const events = [...state.events].reverse();
  box.innerHTML = events.map(e =>
    `<div class="event-row ${e.type}">
      <span class="ev-time">${fmtClock(e.time)}</span><span class="ev-reason">${e.reason}</span>
      <span class="ev-obj">${e.object}</span><span>${e.message}</span>
    </div>`).join('');
}

// ---- contextual explainer banner ----

function maybeExplain() {
  const evts = state.events;
  if (lastSeenEventCount === 0) { lastSeenEventCount = evts.length ? evts[evts.length - 1].time : 0; return; }
  const fresh = evts.filter(e => e.time > lastSeenEventCount);
  if (evts.length) lastSeenEventCount = Math.max(lastSeenEventCount, evts[evts.length - 1].time);
  for (const e of [...fresh].reverse()) {
    const fn = EVENT_EXPLAINERS[e.reason];
    if (fn) {
      const el = $('#explainer');
      el.innerHTML = `💡 ${fn(e)}`;
      el.hidden = false;
      clearTimeout(explainerTimer);
      explainerTimer = setTimeout(() => { el.hidden = true; }, 14000);
      break;
    }
  }
}

// ---- logs ----

function renderLogSelect() {
  const sel = $('#log-pod-select');
  const pods = state.deployments.flatMap(d => d.pods);
  const current = selectedPod;
  const compOptions = (state.components || []).map(c =>
    `<option value="comp:${c}" ${'comp:' + c === current ? 'selected' : ''}>${c}</option>`);
  const podOptions = pods.map(p =>
    `<option value="${p.name}" ${p.name === current ? 'selected' : ''}>${p.name} (${p.phase})</option>`);
  sel.innerHTML = `<option value="">— select pod or process —</option>`
    + `<optgroup label="Control plane processes">${compOptions.join('')}</optgroup>`
    + `<optgroup label="Pods">${podOptions.join('')}</optgroup>`;
  if (current && !current.startsWith('comp:') && !pods.some(p => p.name === current)) {
    // keep showing logs of a recently deleted pod until user picks another
    sel.innerHTML += `<option value="${current}" selected>${current} (deleted)</option>`;
  }
  // kill button only for live, non-terminating pods
  const livePod = current && !current.startsWith('comp:') &&
    pods.find(p => p.name === current && p.phase !== 'Terminating');
  $('#btn-kill-pod').hidden = !livePod;
}

let logFetchInflight = false;
async function refreshSelectedPodLogs(force = false) {
  if (!selectedPod || $('#tab-logs').hidden && !force) return;
  if (logFetchInflight) return;
  logFetchInflight = true;
  try {
    const url = selectedPod.startsWith('comp:')
      ? `/api/components/${encodeURIComponent(selectedPod.slice(5))}/logs`
      : `/api/pods/${encodeURIComponent(selectedPod)}/logs`;
    const data = await api('GET', url);
    const out = $('#log-output');
    out.innerHTML = data.logs.map(l =>
      `<span class="log-${l.level}">[${fmtClock(l.time)}] ${l.level.padEnd(5)} ${escapeHtml(l.msg)}</span>`).join('\n');
    out.scrollTop = out.scrollHeight;
  } catch {
    /* pod gone — keep last logs */
  } finally {
    logFetchInflight = false;
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

// ---- learn tab ----

function renderLearn() {
  const box = $('#tab-learn');
  let html = '<h3>📖 Attribute reference</h3>';
  for (const [key, item] of Object.entries(LEARN_ATTRIBUTES)) {
    html += `<details id="learn-${key}"><summary>${item.title}</summary><div class="answer">${item.body}</div></details>`;
  }
  html += '<h3>🧩 Core concepts</h3>';
  for (const c of LEARN_CONCEPTS) {
    html += `<details><summary>${c.q}</summary><div class="answer">${c.a}</div></details>`;
  }
  html += '<h3>🎤 Interview questions</h3>';
  for (const qa of INTERVIEW_QA) {
    html += `<details><summary>${qa.q}</summary><div class="answer">${qa.a}</div></details>`;
  }
  box.innerHTML = html;
}

// ---------------------------------------------------------------- forms & UI

function switchTab(name) {
  $$('#right-tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $('#tab-events').hidden = name !== 'events';
  $('#tab-logs').hidden = name !== 'logs';
  $('#tab-learn').hidden = name !== 'learn';
}

let formsInitialized = false;
function syncForms() {
  const s = state;
  if (!formsInitialized) {
    // instance type options
    $('#ng-instance-type').innerHTML = s.nodeGroup.instanceTypes.map(t =>
      `<option value="${t.name}">${t.name} — ${t.vcpu} vCPU / ${t.memGiB}Gi — $${t.pricePerHour}/hr</option>`).join('');
    fillNodeGroupForm();
    fillDeploymentForm(s.deployments.find(d => d.name === editingDeployment));
    $('#rps-slider').value = s.load.baseRps;
    formsInitialized = true;
  }
  // deployment selector options
  const sel = $('#dep-select');
  const want = ['__new__', ...s.deployments.map(d => d.name)];
  const have = [...sel.options].map(o => o.value);
  if (JSON.stringify(want) !== JSON.stringify(have)) {
    sel.innerHTML = `<option value="__new__">➕ new deployment…</option>` +
      s.deployments.map(d => `<option value="${d.name}">${d.name}</option>`).join('');
    sel.value = s.deployments.some(d => d.name === editingDeployment) ? editingDeployment : '__new__';
  }
  // load status line
  const L = s.load;
  const bits = [];
  if (L.baseRps > 0) bits.push(`steady ${Math.round(L.baseRps)} req/s`);
  if (L.pattern === 'wave' && L.waveAmplitude > 0) bits.push(`wave ±${L.waveAmplitude} (${L.wavePeriodSeconds}s period)`);
  if (L.ramp) bits.push(`ramping to ${L.ramp.to}`);
  if (L.spike) bits.push(`spike +${L.spike.magnitude}`);
  if (L.burstQueue > 0) bits.push(`burst queue ${Math.round(L.burstQueue)}`);
  $('#load-status').textContent = bits.length ? `active: ${bits.join(' · ')}` : 'no load';
  $('#rps-label').textContent = $('#rps-slider').value;
}

function fillNodeGroupForm() {
  const f = $('#form-nodegroup');
  const ng = state.nodeGroup;
  f.instanceType.value = ng.instanceType;
  f.minNodes.value = ng.minNodes;
  f.maxNodes.value = ng.maxNodes;
  f.scaleDownUtilizationThreshold.value = ng.scaleDownUtilizationThreshold;
  f.scaleDownDelaySeconds.value = ng.scaleDownDelaySeconds;
  f.nodeBootSeconds.value = ng.nodeBootSeconds;
}

function fillDeploymentForm(dep) {
  const f = $('#form-deployment');
  $('#dep-delete').hidden = !dep;
  $('#dep-submit').textContent = dep ? 'Apply deployment' : 'Create deployment';
  if (!dep) {
    f.name.value = '';
    f.name.disabled = false;
    return;
  }
  f.name.value = dep.name;
  f.name.disabled = true;
  f.replicas.value = dep.replicas;
  f.trafficWeight.value = dep.trafficWeight;
  f.cpuRequest.value = dep.cpuRequest;
  f.cpuLimit.value = dep.cpuLimit;
  f.memRequest.value = dep.memRequest;
  f.memLimit.value = dep.memLimit;
  f.baseCpu.value = dep.baseCpu;
  f.cpuPerRequest.value = dep.cpuPerRequest;
  f.startupSeconds.value = dep.startupSeconds;
  f.hpaEnabled.checked = dep.hpa.enabled;
  f.minReplicas.value = dep.hpa.minReplicas;
  f.maxReplicas.value = dep.hpa.maxReplicas;
  f.targetCPUUtilization.value = dep.hpa.targetCPUUtilization;
  f.scaleUpCooldownSeconds.value = dep.hpa.scaleUpCooldownSeconds;
  f.scaleDownStabilizationSeconds.value = dep.hpa.scaleDownStabilizationSeconds;
}

function wireUI() {
  renderLearn();

  // tabs
  $$('#right-tabs button').forEach(b => b.addEventListener('click', () => switchTab(b.dataset.tab)));

  // "?" helpers jump to the matching learn entry
  document.body.addEventListener('click', e => {
    const help = e.target.closest('.help');
    if (!help) return;
    e.preventDefault();
    switchTab('learn');
    const det = $(`#learn-${help.dataset.learn}`);
    if (det) {
      $$('#tab-learn details').forEach(d => { d.open = false; d.classList.remove('flash'); });
      det.open = true;
      det.classList.add('flash');
      det.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setTimeout(() => det.classList.remove('flash'), 2500);
    }
  });

  // speed
  $$('.speed-controls button[data-speed]').forEach(b =>
    b.addEventListener('click', () => api('POST', '/api/speed', { speed: Number(b.dataset.speed) }).then(poll)));
  $('#btn-ff').addEventListener('click', () => api('POST', '/api/advance', { seconds: 60 }).then(poll));
  $('#btn-reset').addEventListener('click', async () => {
    if (!confirm('Reset the entire simulation to defaults?')) return;
    await api('POST', '/api/reset');
    formsInitialized = false;
    editingDeployment = 'web-api';
    selectedPod = null;
    lastSeenEventCount = 0;
    poll();
  });

  // node group form
  $('#form-nodegroup').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    await api('PUT', '/api/nodegroup', {
      instanceType: f.instanceType.value,
      minNodes: Number(f.minNodes.value),
      maxNodes: Number(f.maxNodes.value),
      scaleDownUtilizationThreshold: Number(f.scaleDownUtilizationThreshold.value),
      scaleDownDelaySeconds: Number(f.scaleDownDelaySeconds.value),
      nodeBootSeconds: Number(f.nodeBootSeconds.value),
    });
    poll();
  });

  // deployment form
  $('#dep-select').addEventListener('change', e => {
    editingDeployment = e.target.value === '__new__' ? null : e.target.value;
    fillDeploymentForm(state.deployments.find(d => d.name === editingDeployment));
  });

  $('#form-deployment').addEventListener('submit', async e => {
    e.preventDefault();
    const f = e.target;
    const spec = {
      name: f.name.value.trim(),
      replicas: Number(f.replicas.value),
      trafficWeight: Number(f.trafficWeight.value),
      cpuRequest: Number(f.cpuRequest.value),
      cpuLimit: Number(f.cpuLimit.value),
      memRequest: Number(f.memRequest.value),
      memLimit: Number(f.memLimit.value),
      baseCpu: Number(f.baseCpu.value),
      cpuPerRequest: Number(f.cpuPerRequest.value),
      startupSeconds: Number(f.startupSeconds.value),
      hpa: {
        enabled: f.hpaEnabled.checked,
        minReplicas: Number(f.minReplicas.value),
        maxReplicas: Number(f.maxReplicas.value),
        targetCPUUtilization: Number(f.targetCPUUtilization.value),
        scaleUpCooldownSeconds: Number(f.scaleUpCooldownSeconds.value),
        scaleDownStabilizationSeconds: Number(f.scaleDownStabilizationSeconds.value),
      },
    };
    try {
      if (editingDeployment) {
        await api('PUT', `/api/deployments/${editingDeployment}`, spec);
      } else {
        const created = await api('POST', '/api/deployments', spec);
        editingDeployment = created.name;
      }
      await poll();
      fillDeploymentForm(state.deployments.find(d => d.name === editingDeployment));
    } catch (err) {
      alert(err.message);
    }
  });

  $('#dep-delete').addEventListener('click', async () => {
    if (!editingDeployment) return;
    if (!confirm(`Delete deployment "${editingDeployment}"?`)) return;
    await api('DELETE', `/api/deployments/${editingDeployment}`);
    editingDeployment = null;
    fillDeploymentForm(null);
    poll();
  });

  // load controls
  const slider = $('#rps-slider');
  let sliderDebounce = null;
  slider.addEventListener('input', () => {
    $('#rps-label').textContent = slider.value;
    clearTimeout(sliderDebounce);
    sliderDebounce = setTimeout(() =>
      api('POST', '/api/load', { baseRps: Number(slider.value) }), 250);
  });
  $('#btn-burst').addEventListener('click', () => api('POST', '/api/load/burst', { requests: 2000 }).then(poll));
  $('#btn-spike').addEventListener('click', () => api('POST', '/api/load/spike', { magnitude: 400, durationSeconds: 90 }).then(poll));
  $('#btn-ramp').addEventListener('click', () => api('POST', '/api/load/ramp', { to: 600, durationSeconds: 120 }).then(poll));
  $('#btn-wave').addEventListener('click', () =>
    api('POST', '/api/load', { pattern: 'wave', waveAmplitude: 300, wavePeriodSeconds: 240 }).then(poll));
  $('#btn-load-stop').addEventListener('click', async () => {
    await api('POST', '/api/load', { baseRps: 0, pattern: 'steady', waveAmplitude: 0 });
    slider.value = 0;
    poll();
  });

  // pod log selector
  $('#log-pod-select').addEventListener('change', e => {
    selectedPod = e.target.value || null;
    if (selectedPod) refreshSelectedPodLogs(true);
  });

  // control-plane process chips -> component logs
  $$('.cp-parts span[data-comp]').forEach(chip => {
    chip.addEventListener('click', () => {
      selectedPod = `comp:${chip.dataset.comp}`;
      switchTab('logs');
      renderLogSelect();
      refreshSelectedPodLogs(true);
    });
  });

  // kill the selected pod
  $('#btn-kill-pod').addEventListener('click', async () => {
    if (!selectedPod || selectedPod.startsWith('comp:')) return;
    try {
      await api('POST', `/api/pods/${encodeURIComponent(selectedPod)}/kill`);
      poll();
    } catch (err) { alert(err.message); }
  });

  // chaos monkey: kill a random running pod
  $('#btn-chaos').addEventListener('click', async () => {
    try {
      const r = await api('POST', '/api/chaos/kill-random-pod');
      selectedPod = r.killed;
      switchTab('logs');
      await poll();
      refreshSelectedPodLogs(true);
    } catch (err) { alert(err.message); }
  });
}

wireUI();
poll();
