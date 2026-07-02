'use strict';

/* Guided lessons for the EKS sim (solo mode). Drives the simulation through
 * the same /api/* surface the UI uses (intercepted by local-api.js). */
(() => {
  const call = (method, path, body) => fetch(path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const dep = spec => call('PUT', '/api/deployments/web-api', spec);
  const FULL = {
    name: 'web-api', replicas: 2, trafficWeight: 1,
    cpuRequest: 250, cpuLimit: 500, memRequest: 256, memLimit: 512,
    baseCpu: 30, cpuPerRequest: 4, startupSeconds: 8,
    hpa: { enabled: true, minReplicas: 2, maxReplicas: 10, targetCPUUtilization: 60,
           scaleUpCooldownSeconds: 15, scaleDownStabilizationSeconds: 60 },
  };
  const lastH = s => s.history[s.history.length - 1] || {};
  const runningPods = s => s.deployments[0].pods.filter(p => p.phase === 'Running').length;

  window.LESSON_ADAPTER = {
    getState: () => fetch('/api/state').then(r => r.json()),
  };

  window.LESSONS = {
    'hpa-101': {
      title: 'Why scaling is never instant',
      done: 'You watched the whole loop: load → CPU → HPA math → pod startup delay → stabilization. That chain is the answer to half of all autoscaling questions.',
      steps: [
        {
          say: 'This is a live Kubernetes cluster (simulated, but honestly). Right now <b>2 pods</b> serve zero traffic. The panel on the left is yours later — for now, I\'ll drive.',
          do: async () => { await call('POST', '/api/reset'); await call('POST', '/api/speed', { speed: 2 }); },
        },
        {
          say: 'The deployment has an <b>HPA</b> targeting <b>60% CPU</b>. That number is measured against the pod\'s CPU <code>request</code> (250m) — not the node, not the limit. Remember that; it\'s the most common confusion.',
        },
        {
          say: 'Let\'s hit it with <b>300 requests/second</b>.',
          do: () => call('POST', '/api/load', { baseRps: 300 }),
          until: s => (lastH(s).avgCpuUtil || 0) > 60,
          watch: 'watch the "Avg CPU" stat card climb past the 60% target…',
        },
        {
          say: 'CPU is above target, so the HPA computes: <code>desired = ceil(current × actual/target)</code>. It doesn\'t panic-double; it calculates. Watch the <b>Pod replicas</b> chart.',
          until: s => s.deployments[0].pods.length > 2,
          watch: 'waiting for the HPA to add pods…',
        },
        {
          say: 'New pods exist — but look closely at the cluster view: they\'re in <b>ContainerCreating</b>, not serving. Every pod needs ~8s to boot and pass readiness. <i>This gap is why scaling is never instant.</i>',
          until: s => runningPods(s) >= 4,
          watch: 'waiting for new pods to reach Running…',
        },
        {
          say: 'As new pods come online, traffic spreads and average CPU falls back toward the target. The system found its level — nobody chose "4 pods", the math did.',
          until: s => (lastH(s).avgCpuUtil || 100) < 75,
          watch: 'watch Avg CPU drift back down…',
        },
        {
          say: 'Now the part everyone forgets: <b>scale-down</b>. Let\'s kill the traffic entirely.',
          do: async () => { await call('POST', '/api/load', { baseRps: 0 }); await call('POST', '/api/speed', { speed: 5 }); },
          until: s => (lastH(s).avgCpuUtil || 100) < 20,
          watch: 'CPU collapses… but count the pods. Still 4?',
        },
        {
          say: 'CPU is near zero but the pods are still there — the HPA\'s <b>stabilization window</b> (60s) requires low usage to <i>persist</i> before scaling down. That\'s flap protection: without it, bursty traffic would create pod churn.',
          until: s => s.deployments[0].pods.length <= 2,
          watch: 'waiting out the stabilization window…',
        },
      ],
    },
    'limits-101': {
      title: 'Requests vs limits — feel the difference',
      done: 'Requests decide WHERE pods go (scheduling); CPU limits throttle (slow, alive); memory limits kill (OOM, restart). You\'ve now seen two of the three.',
      steps: [
        {
          say: 'Two knobs everyone mixes up: <b>request</b> = what the scheduler reserves for you. <b>Limit</b> = the hard cap the kernel enforces. They fail in completely different ways — let\'s trigger one.',
          do: async () => { await call('POST', '/api/reset'); await call('POST', '/api/speed', { speed: 5 }); },
        },
        {
          say: 'I just set this deployment\'s CPU limit to a stingy <b>120m</b> and turned on 220 req/s. The pods need more CPU than the limit allows.',
          do: async () => {
            await dep({ ...FULL, cpuRequest: 100, cpuLimit: 120 });
            await call('POST', '/api/load', { baseRps: 220 });
          },
          until: s => (lastH(s).p99 || 0) > 60,
          watch: 'watch the p99 latency stat turn ugly…',
        },
        {
          say: 'This is <b>CFS throttling</b>: the kernel gives each container only its quota of CPU slices. Nothing crashes. Nothing restarts. The pods say <b>Running</b> — they\'re just slow. In production this is the issue you\'ll stare at for an hour, because everything looks "green".',
        },
        {
          say: 'Now I\'ll raise the limit back to 500m. No restart needed — watch latency recover on its own.',
          do: () => dep(FULL),
          until: s => (lastH(s).p99 || 999) < 40,
          watch: 'p99 falling back to normal…',
        },
        {
          say: '<b>Memory limits are crueler.</b> CPU over limit = throttled (slow). Memory over limit = <b>OOMKilled</b> (dead, restarted, ↻ counter goes up). Try it yourself after the lesson: set mem limit to 96Mi in the Deployment form and watch the Events tab.',
        },
      ],
    },
  };
})();
