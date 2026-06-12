'use strict';

/*
 * Incident Room: injects a hidden fault into the (local, in-browser) EKS sim
 * and challenges the player to diagnose it from events, logs and metrics.
 * Runs on top of solo-mode machinery: the engine + fetch shim + normal UI.
 */
(() => {
  // the default web-api spec from the engine, used as the baseline for both
  // fault injection (tweak one thing) and the fix (restore it)
  const BASELINE = {
    name: 'web-api',
    replicas: 2,
    trafficWeight: 1,
    cpuRequest: 250,
    cpuLimit: 500,
    memRequest: 256,
    memLimit: 512,
    baseCpu: 30,
    cpuPerRequest: 4,
    startupSeconds: 8,
    hpa: {
      enabled: true,
      minReplicas: 2,
      maxReplicas: 10,
      targetCPUUtilization: 60,
      scaleUpCooldownSeconds: 15,
      scaleDownStabilizationSeconds: 60,
    },
  };

  const call = (method, path, body) => fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });

  const dep = patch => {
    const spec = JSON.parse(JSON.stringify(BASELINE));
    Object.assign(spec, patch);
    if (patch && patch.hpa) spec.hpa = { ...BASELINE.hpa, ...patch.hpa };
    return call('PUT', '/api/deployments/web-api', spec);
  };

  const SCENARIOS = [
    {
      id: 'oom',
      report: 'Pods keep dying and restarting. Users see intermittent errors.',
      inject: async () => {
        await dep({ memRequest: 64, memLimit: 96 });
        await call('POST', '/api/load', { baseRps: 250 });
      },
      question: 'Pods are restarting over and over. What is the root cause?',
      correct: 'Memory limit is too low — the container is being OOMKilled',
      wrong: [
        'The nodes are out of disk space',
        'The HPA is scaling down too aggressively',
        'The readiness probe timeout is too short',
      ],
      clue: 'Check the Events tab for OOMKilled, and pod restart counters (↻) in the cluster view.',
      explain: 'The memory limit (96Mi) is below what the app needs under load. Each time usage crosses the limit, the kernel OOM-kills the container and the ReplicaSet restarts it — the classic restart loop. Fix: raise the memory limit (or reduce the app\'s footprint).',
      fix: () => dep({}),
    },
    {
      id: 'throttle',
      report: 'The service is up, but latency is terrible and slowly getting worse.',
      inject: async () => {
        await dep({ cpuRequest: 100, cpuLimit: 120 });
        await call('POST', '/api/load', { baseRps: 220 });
      },
      question: 'Latency is high but pods look "Running". What is the root cause?',
      correct: 'CPU limit is too low — containers are being CFS-throttled',
      wrong: [
        'Network packet loss between nodes',
        'The cluster autoscaler removed too many nodes',
        'etcd is overloaded and slowing the API server',
      ],
      clue: 'Pod chips in the cluster view show a "burning" state when throttled; CPU sits pinned at the limit.',
      explain: 'CPU usage hit the limit (120m), so the kernel throttles the container via CFS quota: it is alive but only gets slices of CPU. Requests queue up and latency climbs while everything still reports Running — the sneakiest production issue. Fix: raise the CPU limit or request.',
      fix: () => dep({}),
    },
    {
      id: 'nodecap',
      report: 'Traffic spiked and new pods are stuck — capacity is not growing.',
      inject: async () => {
        await dep({ hpa: { maxReplicas: 30 } });
        await call('PUT', '/api/nodegroup', {
          instanceType: 't3.medium', minNodes: 1, maxNodes: 2,
          scaleDownUtilizationThreshold: 0.5, scaleDownDelaySeconds: 60, nodeBootSeconds: 25,
        });
        await call('POST', '/api/load/ramp', { to: 700, durationSeconds: 60 });
      },
      question: 'HPA wants more pods but they sit Pending forever. What is the root cause?',
      correct: 'Node group maxNodes is too low — the Cluster Autoscaler hit its ceiling',
      wrong: [
        'The HPA scale-up cooldown is too long',
        'The pods have no resource requests so they cannot be scheduled',
        'The deployment\'s image pull is failing',
      ],
      clue: 'Events show FailedScheduling and the autoscaler logging that it cannot add nodes. The Pending row appears in the cluster view.',
      explain: 'The HPA created pods, but every node is full and the Cluster Autoscaler is capped at maxNodes=2 — so pods queue as Pending. The autoscaler even tells you in its logs. Fix: raise maxNodes on the node group (and watch new nodes boot).',
      fix: () => call('PUT', '/api/nodegroup', {
        instanceType: 't3.medium', minNodes: 1, maxNodes: 8,
        scaleDownUtilizationThreshold: 0.5, scaleDownDelaySeconds: 60, nodeBootSeconds: 25,
      }),
    },
    {
      id: 'hpaoff',
      report: 'Error rate climbs every time traffic rises, and nothing reacts.',
      inject: async () => {
        await dep({ hpa: { enabled: false } });
        await call('POST', '/api/load/ramp', { to: 500, durationSeconds: 60 });
      },
      question: 'Load went up, errors went up, replica count did nothing. Root cause?',
      correct: 'The HPA is disabled — nothing scales the deployment with load',
      wrong: [
        'The metrics-server is reporting CPU in the wrong units',
        'The load balancer is not spreading traffic across pods',
        'Pod startup time is too slow to keep up',
      ],
      clue: 'CPU utilization is far above the usual 60% target, yet the replica chart stays flat at 2.',
      explain: 'With the HPA off, the deployment stays at its manual replica count no matter the load. The two pods saturate, shed requests, and nobody comes to help. Fix: enable the HPA (and check its min/max/target are sane).',
      fix: () => dep({}),
    },
  ];

  let current = null;
  let solved = false;
  let attempts = 0;
  let streak = 0;

  // ------------------------------------------------------------------ UI

  const css = document.createElement('style');
  css.textContent = `
    #incident-panel {
      position: fixed; right: 14px; bottom: 14px; width: 330px; z-index: 50;
      background: var(--panel); border: 1px solid var(--red); border-radius: 10px;
      padding: 14px; box-shadow: 0 6px 24px rgba(0,0,0,.5); font-size: .88rem;
    }
    #incident-panel h3 { margin: 0 0 8px; color: var(--red); font-size: 1rem; }
    #incident-panel.solved { border-color: var(--green); }
    #incident-panel.solved h3 { color: var(--green); }
    #incident-panel label { display: block; margin: 6px 0; cursor: pointer; }
    #incident-panel .clue { color: var(--dim); font-style: italic; margin: 8px 0; }
    #incident-panel .explain { background: var(--panel2); border-radius: 6px; padding: 8px; margin: 8px 0; }
    #incident-panel .verdict { font-weight: 600; margin: 8px 0; }
    #incident-panel .row2 { display: flex; gap: 8px; }
    #incident-panel button { flex: 1; }
    #incident-streak { float: right; color: var(--dim); font-size: .8rem; }
  `;
  document.head.appendChild(css);

  const panel = document.createElement('div');
  panel.id = 'incident-panel';
  document.body.appendChild(panel);

  function shuffle(arr) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  }

  function renderQuiz() {
    const opts = shuffle([current.correct, ...current.wrong]);
    panel.className = '';
    panel.innerHTML = `
      <h3>🚨 Incident in progress <span id="incident-streak">streak: ${streak}</span></h3>
      <div>"${current.report}"</div>
      <div class="clue">💡 ${current.clue}</div>
      <div><b>${current.question}</b></div>
      ${opts.map((o, i) => `<label><input type="radio" name="diag" value="${encodeURIComponent(o)}"> ${o}</label>`).join('')}
      <div class="verdict" id="incident-verdict"></div>
      <div class="row2">
        <button id="incident-submit">Submit diagnosis</button>
        <button id="incident-skip" class="danger" title="Give up and reveal the answer">Reveal</button>
      </div>`;
    panel.querySelector('#incident-submit').addEventListener('click', onSubmit);
    panel.querySelector('#incident-skip').addEventListener('click', () => { streak = 0; reveal(false); });
  }

  function onSubmit() {
    const sel = panel.querySelector('input[name="diag"]:checked');
    const verdict = panel.querySelector('#incident-verdict');
    if (!sel) { verdict.textContent = 'Pick an option first.'; return; }
    attempts++;
    if (decodeURIComponent(sel.value) === current.correct) {
      streak++;
      reveal(true);
    } else {
      verdict.textContent = `❌ Not quite — look again at the events and logs. (attempt ${attempts})`;
      verdict.style.color = 'var(--red)';
    }
  }

  function reveal(won) {
    solved = true;
    panel.className = 'solved';
    panel.innerHTML = `
      <h3>${won ? `✅ Diagnosed in ${attempts} attempt${attempts > 1 ? 's' : ''}` : '📖 The answer'} <span id="incident-streak">streak: ${streak}</span></h3>
      <div class="verdict">${current.correct}</div>
      <div class="explain">${current.explain}</div>
      <div class="row2">
        <button id="incident-fix">🔧 Apply the fix</button>
        <button id="incident-next">🎲 New incident</button>
      </div>
      <div class="clue" id="incident-recovery"></div>`;
    panel.querySelector('#incident-fix').addEventListener('click', async e => {
      await current.fix();
      e.target.disabled = true;
      panel.querySelector('#incident-recovery').textContent =
        '🩺 Fix applied — watch the cluster recover in the charts and events.';
    });
    panel.querySelector('#incident-next').addEventListener('click', startIncident);
  }

  async function startIncident() {
    attempts = 0;
    solved = false;
    await call('POST', '/api/reset');
    current = SCENARIOS[Math.floor(Math.random() * SCENARIOS.length)];
    await current.inject();
    await call('POST', '/api/speed', { speed: 5 }); // make symptoms develop fast
    await call('POST', '/api/advance', { seconds: 45 }); // symptoms already visible
    renderQuiz();
  }

  startIncident();
})();
