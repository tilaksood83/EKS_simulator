'use strict';

/*
 * EKS simulation engine.
 * Simulated time advances in 1-second "ticks". Everything (HPA, Cluster
 * Autoscaler, pod lifecycle, load, metrics) is evaluated per tick, mirroring
 * the reconcile loops of real Kubernetes controllers.
 */

const INSTANCE_TYPES = {
  't3.small':  { cpu: 2000, mem: 2048,  pricePerHour: 0.0208 },
  't3.medium': { cpu: 2000, mem: 4096,  pricePerHour: 0.0416 },
  't3.large':  { cpu: 2000, mem: 8192,  pricePerHour: 0.0832 },
  'm5.large':  { cpu: 2000, mem: 8192,  pricePerHour: 0.096 },
  'm5.xlarge': { cpu: 4000, mem: 16384, pricePerHour: 0.192 },
  'c5.large':  { cpu: 2000, mem: 4096,  pricePerHour: 0.085 },
  'c5.xlarge': { cpu: 4000, mem: 8192,  pricePerHour: 0.17 },
};

// Per-node overhead, mirroring real EKS worker nodes:
// kubelet/system reserved + the aws-node (VPC CNI) and kube-proxy DaemonSets.
const SYSTEM_RESERVED = { cpu: 90, mem: 300 };
const DAEMONSETS = [
  { name: 'aws-node',   cpu: 25,  mem: 64 },
  { name: 'kube-proxy', cpu: 100, mem: 64 },
];
const DAEMONSET_CPU = DAEMONSETS.reduce((s, d) => s + d.cpu, 0);
const DAEMONSET_MEM = DAEMONSETS.reduce((s, d) => s + d.mem, 0);

const EKS_CONTROL_PLANE_PRICE = 0.10; // $/hr

const MAX_EVENTS = 400;
const MAX_POD_LOGS = 250;
const MAX_COMPONENT_LOGS = 250;
const HISTORY_POINTS = 180;

// Control-plane processes that produce logs
const COMPONENTS = [
  'kube-apiserver',
  'etcd',
  'kube-scheduler',
  'kube-controller-manager',
  'hpa-controller',
  'cluster-autoscaler',
];

let podSerial = 0;
let nodeSerial = 0;

function rand5() {
  return Math.random().toString(36).slice(2, 7);
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

class Simulator {
  constructor() {
    this.reset();
  }

  reset(opts = {}) {
    this.simTime = 0;
    this.speed = 1;
    this.events = [];
    this.history = [];
    this.components = {};
    for (const c of COMPONENTS) this.components[c] = [];
    this.totalCost = 0;
    this.totalRequests = 0;
    this.totalErrors = 0;

    this.cluster = {
      name: opts.clusterName || 'demo-cluster',
      region: opts.region || 'us-east-1',
      version: opts.version || '1.32',
      endpoint: null,
      status: 'CREATING',
      createdAt: 0,
    };
    this.cluster.endpoint =
      `https://${rand5().toUpperCase()}${rand5().toUpperCase()}.gr7.${this.cluster.region}.eks.amazonaws.com`;

    this.nodeGroup = {
      name: 'ng-default',
      instanceType: 't3.medium',
      minNodes: 1,
      maxNodes: 6,
      desiredNodes: 2,
      // Cluster Autoscaler tuning
      scaleDownUtilizationThreshold: 0.5, // node considered underutilized below this
      scaleDownDelaySeconds: 60,          // how long it must stay underutilized
      pendingPodGraceSeconds: 10,         // unschedulable for this long => scale up
      nodeBootSeconds: 25,                // EC2 launch + bootstrap + node Ready
      lastScaleUpAt: -Infinity,
    };

    this.nodes = [];
    this.deployments = [];

    this.load = {
      baseRps: 0,
      pattern: 'steady',           // steady | wave
      waveAmplitude: 0,
      wavePeriodSeconds: 120,
      ramp: null,                  // { from, to, startedAt, durationSeconds }
      spike: null,                 // { magnitude, startedAt, durationSeconds }
      burstQueue: 0,               // one-off API calls drained over time
      currentRps: 0,
    };

    // initial worker nodes (already Ready, like a freshly created node group)
    for (let i = 0; i < this.nodeGroup.desiredNodes; i++) {
      this.nodes.push(this.makeNode(true));
    }

    this.addDeployment({
      name: 'web-api',
      image: 'myorg/web-api:1.4.2',
      replicas: 2,
      cpuRequest: 250,
      cpuLimit: 500,
      memRequest: 256,
      memLimit: 512,
      baseCpu: 30,
      cpuPerRequest: 4,
      startupSeconds: 8,
      trafficWeight: 1,
      hpa: {
        enabled: true,
        minReplicas: 2,
        maxReplicas: 10,
        targetCPUUtilization: 60,
        scaleUpCooldownSeconds: 15,
        scaleDownStabilizationSeconds: 60,
      },
    }, true);

    this.cluster.status = 'ACTIVE';
    this.event('Normal', 'ClusterReady', `cluster/${this.cluster.name}`,
      `EKS control plane is ACTIVE (Kubernetes v${this.cluster.version}, ${this.cluster.region})`);

    this.compLog('etcd', 'INFO', `etcd ${this.cluster.region} 3-member quorum established; serving client requests`);
    this.compLog('kube-apiserver', 'INFO', `kube-apiserver v${this.cluster.version} serving securely on :443 (${this.cluster.endpoint})`);
    this.compLog('kube-apiserver', 'INFO', 'established etcd connection; all storage backends healthy');
    this.compLog('kube-scheduler', 'INFO', 'acquired leader lease kube-system/kube-scheduler; starting scheduling cycle');
    this.compLog('kube-controller-manager', 'INFO', 'started controllers: deployment, replicaset, node, endpoint, serviceaccount');
    this.compLog('hpa-controller', 'INFO', 'horizontal-pod-autoscaler sync loop started (metrics-server connected)');
    this.compLog('cluster-autoscaler', 'INFO',
      `cluster-autoscaler started; node group ${this.nodeGroup.name} (min ${this.nodeGroup.minNodes}, max ${this.nodeGroup.maxNodes}, ${this.nodeGroup.instanceType})`);
  }

  // ---------------------------------------------------------------- events

  compLog(component, level, msg) {
    const logs = this.components[component];
    logs.push({ time: this.simTime, level, msg });
    if (logs.length > MAX_COMPONENT_LOGS) logs.splice(0, logs.length - MAX_COMPONENT_LOGS);
  }

  event(type, reason, object, message) {
    this.events.push({ time: this.simTime, type, reason, object, message });
    if (this.events.length > MAX_EVENTS) this.events.splice(0, this.events.length - MAX_EVENTS);
  }

  // ----------------------------------------------------------------- nodes

  makeNode(ready = false) {
    nodeSerial++;
    const octet3 = Math.floor(Math.random() * 64);
    const octet4 = 10 + (nodeSerial % 240);
    const node = {
      name: `ip-10-0-${octet3}-${octet4}.${this.cluster.region}.compute.internal`,
      instanceId: `i-0${rand5()}${rand5()}`,
      instanceType: this.nodeGroup.instanceType,
      status: ready ? 'Ready' : 'Provisioning', // Provisioning -> NotReady -> Ready
      createdAt: this.simTime,
      readyAt: ready ? this.simTime : null,
      bootRemaining: ready ? 0 : this.nodeGroup.nodeBootSeconds,
      cordoned: false,
      underutilizedSince: null,
      drainRemaining: 0,
    };
    if (!ready) {
      this.event('Normal', 'LaunchingInstance', `nodegroup/${this.nodeGroup.name}`,
        `Launching EC2 instance ${node.instanceId} (${node.instanceType})`);
    }
    return node;
  }

  nodeCapacity(node) {
    const t = INSTANCE_TYPES[node.instanceType];
    return {
      cpu: t.cpu - SYSTEM_RESERVED.cpu - DAEMONSET_CPU,
      mem: t.mem - SYSTEM_RESERVED.mem - DAEMONSET_MEM,
    };
  }

  nodeRequested(node) {
    let cpu = 0, mem = 0;
    for (const pod of this.allPods()) {
      if (pod.nodeName === node.name && pod.phase !== 'Terminating') {
        cpu += pod.spec.cpuRequest;
        mem += pod.spec.memRequest;
      }
    }
    return { cpu, mem };
  }

  nodeUsed(node) {
    let cpu = 0, mem = 0;
    for (const pod of this.allPods()) {
      if (pod.nodeName === node.name && pod.phase === 'Running') {
        cpu += pod.cpuUsage;
        mem += pod.memUsage;
      }
    }
    return { cpu, mem };
  }

  // ------------------------------------------------------------ deployments

  addDeployment(spec, silent = false) {
    if (this.deployments.some(d => d.name === spec.name)) {
      throw new Error(`deployment "${spec.name}" already exists`);
    }
    const dep = this.normalizeDeployment(spec);
    this.deployments.push(dep);
    if (!silent) {
      this.event('Normal', 'ScalingReplicaSet', `deployment/${dep.name}`,
        `Scaled up replica set ${dep.name}-${dep.rsHash} to ${dep.replicas}`);
    }
    for (let i = 0; i < dep.replicas; i++) this.createPod(dep);
    return dep;
  }

  normalizeDeployment(spec) {
    const hpaIn = spec.hpa || {};
    return {
      name: String(spec.name).toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 40),
      image: spec.image || `myorg/${spec.name}:latest`,
      rsHash: rand5() + rand5().slice(0, 4),
      replicas: clamp(Math.round(spec.replicas ?? 2), 0, 50),
      cpuRequest: clamp(Math.round(spec.cpuRequest ?? 250), 10, 8000),
      cpuLimit: clamp(Math.round(spec.cpuLimit ?? 500), 10, 8000),
      memRequest: clamp(Math.round(spec.memRequest ?? 256), 16, 16384),
      memLimit: clamp(Math.round(spec.memLimit ?? 512), 16, 16384),
      baseCpu: clamp(Math.round(spec.baseCpu ?? 30), 0, 2000),
      cpuPerRequest: clamp(Number(spec.cpuPerRequest ?? 4), 0.1, 100),
      startupSeconds: clamp(Math.round(spec.startupSeconds ?? 8), 1, 120),
      trafficWeight: clamp(Number(spec.trafficWeight ?? 1), 0, 100),
      pods: [],
      lastScaleUpAt: -Infinity,
      lastScaleDownAt: -Infinity,
      desiredHistory: [], // for scale-down stabilization
      metrics: { rps: 0, avgCpuUtil: 0, p50: 0, p99: 0, errorRate: 0 },
      hpa: {
        enabled: hpaIn.enabled !== false,
        minReplicas: clamp(Math.round(hpaIn.minReplicas ?? 1), 1, 50),
        maxReplicas: clamp(Math.round(hpaIn.maxReplicas ?? 10), 1, 100),
        targetCPUUtilization: clamp(Math.round(hpaIn.targetCPUUtilization ?? 60), 10, 95),
        scaleUpCooldownSeconds: clamp(Math.round(hpaIn.scaleUpCooldownSeconds ?? 15), 0, 600),
        scaleDownStabilizationSeconds: clamp(Math.round(hpaIn.scaleDownStabilizationSeconds ?? 60), 0, 1800),
      },
    };
  }

  updateDeployment(name, spec) {
    const dep = this.deployments.find(d => d.name === name);
    if (!dep) throw new Error(`deployment "${name}" not found`);
    const resourceFields = ['cpuRequest', 'cpuLimit', 'memRequest', 'memLimit', 'baseCpu', 'cpuPerRequest', 'image', 'startupSeconds'];
    const next = this.normalizeDeployment({ ...dep, ...spec, hpa: { ...dep.hpa, ...(spec.hpa || {}) }, name });
    const rollingUpdate = resourceFields.some(f => next[f] !== dep[f]);

    Object.assign(dep, {
      image: next.image, replicas: next.replicas,
      cpuRequest: next.cpuRequest, cpuLimit: next.cpuLimit,
      memRequest: next.memRequest, memLimit: next.memLimit,
      baseCpu: next.baseCpu, cpuPerRequest: next.cpuPerRequest,
      startupSeconds: next.startupSeconds, trafficWeight: next.trafficWeight,
      hpa: next.hpa,
    });

    if (rollingUpdate) {
      dep.rsHash = rand5() + rand5().slice(0, 4);
      this.event('Normal', 'RollingUpdate', `deployment/${dep.name}`,
        `Spec changed; rolling update to replica set ${dep.name}-${dep.rsHash}`);
      for (const pod of dep.pods) {
        if (pod.phase !== 'Terminating') this.terminatePod(pod, 'rolling update');
      }
    }
    this.reconcileDeployment(dep);
    return dep;
  }

  deleteDeployment(name) {
    const idx = this.deployments.findIndex(d => d.name === name);
    if (idx === -1) throw new Error(`deployment "${name}" not found`);
    const dep = this.deployments[idx];
    for (const pod of dep.pods) {
      if (pod.phase !== 'Terminating') this.terminatePod(pod, 'deployment deleted');
    }
    dep.deleted = true;
    this.event('Normal', 'Killing', `deployment/${dep.name}`, `Deployment ${dep.name} deleted`);
  }

  allPods() {
    const pods = [];
    for (const d of this.deployments) pods.push(...d.pods);
    return pods;
  }

  // ------------------------------------------------------------------ pods

  createPod(dep) {
    podSerial++;
    const pod = {
      name: `${dep.name}-${dep.rsHash}-${rand5()}`,
      deployment: dep.name,
      phase: 'Pending', // Pending -> ContainerCreating -> Running -> Terminating
      nodeName: null,
      createdAt: this.simTime,
      pendingSince: this.simTime,
      startRemaining: 0,
      terminateRemaining: 0,
      restarts: 0,
      cpuUsage: 0,
      memUsage: 0,
      cpuUtil: 0,
      rps: 0,
      throttled: false,
      logs: [],
      spec: {
        cpuRequest: dep.cpuRequest,
        cpuLimit: dep.cpuLimit,
        memRequest: dep.memRequest,
        memLimit: dep.memLimit,
      },
    };
    dep.pods.push(pod);
    this.podLog(pod, 'INFO', `pod created, waiting for scheduler`);
    this.compLog('kube-controller-manager', 'INFO',
      `replicaset ${dep.name}-${dep.rsHash}: too few replicas, creating pod ${pod.name} (desired ${dep.replicas})`);
    this.compLog('kube-apiserver', 'INFO', `POST /api/v1/namespaces/default/pods 201 Created (${pod.name})`);
    return pod;
  }

  terminatePod(pod, why) {
    pod.phase = 'Terminating';
    pod.terminateRemaining = 3;
    this.podLog(pod, 'INFO', `SIGTERM received (${why}); draining in-flight requests`);
    this.event('Normal', 'Killing', `pod/${pod.name}`, `Stopping container (${why})`);
    this.compLog('kube-apiserver', 'INFO', `DELETE /api/v1/namespaces/default/pods/${pod.name} 200 OK (${why})`);
  }

  killPod(podName) {
    let pod = null, dep = null;
    if (podName) {
      for (const d of this.deployments) {
        const p = d.pods.find(x => x.name === podName && x.phase !== 'Terminating');
        if (p) { pod = p; dep = d; break; }
      }
      if (!pod) throw new Error(`pod "${podName}" not found (or already terminating)`);
    } else {
      const candidates = this.allPods().filter(p => p.phase === 'Running');
      if (candidates.length === 0) throw new Error('no running pods to kill');
      pod = candidates[Math.floor(Math.random() * candidates.length)];
      dep = this.deployments.find(d => d.name === pod.deployment);
    }
    this.event('Warning', 'PodDeleted', `pod/${pod.name}`,
      `Pod manually killed (kubectl delete pod ${pod.name}); ReplicaSet will create a replacement`);
    this.podLog(pod, 'ERROR', `received external kill signal (manual delete)`);
    this.terminatePod(pod, 'manual kill');
    return { killed: pod.name, deployment: dep.name };
  }

  podLog(pod, level, msg) {
    pod.logs.push({ time: this.simTime, level, msg });
    if (pod.logs.length > MAX_POD_LOGS) pod.logs.splice(0, pod.logs.length - MAX_POD_LOGS);
  }

  // -------------------------------------------------------------- main tick

  tick() {
    this.simTime++;

    this.computeLoad();
    this.progressNodes();
    this.schedulePendingPods();
    this.progressPods();
    this.distributeTraffic();
    this.runHPA();
    this.reconcileDeployments();
    this.runClusterAutoscaler();
    this.accrueCost();
    this.recordHistory();
    this.heartbeatLogs();
    this.gc();
  }

  heartbeatLogs() {
    const pods = this.allPods();
    if (this.simTime % 20 === 0) {
      const watchers = this.nodes.length * 4 + pods.length * 2 + 12;
      this.compLog('kube-apiserver', 'INFO',
        `served ~${watchers + Math.round(this.load.currentRps / 20)} requests in last 20s (active watches: ${watchers}, objects: ${pods.length} pods / ${this.nodes.length} nodes)`);
    }
    if (this.simTime % 60 === 0) {
      const rev = 1000 + this.simTime * 7 + pods.length * 3;
      this.compLog('etcd', 'INFO',
        `finished scheduled compaction at revision ${rev}; db size in use ${(4 + pods.length * 0.05 + this.events.length * 0.01).toFixed(1)} MB`);
    }
    if (this.simTime % 30 === 0) {
      const pending = pods.filter(p => p.phase === 'Pending').length;
      const candidates = this.nodes.filter(n => n.underutilizedSince !== null).length;
      this.compLog('cluster-autoscaler', 'INFO',
        `scan: ${pending} unschedulable pod(s), ${this.nodes.length} node(s) [min ${this.nodeGroup.minNodes} / max ${this.nodeGroup.maxNodes}], ${candidates} scale-down candidate(s)`);
    }
    if (this.simTime % 30 === 10) {
      this.compLog('kube-scheduler', 'INFO',
        `scheduling cycle ok; queue depth ${pods.filter(p => p.phase === 'Pending').length}`);
    }
  }

  computeLoad() {
    const L = this.load;
    let rps = L.baseRps;

    if (L.pattern === 'wave' && L.waveAmplitude > 0) {
      rps += L.waveAmplitude * (0.5 + 0.5 * Math.sin((2 * Math.PI * this.simTime) / L.wavePeriodSeconds));
    }
    if (L.ramp) {
      const t = (this.simTime - L.ramp.startedAt) / L.ramp.durationSeconds;
      if (t >= 1) {
        L.baseRps = L.ramp.to;
        rps = L.ramp.to;
        L.ramp = null;
        this.event('Normal', 'LoadRampComplete', 'loadgen', `Ramp finished; steady load now ${Math.round(rps)} req/s`);
      } else {
        rps = L.ramp.from + (L.ramp.to - L.ramp.from) * t;
      }
    }
    if (L.spike) {
      const elapsed = this.simTime - L.spike.startedAt;
      if (elapsed >= L.spike.durationSeconds) {
        L.spike = null;
        this.event('Normal', 'LoadSpikeEnded', 'loadgen', 'Traffic spike ended');
      } else {
        rps += L.spike.magnitude;
      }
    }
    if (L.burstQueue > 0) {
      const drain = Math.min(L.burstQueue, Math.max(20, L.burstQueue / 5));
      L.burstQueue -= drain;
      rps += drain;
    }

    L.currentRps = Math.max(0, rps);
  }

  progressNodes() {
    for (const node of this.nodes) {
      if (node.status === 'Provisioning') {
        node.bootRemaining--;
        if (node.bootRemaining <= 0) {
          node.status = 'Ready';
          node.readyAt = this.simTime;
          this.event('Normal', 'NodeReady', `node/${node.name}`,
            `Node is Ready (${node.instanceType}, instance ${node.instanceId})`);
          this.compLog('kube-apiserver', 'INFO', `node ${node.name} registered (kubelet TLS bootstrap complete)`);
          this.compLog('kube-controller-manager', 'INFO',
            `node-controller: node ${node.name} transitioned to Ready; allocatable cpu ${this.nodeCapacity(node).cpu}m`);
        }
      }
      if (node.status === 'Draining') {
        node.drainRemaining--;
        if (node.drainRemaining <= 0) {
          node.status = 'Removed';
          this.event('Normal', 'NodeRemoved', `node/${node.name}`,
            `Scale-down: terminated EC2 instance ${node.instanceId}`);
        }
      }
    }
    this.nodes = this.nodes.filter(n => n.status !== 'Removed');
  }

  schedulePendingPods() {
    const pending = this.allPods().filter(p => p.phase === 'Pending');
    for (const pod of pending) {
      const node = this.findNodeFor(pod);
      if (node) {
        pod.nodeName = node.name;
        pod.phase = 'ContainerCreating';
        pod.startRemaining = this.deployments.find(d => d.name === pod.deployment).startupSeconds;
        this.event('Normal', 'Scheduled', `pod/${pod.name}`,
          `Successfully assigned default/${pod.name} to ${node.name}`);
        this.podLog(pod, 'INFO', `scheduled to ${node.name}; pulling image`);
        this.compLog('kube-scheduler', 'INFO',
          `bound default/${pod.name} to ${node.name} (plugin: NodeResourcesFit, cpu req ${pod.spec.cpuRequest}m)`);
        this.compLog('kube-apiserver', 'INFO', `POST /api/v1/namespaces/default/pods/${pod.name}/binding 201 Created`);
      } else if (this.simTime - pod.pendingSince === 5) {
        this.event('Warning', 'FailedScheduling', `pod/${pod.name}`,
          `0/${this.readyNodes().length} nodes are available: insufficient cpu/memory.`);
        this.compLog('kube-scheduler', 'WARN',
          `failed to schedule default/${pod.name}: 0/${this.readyNodes().length} nodes available (insufficient cpu/memory); requeued`);
      }
    }
  }

  findNodeFor(pod) {
    const candidates = this.readyNodes().filter(n => !n.cordoned);
    for (const node of candidates) {
      const cap = this.nodeCapacity(node);
      const req = this.nodeRequested(node);
      if (req.cpu + pod.spec.cpuRequest <= cap.cpu && req.mem + pod.spec.memRequest <= cap.mem) {
        return node;
      }
    }
    return null;
  }

  readyNodes() {
    return this.nodes.filter(n => n.status === 'Ready' || n.status === 'Draining');
  }

  progressPods() {
    for (const dep of this.deployments) {
      for (const pod of dep.pods) {
        if (pod.phase === 'ContainerCreating') {
          pod.startRemaining--;
          if (pod.startRemaining === Math.max(1, dep.startupSeconds - 2)) {
            this.event('Normal', 'Pulled', `pod/${pod.name}`, `Successfully pulled image "${dep.image}"`);
          }
          if (pod.startRemaining <= 0) {
            pod.phase = 'Running';
            this.event('Normal', 'Started', `pod/${pod.name}`, `Started container ${dep.name}`);
            this.podLog(pod, 'INFO', `server listening on :8080`);
            this.podLog(pod, 'INFO', `readiness probe succeeded; receiving traffic`);
          }
        } else if (pod.phase === 'Terminating') {
          pod.terminateRemaining--;
          if (pod.terminateRemaining <= 0) pod.phase = 'Succeeded';
        }
      }
      dep.pods = dep.pods.filter(p => p.phase !== 'Succeeded');
    }
    this.deployments = this.deployments.filter(d => !d.deleted || d.pods.length > 0);
  }

  distributeTraffic() {
    const totalWeight = this.deployments.reduce((s, d) => s + (d.deleted ? 0 : d.trafficWeight), 0);
    let totalHandled = 0, totalErrors = 0;

    for (const dep of this.deployments) {
      const share = totalWeight > 0 && !dep.deleted ? (dep.trafficWeight / totalWeight) : 0;
      const depRps = this.load.currentRps * share;
      const running = dep.pods.filter(p => p.phase === 'Running');
      dep.metrics.rps = depRps;

      if (running.length === 0) {
        dep.metrics.avgCpuUtil = 0;
        dep.metrics.errorRate = depRps > 0 ? 1 : 0;
        dep.metrics.p50 = 0;
        dep.metrics.p99 = 0;
        totalErrors += depRps;
        continue;
      }

      const perPod = depRps / running.length;
      // requests/s one pod can serve before hitting its CPU limit
      const podCapacity = Math.max(0.1, (dep.cpuLimit - dep.baseCpu) / dep.cpuPerRequest);
      let utilSum = 0, errSum = 0, served = 0;

      for (const pod of running) {
        const jitter = 0.95 + Math.random() * 0.1;
        const wantCpu = dep.baseCpu + perPod * dep.cpuPerRequest * jitter;
        pod.cpuUsage = Math.min(wantCpu, dep.cpuLimit); // CFS throttling at the limit
        pod.throttled = wantCpu > dep.cpuLimit;
        pod.cpuUtil = (pod.cpuUsage / dep.cpuRequest) * 100;
        pod.rps = Math.min(perPod, podCapacity);
        served += pod.rps;
        errSum += Math.max(0, perPod - podCapacity);
        utilSum += pod.cpuUtil;

        const loadFactor = clamp(pod.cpuUsage / dep.cpuLimit, 0, 1);
        pod.memUsage = Math.round(dep.memRequest * (0.55 + 0.35 * loadFactor) + (Math.random() * 8 - 4));

        if (dep.memLimit && pod.memUsage > dep.memLimit) {
          pod.restarts++;
          pod.phase = 'ContainerCreating';
          pod.startRemaining = dep.startupSeconds;
          this.event('Warning', 'OOMKilled', `pod/${pod.name}`,
            `Container exceeded memory limit (${pod.memUsage}Mi > ${dep.memLimit}Mi); restarting (restart #${pod.restarts})`);
          this.podLog(pod, 'ERROR', `OOMKilled: memory ${pod.memUsage}Mi exceeded limit ${dep.memLimit}Mi`);
          continue;
        }

        // periodic application log lines
        if (this.simTime % 5 === 0 && perPod > 0) {
          const saturation = perPod / podCapacity;
          const p99 = Math.round(35 * (1 + Math.max(0, saturation - 0.7) * 6));
          if (pod.throttled) {
            this.podLog(pod, 'WARN',
              `CPU throttled: want ${Math.round(wantCpu)}m > limit ${dep.cpuLimit}m; p99=${p99}ms, shedding ${Math.round(Math.max(0, perPod - podCapacity))} req/s`);
          } else {
            this.podLog(pod, 'INFO',
              `handled ${Math.round(perPod)} req/s | cpu=${Math.round(pod.cpuUsage)}m/${dep.cpuLimit}m (${Math.round(pod.cpuUtil)}% of request) | mem=${pod.memUsage}Mi | p99=${p99}ms`);
          }
        }
      }

      const saturation = perPod / podCapacity;
      dep.metrics.avgCpuUtil = utilSum / running.length;
      dep.metrics.errorRate = depRps > 0 ? errSum / depRps : 0;
      dep.metrics.p50 = Math.round(12 * (1 + Math.max(0, saturation - 0.8) * 5));
      dep.metrics.p99 = Math.round(35 * (1 + Math.max(0, saturation - 0.7) * 6));
      totalHandled += served;
      totalErrors += errSum;
    }

    // idle pods still report usage
    for (const dep of this.deployments) {
      for (const pod of dep.pods) {
        if (pod.phase !== 'Running') {
          pod.cpuUsage = 0; pod.cpuUtil = 0; pod.rps = 0;
          if (pod.phase !== 'Pending') pod.memUsage = Math.round(dep.memRequest * 0.3);
        }
      }
    }

    this.totalRequests += totalHandled;
    this.totalErrors += totalErrors;
    this._tickErrors = totalErrors;
  }

  // ---------------------------------------------------- HPA (per deployment)

  runHPA() {
    for (const dep of this.deployments) {
      if (dep.deleted || !dep.hpa.enabled) { dep.desiredHistory = []; continue; }
      const hpa = dep.hpa;
      const running = dep.pods.filter(p => p.phase === 'Running');
      if (running.length === 0) continue;

      const avgUtil = dep.metrics.avgCpuUtil;
      const ratio = avgUtil / hpa.targetCPUUtilization;
      // k8s tolerance: ignore changes within 10% of target
      let desired = dep.replicas;
      if (Math.abs(ratio - 1) > 0.1) {
        desired = Math.ceil(dep.replicas * ratio);
      }
      desired = clamp(desired, hpa.minReplicas, hpa.maxReplicas);

      if (this.simTime % 15 === 0) {
        this.compLog('hpa-controller', 'INFO',
          `${dep.name}: avg cpu ${Math.round(avgUtil)}% / target ${hpa.targetCPUUtilization}% across ${running.length} pod(s) -> desired ${desired} (current ${dep.replicas}, min ${hpa.minReplicas}, max ${hpa.maxReplicas})`);
      }

      dep.desiredHistory.push({ time: this.simTime, desired });
      const windowStart = this.simTime - hpa.scaleDownStabilizationSeconds;
      dep.desiredHistory = dep.desiredHistory.filter(h => h.time >= windowStart);

      if (desired > dep.replicas) {
        if (this.simTime - dep.lastScaleUpAt < hpa.scaleUpCooldownSeconds) continue;
        // k8s scale-up policy: at most double per period
        desired = Math.min(desired, Math.max(dep.replicas * 2, dep.replicas + 4));
        const prev = dep.replicas;
        dep.replicas = desired;
        dep.lastScaleUpAt = this.simTime;
        this.event('Normal', 'SuccessfulRescale', `hpa/${dep.name}`,
          `New size: ${desired} (was ${prev}); reason: cpu utilization ${Math.round(avgUtil)}% above target ${hpa.targetCPUUtilization}%`);
        this.compLog('hpa-controller', 'INFO',
          `SCALE UP ${dep.name}: ${prev} -> ${desired} replicas (cpu ${Math.round(avgUtil)}% > target ${hpa.targetCPUUtilization}%); ratio=${ratio.toFixed(2)}`);
      } else if (desired < dep.replicas) {
        // scale-down stabilization: use the MAX desired over the window
        const stableDesired = Math.max(...dep.desiredHistory.map(h => h.desired));
        if (stableDesired < dep.replicas &&
            this.simTime - dep.lastScaleUpAt >= hpa.scaleDownStabilizationSeconds) {
          const prev = dep.replicas;
          dep.replicas = stableDesired;
          dep.lastScaleDownAt = this.simTime;
          this.event('Normal', 'SuccessfulRescale', `hpa/${dep.name}`,
            `New size: ${stableDesired} (was ${prev}); reason: cpu utilization ${Math.round(avgUtil)}% below target ${hpa.targetCPUUtilization}% for ${hpa.scaleDownStabilizationSeconds}s`);
          this.compLog('hpa-controller', 'INFO',
            `SCALE DOWN ${dep.name}: ${prev} -> ${stableDesired} replicas (cpu ${Math.round(avgUtil)}% < target ${hpa.targetCPUUtilization}% for full ${hpa.scaleDownStabilizationSeconds}s stabilization window)`);
        }
      }
    }
  }

  reconcileDeployments() {
    for (const dep of this.deployments) {
      if (dep.deleted) continue;
      this.reconcileDeployment(dep);
    }
  }

  reconcileDeployment(dep) {
    const active = dep.pods.filter(p => p.phase !== 'Terminating');
    const diff = dep.replicas - active.length;
    if (diff > 0) {
      for (let i = 0; i < diff; i++) this.createPod(dep);
      this.event('Normal', 'ScalingReplicaSet', `deployment/${dep.name}`,
        `Scaled up replica set ${dep.name}-${dep.rsHash} to ${dep.replicas}`);
    } else if (diff < 0) {
      // remove newest pods first
      const victims = [...active].sort((a, b) => b.createdAt - a.createdAt).slice(0, -diff);
      for (const pod of victims) this.terminatePod(pod, 'scale down');
      this.event('Normal', 'ScalingReplicaSet', `deployment/${dep.name}`,
        `Scaled down replica set ${dep.name}-${dep.rsHash} to ${dep.replicas}`);
    }
  }

  // -------------------------------------------------------- Cluster Autoscaler

  runClusterAutoscaler() {
    const ng = this.nodeGroup;

    // SCALE UP: unschedulable pods waiting past the grace period
    const unschedulable = this.allPods().filter(p =>
      p.phase === 'Pending' && this.simTime - p.pendingSince >= ng.pendingPodGraceSeconds);

    if (unschedulable.length > 0 &&
        this.nodes.length < ng.maxNodes &&
        this.simTime - ng.lastScaleUpAt >= 15) {
      // add enough nodes to fit the pending pods (capped by maxNodes)
      const cap = this.nodeCapacity({ instanceType: ng.instanceType });
      let cpuNeeded = unschedulable.reduce((s, p) => s + p.spec.cpuRequest, 0);
      let memNeeded = unschedulable.reduce((s, p) => s + p.spec.memRequest, 0);
      const nodesNeeded = clamp(
        Math.max(Math.ceil(cpuNeeded / cap.cpu), Math.ceil(memNeeded / cap.mem)),
        1, ng.maxNodes - this.nodes.length);
      for (let i = 0; i < nodesNeeded; i++) this.nodes.push(this.makeNode(false));
      ng.desiredNodes = this.nodes.length;
      ng.lastScaleUpAt = this.simTime;
      this.event('Normal', 'TriggeredScaleUp', 'cluster-autoscaler',
        `pod(s) pending and unschedulable: scaling node group ${ng.name} ${this.nodes.length - nodesNeeded}->${this.nodes.length} (max ${ng.maxNodes})`);
      this.compLog('cluster-autoscaler', 'INFO',
        `SCALE UP: ${unschedulable.length} unschedulable pod(s) need ~${cpuNeeded}m cpu / ${memNeeded}Mi mem; expanding ASG ${ng.name} by ${nodesNeeded} node(s) to ${this.nodes.length}`);
    } else if (unschedulable.length > 0 && this.nodes.length >= ng.maxNodes && this.simTime % 30 === 0) {
      this.compLog('cluster-autoscaler', 'WARN',
        `${unschedulable.length} unschedulable pod(s) but node group ${ng.name} is at max size (${ng.maxNodes}); no scale-up possible`);
    }

    // SCALE DOWN: underutilized nodes whose pods fit elsewhere
    if (this.simTime - ng.lastScaleUpAt < 60) return; // post-scale-up cooldown
    const ready = this.nodes.filter(n => n.status === 'Ready' && !n.cordoned);
    if (ready.length <= ng.minNodes) return;

    for (const node of ready) {
      const cap = this.nodeCapacity(node);
      const req = this.nodeRequested(node);
      const util = Math.max(req.cpu / cap.cpu, req.mem / cap.mem);

      if (util < ng.scaleDownUtilizationThreshold) {
        if (node.underutilizedSince === null) node.underutilizedSince = this.simTime;
        if (this.simTime - node.underutilizedSince >= ng.scaleDownDelaySeconds &&
            this.podsFitElsewhere(node)) {
          node.cordoned = true;
          node.status = 'Draining';
          node.drainRemaining = 6;
          const evicted = this.allPods().filter(p => p.nodeName === node.name && p.phase !== 'Terminating');
          for (const pod of evicted) {
            pod.phase = 'Pending';
            pod.nodeName = null;
            pod.pendingSince = this.simTime;
            this.podLog(pod, 'WARN', `evicted from ${node.name} (node scale-down); rescheduling`);
            this.event('Normal', 'Evicted', `pod/${pod.name}`, `Evicted for node scale-down`);
          }
          this.event('Normal', 'ScaleDown', 'cluster-autoscaler',
            `node ${node.name} utilization ${(util * 100).toFixed(0)}% < ${(ng.scaleDownUtilizationThreshold * 100).toFixed(0)}% for ${ng.scaleDownDelaySeconds}s; draining and removing`);
          this.compLog('cluster-autoscaler', 'INFO',
            `SCALE DOWN: ${node.name} requested ${(util * 100).toFixed(0)}% < threshold ${(ng.scaleDownUtilizationThreshold * 100).toFixed(0)}% for ${ng.scaleDownDelaySeconds}s and all ${evicted.length} pod(s) fit elsewhere; cordoning + draining`);
          ng.desiredNodes = Math.max(ng.minNodes, this.nodes.length - 1);
          break; // remove at most one node per tick
        }
      } else {
        node.underutilizedSince = null;
      }
    }
  }

  podsFitElsewhere(node) {
    const movingPods = this.allPods().filter(p => p.nodeName === node.name && p.phase !== 'Terminating');
    if (movingPods.length === 0) return true;
    // simulate first-fit onto the other Ready nodes' free request capacity
    const others = this.nodes.filter(n => n !== node && n.status === 'Ready' && !n.cordoned);
    const free = others.map(n => {
      const cap = this.nodeCapacity(n);
      const req = this.nodeRequested(n);
      return { cpu: cap.cpu - req.cpu, mem: cap.mem - req.mem };
    });
    const sorted = [...movingPods].sort((a, b) => b.spec.cpuRequest - a.spec.cpuRequest);
    for (const pod of sorted) {
      const slot = free.find(f => f.cpu >= pod.spec.cpuRequest && f.mem >= pod.spec.memRequest);
      if (!slot) return false;
      slot.cpu -= pod.spec.cpuRequest;
      slot.mem -= pod.spec.memRequest;
    }
    return true;
  }

  // ----------------------------------------------------------------- misc

  accrueCost() {
    let hourly = EKS_CONTROL_PLANE_PRICE;
    for (const node of this.nodes) {
      if (node.status !== 'Removed') hourly += INSTANCE_TYPES[node.instanceType].pricePerHour;
    }
    this.currentHourlyCost = hourly;
    this.totalCost += hourly / 3600;
  }

  recordHistory() {
    const pods = this.allPods();
    const running = pods.filter(p => p.phase === 'Running');
    const utils = this.deployments.filter(d => !d.deleted && d.pods.some(p => p.phase === 'Running'));
    const avgUtil = utils.length
      ? utils.reduce((s, d) => s + d.metrics.avgCpuUtil, 0) / utils.length : 0;
    const p99 = Math.max(0, ...this.deployments.filter(d => !d.deleted).map(d => d.metrics.p99));

    this.history.push({
      time: this.simTime,
      rps: Math.round(this.load.currentRps * 10) / 10,
      avgCpuUtil: Math.round(avgUtil * 10) / 10,
      replicas: running.length,
      desiredReplicas: this.deployments.reduce((s, d) => s + (d.deleted ? 0 : d.replicas), 0),
      nodes: this.nodes.filter(n => n.status === 'Ready' || n.status === 'Draining').length,
      provisioningNodes: this.nodes.filter(n => n.status === 'Provisioning').length,
      pendingPods: pods.filter(p => p.phase === 'Pending').length,
      p99,
      errors: Math.round((this._tickErrors || 0) * 10) / 10,
    });
    if (this.history.length > HISTORY_POINTS) this.history.splice(0, this.history.length - HISTORY_POINTS);
  }

  gc() {
    // nothing else for now
  }

  // ------------------------------------------------------------- public API

  setLoad(opts) {
    const L = this.load;
    if (opts.baseRps !== undefined) {
      L.baseRps = clamp(Number(opts.baseRps) || 0, 0, 100000);
      this.event('Normal', 'LoadChanged', 'loadgen', `Steady load set to ${L.baseRps} req/s`);
    }
    if (opts.pattern !== undefined) L.pattern = opts.pattern === 'wave' ? 'wave' : 'steady';
    if (opts.waveAmplitude !== undefined) L.waveAmplitude = clamp(Number(opts.waveAmplitude) || 0, 0, 100000);
    if (opts.wavePeriodSeconds !== undefined) L.wavePeriodSeconds = clamp(Number(opts.wavePeriodSeconds) || 120, 10, 3600);
    return L;
  }

  burst(requests) {
    const n = clamp(Math.round(Number(requests) || 0), 1, 1000000);
    this.load.burstQueue += n;
    this.event('Normal', 'BurstReceived', 'loadgen', `Burst of ${n} API calls queued`);
    return { queued: n };
  }

  spike(magnitude, durationSeconds) {
    this.load.spike = {
      magnitude: clamp(Number(magnitude) || 100, 1, 100000),
      durationSeconds: clamp(Math.round(Number(durationSeconds) || 60), 5, 3600),
      startedAt: this.simTime,
    };
    this.event('Normal', 'LoadSpike', 'loadgen',
      `Traffic spike: +${this.load.spike.magnitude} req/s for ${this.load.spike.durationSeconds}s`);
    return this.load.spike;
  }

  ramp(to, durationSeconds) {
    this.load.ramp = {
      from: this.load.currentRps,
      to: clamp(Number(to) || 0, 0, 100000),
      durationSeconds: clamp(Math.round(Number(durationSeconds) || 60), 5, 3600),
      startedAt: this.simTime,
    };
    this.event('Normal', 'LoadRamp', 'loadgen',
      `Ramping load to ${this.load.ramp.to} req/s over ${this.load.ramp.durationSeconds}s`);
    return this.load.ramp;
  }

  updateNodeGroup(spec) {
    const ng = this.nodeGroup;
    if (spec.instanceType !== undefined) {
      if (!INSTANCE_TYPES[spec.instanceType]) throw new Error(`unknown instance type "${spec.instanceType}"`);
      if (spec.instanceType !== ng.instanceType) {
        ng.instanceType = spec.instanceType;
        this.event('Normal', 'NodeGroupUpdate', `nodegroup/${ng.name}`,
          `Instance type changed to ${ng.instanceType}; new nodes will use it (existing nodes keep theirs)`);
      }
    }
    if (spec.minNodes !== undefined) ng.minNodes = clamp(Math.round(spec.minNodes), 0, 20);
    if (spec.maxNodes !== undefined) ng.maxNodes = clamp(Math.round(spec.maxNodes), 1, 30);
    if (ng.minNodes > ng.maxNodes) ng.minNodes = ng.maxNodes;
    if (spec.scaleDownUtilizationThreshold !== undefined)
      ng.scaleDownUtilizationThreshold = clamp(Number(spec.scaleDownUtilizationThreshold), 0.05, 0.95);
    if (spec.scaleDownDelaySeconds !== undefined)
      ng.scaleDownDelaySeconds = clamp(Math.round(spec.scaleDownDelaySeconds), 10, 3600);
    if (spec.nodeBootSeconds !== undefined)
      ng.nodeBootSeconds = clamp(Math.round(spec.nodeBootSeconds), 5, 300);

    // honor a raised minimum immediately
    while (this.nodes.length < ng.minNodes) this.nodes.push(this.makeNode(false));
    ng.desiredNodes = this.nodes.length;
    return ng;
  }

  updateCluster(spec) {
    if (spec.name) this.cluster.name = String(spec.name).slice(0, 60);
    if (spec.region) this.cluster.region = String(spec.region).slice(0, 30);
    if (spec.version) this.cluster.version = String(spec.version).slice(0, 10);
    return this.cluster;
  }

  setSpeed(speed) {
    const n = Number(speed);
    this.speed = clamp(Number.isFinite(n) ? Math.round(n) : 1, 0, 60);
    return this.speed;
  }

  advance(seconds) {
    const n = clamp(Math.round(Number(seconds) || 0), 1, 3600);
    for (let i = 0; i < n; i++) this.tick();
    return { advanced: n, simTime: this.simTime };
  }

  getState() {
    return {
      simTime: this.simTime,
      speed: this.speed,
      cluster: this.cluster,
      nodeGroup: {
        ...this.nodeGroup,
        instanceTypes: Object.entries(INSTANCE_TYPES).map(([name, t]) => ({
          name, vcpu: t.cpu / 1000, memGiB: t.mem / 1024, pricePerHour: t.pricePerHour,
        })),
      },
      nodes: this.nodes.map(n => {
        const cap = this.nodeCapacity(n);
        const req = this.nodeRequested(n);
        const used = this.nodeUsed(n);
        return {
          name: n.name, instanceId: n.instanceId, instanceType: n.instanceType,
          status: n.status, cordoned: n.cordoned,
          ageSeconds: this.simTime - n.createdAt,
          bootRemaining: n.bootRemaining,
          allocatable: cap, requested: req, used,
          daemonsets: DAEMONSETS.map(d => d.name),
        };
      }),
      deployments: this.deployments.filter(d => !d.deleted).map(d => ({
        name: d.name, image: d.image, replicas: d.replicas,
        cpuRequest: d.cpuRequest, cpuLimit: d.cpuLimit,
        memRequest: d.memRequest, memLimit: d.memLimit,
        baseCpu: d.baseCpu, cpuPerRequest: d.cpuPerRequest,
        startupSeconds: d.startupSeconds, trafficWeight: d.trafficWeight,
        hpa: d.hpa, metrics: d.metrics,
        pods: d.pods.map(p => ({
          name: p.name, phase: p.phase, nodeName: p.nodeName,
          ageSeconds: this.simTime - p.createdAt, restarts: p.restarts,
          cpuUsage: Math.round(p.cpuUsage), cpuUtil: Math.round(p.cpuUtil),
          memUsage: p.memUsage, rps: Math.round(p.rps * 10) / 10,
          throttled: p.throttled,
          cpuRequest: p.spec.cpuRequest, cpuLimit: p.spec.cpuLimit,
          memRequest: p.spec.memRequest, memLimit: p.spec.memLimit,
        })),
      })),
      load: this.load,
      history: this.history,
      events: this.events.slice(-120),
      components: COMPONENTS,
      cost: {
        hourly: Math.round((this.currentHourlyCost || 0) * 10000) / 10000,
        total: Math.round(this.totalCost * 10000) / 10000,
      },
      totals: {
        requests: Math.round(this.totalRequests),
        errors: Math.round(this.totalErrors),
      },
    };
  }

  getComponentLogs(name) {
    if (!this.components[name]) return null;
    return { component: name, logs: this.components[name] };
  }

  getPodLogs(podName) {
    for (const dep of this.deployments) {
      const pod = dep.pods.find(p => p.name === podName);
      if (pod) return { pod: pod.name, phase: pod.phase, logs: pod.logs };
    }
    return null;
  }
}

// Dual export: Node (server.js, selftest) and browser (solo mode loads this
// same file via /solo/engine.js — single source of truth, no copies to drift).
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { Simulator, INSTANCE_TYPES };
} else if (typeof window !== 'undefined') {
  window.EKS = { Simulator, INSTANCE_TYPES };
}
