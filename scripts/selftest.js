'use strict';

/*
 * End-to-end self-test. Boots the real server on a test port, then drives
 * every feature through the HTTP API using /api/advance (deterministic
 * simulated time, real-time loop paused via speed=0).
 */

/*
 * By default boots the server in-process on TEST_PORT (4100).
 * Set TARGET to test an already-running instance instead, e.g. a Docker
 * container:  TARGET=http://localhost:3300 node scripts/selftest.js
 */
let BASE;
if (process.env.TARGET) {
  BASE = process.env.TARGET.replace(/\/$/, '');
  console.log(`Testing external target: ${BASE}`);
} else {
  process.env.PORT = process.env.TEST_PORT || 4100;
  require('../server');
  BASE = `http://localhost:${process.env.PORT}`;
}
let passed = 0, failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS  ${name}`); }
  else { failed++; console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`); }
}

async function api(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

const state = () => api('GET', '/api/state').then(r => r.data);
const advance = s => api('POST', '/api/advance', { seconds: s });
const runningPods = (st, dep) => st.deployments.find(d => d.name === dep).pods.filter(p => p.phase === 'Running');

async function main() {
  await new Promise(r => setTimeout(r, 300)); // let server bind

  console.log('\n== 1. Baseline ==');
  await api('POST', '/api/speed', { speed: 0 }); // freeze real-time loop; we drive time manually
  await api('POST', '/api/reset');
  await api('POST', '/api/speed', { speed: 0 });
  await advance(30);
  let st = await state();
  check('cluster ACTIVE', st.cluster.status === 'ACTIVE');
  check('2 initial nodes Ready', st.nodes.filter(n => n.status === 'Ready').length === 2);
  check('default deployment exists', st.deployments.some(d => d.name === 'web-api'));
  check('2 running pods at idle', runningPods(st, 'web-api').length === 2, JSON.stringify(st.deployments[0].pods.map(p => p.phase)));
  check('idle avg CPU below HPA target', st.deployments[0].metrics.avgCpuUtil < 60);
  check('events emitted', st.events.length > 0);
  check('cost accrues', st.cost.total > 0);

  console.log('\n== 2. HPA scale-up under load ==');
  await api('POST', '/api/load', { baseRps: 300 });
  await advance(90);
  st = await state();
  const dep = st.deployments[0];
  check('load applied (300 rps)', Math.abs(st.load.currentRps - 300) < 1, `got ${st.load.currentRps}`);
  check('HPA scaled up replicas > 2', dep.replicas > 2, `replicas=${dep.replicas}`);
  check('running pods grew', runningPods(st, 'web-api').length > 2);
  check('HPA rescale event emitted', st.events.some(e => e.reason === 'SuccessfulRescale' && e.message.includes('above')));
  const utilAfter = dep.metrics.avgCpuUtil;
  check('utilization heading toward target (<90%)', utilAfter < 90, `util=${Math.round(utilAfter)}%`);

  console.log('\n== 3. Cluster Autoscaler node scale-up ==');
  // crank load so HPA wants max replicas; 10 pods x 250m fit on 2 nodes,
  // so first raise pod CPU request to force node pressure
  await api('PUT', '/api/deployments/web-api', { cpuRequest: 600, cpuLimit: 900 });
  await api('POST', '/api/load', { baseRps: 700 });
  await advance(40);
  st = await state();
  const pendingMid = st.deployments[0].pods.filter(p => p.phase === 'Pending').length;
  check('pods went Pending under node pressure', pendingMid > 0 || st.nodes.length > 2, `pending=${pendingMid} nodes=${st.nodes.length}`);
  check('CA TriggeredScaleUp event', st.events.some(e => e.reason === 'TriggeredScaleUp'));
  await advance(120);
  st = await state();
  check('nodes scaled up beyond 2', st.nodes.length > 2, `nodes=${st.nodes.length}`);
  check('new nodes became Ready', st.nodes.filter(n => n.status === 'Ready').length > 2);
  check('pending pods eventually scheduled', st.deployments[0].pods.filter(p => p.phase === 'Pending').length === 0,
    JSON.stringify(st.deployments[0].pods.map(p => p.phase)));
  check('FailedScheduling warning seen', st.events.some(e => e.reason === 'FailedScheduling'));

  console.log('\n== 4. Max-nodes cap ==');
  await api('PUT', '/api/nodegroup', { maxNodes: st.nodes.length }); // freeze at current size
  await api('PUT', '/api/deployments/web-api', { hpa: { maxReplicas: 30 } });
  await api('POST', '/api/load', { baseRps: 2500 });
  await advance(90);
  st = await state();
  const ngMax = st.nodeGroup.maxNodes;
  check('node count respects maxNodes', st.nodes.length <= ngMax, `nodes=${st.nodes.length} max=${ngMax}`);
  check('pods stuck Pending at capacity', st.deployments[0].pods.some(p => p.phase === 'Pending'));

  console.log('\n== 5. Scale-down (HPA + CA) ==');
  await api('PUT', '/api/nodegroup', { maxNodes: 8, minNodes: 1 });
  await api('POST', '/api/load', { baseRps: 5 });
  await advance(420);
  st = await state();
  const dep5 = st.deployments[0];
  check('HPA scaled down to min', dep5.replicas === dep5.hpa.minReplicas, `replicas=${dep5.replicas} min=${dep5.hpa.minReplicas}`);
  check('HPA scale-down event', st.events.some(e => e.reason === 'SuccessfulRescale' && e.message.includes('below')));
  check('CA removed nodes', st.nodes.length <= 2, `nodes=${st.nodes.length}`);
  check('CA ScaleDown event', st.events.some(e => e.reason === 'ScaleDown'));
  check('node count respects minNodes', st.nodes.length >= st.nodeGroup.minNodes);
  check('no pods lost in scale-down', runningPods(st, 'web-api').length === dep5.replicas,
    JSON.stringify(dep5.pods.map(p => p.phase)));

  console.log('\n== 6. Load patterns ==');
  await api('POST', '/api/load/burst', { requests: 5000 });
  await advance(2);
  st = await state();
  check('burst raises rps', st.load.currentRps > 100, `rps=${st.load.currentRps}`);
  await advance(60);
  st = await state();
  check('burst drains', st.load.burstQueue === 0);

  await api('POST', '/api/load/spike', { magnitude: 200, durationSeconds: 30 });
  await advance(5);
  st = await state();
  check('spike active', st.load.currentRps >= 200, `rps=${st.load.currentRps}`);
  await advance(40);
  st = await state();
  check('spike expired', st.load.spike === null && st.load.currentRps < 50, `rps=${st.load.currentRps}`);

  await api('POST', '/api/load/ramp', { to: 100, durationSeconds: 20 });
  await advance(10);
  st = await state();
  check('ramp in progress (between start and target)', st.load.currentRps > 10 && st.load.currentRps < 100, `rps=${st.load.currentRps}`);
  await advance(15);
  st = await state();
  check('ramp completed at target', Math.abs(st.load.baseRps - 100) < 1, `baseRps=${st.load.baseRps}`);

  await api('POST', '/api/load', { baseRps: 0, pattern: 'wave', waveAmplitude: 100, wavePeriodSeconds: 40 });
  const samples = [];
  for (let i = 0; i < 4; i++) { await advance(10); samples.push((await state()).load.currentRps); }
  check('wave oscillates', Math.max(...samples) - Math.min(...samples) > 30, JSON.stringify(samples.map(Math.round)));
  await api('POST', '/api/load', { baseRps: 0, pattern: 'steady', waveAmplitude: 0 });

  console.log('\n== 7. Deployment CRUD + multi-deployment traffic ==');
  let r = await api('POST', '/api/deployments', {
    name: 'checkout', replicas: 2, cpuRequest: 200, cpuLimit: 400, memRequest: 128, memLimit: 256,
    baseCpu: 20, cpuPerRequest: 6, trafficWeight: 1, startupSeconds: 5,
    hpa: { enabled: true, minReplicas: 1, maxReplicas: 6, targetCPUUtilization: 60 },
  });
  check('create deployment returns 201', r.status === 201, `status=${r.status}`);
  r = await api('POST', '/api/deployments', { name: 'checkout' });
  check('duplicate name rejected', r.status === 400);
  await api('POST', '/api/load', { baseRps: 100 });
  await advance(30);
  st = await state();
  const co = st.deployments.find(d => d.name === 'checkout');
  const wa = st.deployments.find(d => d.name === 'web-api');
  check('both deployments receive traffic', co.metrics.rps > 10 && wa.metrics.rps > 10,
    `checkout=${co.metrics.rps} web-api=${wa.metrics.rps}`);
  check('traffic split by weight (~50/50)', Math.abs(co.metrics.rps - wa.metrics.rps) < 5);

  r = await api('PUT', '/api/deployments/checkout', { cpuRequest: 300 });
  check('update deployment ok', r.status === 200);
  await advance(2);
  st = await state();
  check('rolling update event on resource change', st.events.some(e => e.reason === 'RollingUpdate'));
  r = await api('DELETE', '/api/deployments/checkout');
  check('delete deployment ok', r.status === 200);
  await advance(10);
  st = await state();
  check('deployment fully removed', !st.deployments.some(d => d.name === 'checkout'));
  r = await api('DELETE', '/api/deployments/nope');
  check('delete unknown -> 400', r.status === 400);

  console.log('\n== 8. Pod logs & OOMKill ==');
  await api('POST', '/api/load', { baseRps: 80 });
  await advance(20);
  st = await state();
  const pod = runningPods(st, 'web-api')[0];
  r = await api('GET', `/api/pods/${pod.name}/logs`);
  check('pod logs endpoint works', r.status === 200 && r.data.logs.length > 0);
  check('logs include traffic lines', r.data.logs.some(l => l.msg.includes('req/s')), JSON.stringify(r.data.logs.slice(-2)));
  r = await api('GET', '/api/pods/ghost-pod/logs');
  check('unknown pod -> 404', r.status === 404);

  await api('PUT', '/api/deployments/web-api', { memLimit: 100, memRequest: 256 });
  await advance(30);
  st = await state();
  check('OOMKilled event when mem limit breached', st.events.some(e => e.reason === 'OOMKilled'));
  check('restart counter incremented', st.deployments[0].pods.some(p => p.restarts > 0));
  await api('PUT', '/api/deployments/web-api', { memLimit: 512 });

  console.log('\n== 9. Cluster process logs ==');
  st = await state();
  check('components listed in state', Array.isArray(st.components) && st.components.length === 6, JSON.stringify(st.components));
  for (const comp of st.components) {
    r = await api('GET', `/api/components/${comp}/logs`);
    check(`${comp} has logs`, r.status === 200 && r.data.logs.length > 0, `count=${r.data.logs?.length}`);
  }
  r = await api('GET', '/api/components/kube-scheduler/logs');
  check('scheduler logged pod bindings', r.data.logs.some(l => l.msg.includes('bound default/')));
  r = await api('GET', '/api/components/hpa-controller/logs');
  check('hpa-controller logged scale decisions', r.data.logs.some(l => l.msg.includes('SCALE')));
  r = await api('GET', '/api/components/cluster-autoscaler/logs');
  check('cluster-autoscaler logged scale-up', r.data.logs.some(l => l.msg.includes('SCALE UP')));
  r = await api('GET', '/api/components/kube-controller-manager/logs');
  check('controller-manager logged replicaset actions', r.data.logs.some(l => l.msg.includes('creating pod')));
  r = await api('GET', '/api/components/nope/logs');
  check('unknown component -> 404', r.status === 404);

  console.log('\n== 10. Manual pod kill (self-healing) ==');
  // isolate ReplicaSet self-healing from HPA reactions
  await api('PUT', '/api/deployments/web-api', { replicas: 3, hpa: { enabled: false } });
  await api('POST', '/api/load', { baseRps: 60 });
  await advance(30);
  st = await state();
  const beforeKill = st.deployments[0];
  const replicasBefore = beforeKill.replicas;
  const victim = runningPods(st, 'web-api')[0];
  const survivorUtilBefore = beforeKill.metrics.avgCpuUtil;

  r = await api('POST', `/api/pods/${victim.name}/kill`);
  check('kill endpoint returns victim', r.status === 200 && r.data.killed === victim.name, JSON.stringify(r.data));
  st = await state();
  const victimNow = st.deployments[0].pods.find(p => p.name === victim.name);
  check('victim is Terminating', victimNow && victimNow.phase === 'Terminating', victimNow?.phase);
  check('PodDeleted event emitted', st.events.some(e => e.reason === 'PodDeleted' && e.object === `pod/${victim.name}`));
  await advance(3);
  st = await state();
  const active = st.deployments[0].pods.filter(p => p.phase !== 'Terminating');
  check('ReplicaSet created a replacement', active.length === replicasBefore,
    `active=${active.length} expected=${replicasBefore}`);
  check('survivors absorb traffic (util rose)', st.deployments[0].metrics.avgCpuUtil > survivorUtilBefore,
    `before=${Math.round(survivorUtilBefore)}% after=${Math.round(st.deployments[0].metrics.avgCpuUtil)}%`);
  await advance(20);
  st = await state();
  check('replacement reached Running', runningPods(st, 'web-api').length === replicasBefore,
    JSON.stringify(st.deployments[0].pods.map(p => p.phase)));

  r = await api('POST', '/api/chaos/kill-random-pod');
  check('chaos kill-random works', r.status === 200 && typeof r.data.killed === 'string', JSON.stringify(r.data));
  r = await api('POST', '/api/pods/ghost/kill');
  check('kill unknown pod -> 400', r.status === 400);
  await api('POST', '/api/load', { baseRps: 0 });

  console.log('\n== 11. Misc API ==');
  r = await api('POST', '/api/speed', { speed: 5 });
  check('speed set', r.data.speed === 5);
  r = await api('POST', '/api/speed', { speed: 0 });
  check('speed 0 (pause) honored, not coerced to 1', r.data.speed === 0, `got ${r.data.speed}`);
  st = await state();
  const tPause = st.simTime;
  await new Promise(res => setTimeout(res, 1200));
  st = await state();
  check('sim clock frozen while paused', st.simTime === tPause, `${tPause} -> ${st.simTime}`);
  r = await api('PUT', '/api/cluster', { name: 'interview-prep', region: 'eu-west-1' });
  check('cluster rename', r.data.name === 'interview-prep' && r.data.region === 'eu-west-1');
  r = await api('GET', '/api/events');
  check('events endpoint', r.status === 200 && Array.isArray(r.data));
  r = await api('PUT', '/api/nodegroup', { instanceType: 'bogus.type' });
  check('bad instance type -> 400', r.status === 400);
  r = await api('POST', '/api/reset');
  check('reset ok', r.status === 200);
  st = await state();
  check('reset back to defaults', st.simTime < 5 && st.deployments.length === 1 && st.nodes.length === 2);

  console.log(`\n${'='.repeat(40)}\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch(err => { console.error('selftest crashed:', err); process.exit(1); });
