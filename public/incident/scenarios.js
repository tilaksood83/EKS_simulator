'use strict';

/*
 * Incident scenario library — shared by the Incident Room (random pick) and
 * the Daily Incident (date-seeded pick). Each scenario injects one hidden
 * fault into the in-browser EKS sim via the solo fetch shim, and knows how
 * to fix it.
 */
(() => {
  // default web-api spec from the engine; the baseline both for injecting a
  // single tweaked fault and for restoring in fixes
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

  const defaultNodegroup = { instanceType: 't3.medium', minNodes: 1, maxNodes: 6,
    scaleDownUtilizationThreshold: 0.5, scaleDownDelaySeconds: 60, nodeBootSeconds: 25 };

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
        await call('PUT', '/api/nodegroup', { ...defaultNodegroup, maxNodes: 2 });
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
      fix: () => call('PUT', '/api/nodegroup', { ...defaultNodegroup, maxNodes: 8 }),
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
    {
      id: 'slowstart',
      report: 'Every traffic ramp causes an error burst, even though scaling IS happening.',
      inject: async () => {
        await dep({ startupSeconds: 90, hpa: { maxReplicas: 15 } });
        await call('POST', '/api/load/ramp', { to: 500, durationSeconds: 60 });
      },
      question: 'The HPA adds pods but errors still spike for minutes. Root cause?',
      correct: 'Pod startup takes ~90s — new capacity arrives far too late',
      wrong: [
        'The HPA target utilization is set too low',
        'The image registry is rate-limiting pulls',
        'The nodes are too small to fit the new pods',
      ],
      clue: 'Watch a new pod: it sits in ContainerCreating for a long time while survivors burn. Compare desired vs running in the replica chart.',
      explain: 'Autoscaling reacted correctly, but each new pod needs ~90 seconds to boot and pass readiness — meanwhile the existing pods are drowning. Slow startup silently caps how fast you can absorb load; that\'s why startup time is a first-class scaling parameter. Fix: cut startup time (lazy init, lighter image, readiness tuning).',
      fix: () => dep({}),
    },
    {
      id: 'hpamax',
      report: 'Traffic keeps growing, errors keep growing — and the cluster stopped scaling.',
      inject: async () => {
        await dep({ hpa: { maxReplicas: 3 } });
        await call('POST', '/api/load/ramp', { to: 500, durationSeconds: 60 });
      },
      question: 'CPU is far above target but replicas are stuck at 3. Root cause?',
      correct: 'HPA maxReplicas is too low — the autoscaler hit its own ceiling',
      wrong: [
        'The node group maxNodes is too low — the Cluster Autoscaler is capped',
        'The HPA scale-down stabilization window is cancelling scale-ups',
        'The pods\' readiness probes are failing so new pods never serve',
      ],
      clue: 'Check the replica chart: desired and running are flat at exactly 3 — a suspiciously round number. Nodes have plenty of room, and nothing is Pending.',
      explain: 'Two different ceilings can cap scaling: the node group\'s maxNodes (Cluster Autoscaler) and the HPA\'s own maxReplicas. Here nodes are fine and nothing is Pending — the HPA simply refuses to want more than 3 pods. The tell: no FailedScheduling events, just a flat replica line. Fix: raise maxReplicas to something sane.',
      fix: () => dep({}),
    },
  ];

  window.INCIDENTS = { BASELINE, SCENARIOS, call, dep };
})();
