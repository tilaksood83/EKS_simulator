# EKS Simulator

A zero-dependency Node.js simulator of an AWS EKS cluster, built for **Kubernetes/EKS interview preparation and learning**. It models the full autoscaling chain you'll be asked about in interviews:

> traffic ↑ → pod CPU ↑ → **HPA** adds pods → pods don't fit → Pending → **Cluster Autoscaler** adds EC2 nodes → nodes boot → pods schedule → utilization normalizes

## Run

```bash
node server.js          # http://localhost:3000
node server.js 8080     # custom port (or PORT env var)
node scripts/selftest.js  # 75-check end-to-end test suite
```

No `npm install` needed — uses only Node built-ins (Node ≥ 18).

### Docker

```bash
docker build -t eks-simulator .
docker run -d --name eks-simulator -p 3300:3000 eks-simulator
# open http://localhost:3300

# run the full test suite against the container
TARGET=http://localhost:3300 node scripts/selftest.js          # bash
$env:TARGET='http://localhost:3300'; node scripts/selftest.js  # PowerShell
```

The image is `node:22-alpine`-based (~230 MB), runs as the non-root `node` user, and has a built-in `HEALTHCHECK` against `/api/state`.

## What it simulates

- **EKS control plane** (apiserver, etcd, scheduler, controllers) + managed node group of EC2 worker nodes with realistic *allocatable* capacity (system-reserved + `aws-node`/`kube-proxy` DaemonSet overhead subtracted)
- **Pod lifecycle**: Pending → ContainerCreating → Running → Terminating, with scheduling by resource *requests* (bin-packing), readiness/startup delay, FailedScheduling events
- **Horizontal Pod Autoscaler**: real formula `desired = ceil(current × actual/target)` with 10% tolerance, scale-up cooldown and scale-down stabilization window
- **Cluster Autoscaler**: scales up on unschedulable pods, scales down underutilized nodes (only after checking their pods fit elsewhere), with cordon/drain/evict
- **Load generation**: steady req/s, one-off bursts of API calls, spikes, ramps, sine waves — split across deployments by traffic weight
- **Failure modes**: CPU throttling at the limit (latency/p99 rises, requests shed), OOMKilled when memory limit is breached (restarts + events)
- **Observability**: kubectl-style event stream, per-pod application logs, **control-plane process logs** (kube-apiserver, etcd, kube-scheduler, controller-manager, HPA controller, cluster-autoscaler — click any process chip in the topology), live charts (rps/errors, CPU vs target, replicas, nodes), cost tracking ($0.10/hr control plane + EC2 pricing)
- **Chaos**: kill a specific pod (💀 button in its logs view) or a random one (Chaos panel) and watch self-healing — survivors absorb the traffic, the ReplicaSet recreates the pod, and the HPA reacts if survivors overload

## UI guide

| Area | What it does |
|---|---|
| Left column | Configure node group, deployments + HPA, and the load generator. Every field has a tooltip and a `?` that opens a full explanation. |
| Center | Stat cards, four live charts, and the cluster topology (nodes with their pods; click a pod to view its logs). A 💡 banner explains autoscaling events as they happen. |
| Right column | **Events** (kubectl-style), **Pod Logs**, and **Learn** — attribute reference, core concepts, and 12 interview Q&As. |
| Top bar | Sim speed (pause/1×/2×/5×/10×), +60s fast-forward, accumulated cost, reset. |

## Things to try (interview scenarios)

1. **Spike +400** — watch HPA scale up fast, then scale down slowly (stabilization window) after it ends.
2. **Raise CPU request to 600m and crank load** — pods stop fitting on nodes, go Pending, Cluster Autoscaler launches instances (watch the boot delay!).
3. **Set max nodes low, then overload** — pods stuck Pending at capacity, with FailedScheduling warnings.
4. **Set memory limit below the request** — OOMKilled events and restart counters.
5. **Wave ±300** — full scale-up/scale-down cycles; compare the square-wave traffic to the staircase replica chart.
6. **Halve a CPU request** — the same load now reads as double the utilization %, scaling out earlier (HPA % is measured against the *request*).
7. **Kill a pod under load** (Chaos panel) — survivor CPU spikes while the ReplicaSet's replacement boots; with enough headroom users see nothing, without it the HPA kicks in.
8. **Click the control-plane chips** — read the scheduler binding pods, the HPA controller's 15-second evaluations, and the cluster-autoscaler's scan decisions as they happen.

## API

```
GET    /api/state                  full simulator state
GET    /api/events                 event stream
GET    /api/pods/:name/logs        per-pod logs
GET    /api/components/:name/logs  control-plane process logs (kube-apiserver, etcd, kube-scheduler, kube-controller-manager, hpa-controller, cluster-autoscaler)
POST   /api/pods/:name/kill        kill a specific pod (kubectl delete pod)
POST   /api/chaos/kill-random-pod  kill a random running pod
POST   /api/reset                  reset to defaults
PUT    /api/cluster                { name, region, version }
PUT    /api/nodegroup              { instanceType, minNodes, maxNodes, scaleDownUtilizationThreshold, scaleDownDelaySeconds, nodeBootSeconds }
POST   /api/deployments            create (spec below)
PUT    /api/deployments/:name      update (resource changes trigger a rolling update)
DELETE /api/deployments/:name      delete
POST   /api/load                   { baseRps, pattern: steady|wave, waveAmplitude, wavePeriodSeconds }
POST   /api/load/burst             { requests }            one-off burst of API calls
POST   /api/load/spike             { magnitude, durationSeconds }
POST   /api/load/ramp              { to, durationSeconds }
POST   /api/speed                  { speed: 0..60 }        0 pauses
POST   /api/advance                { seconds }             fast-forward deterministically
```

Deployment spec:

```json
{
  "name": "web-api", "replicas": 2, "trafficWeight": 1,
  "cpuRequest": 250, "cpuLimit": 500, "memRequest": 256, "memLimit": 512,
  "baseCpu": 30, "cpuPerRequest": 4, "startupSeconds": 8,
  "hpa": {
    "enabled": true, "minReplicas": 2, "maxReplicas": 10,
    "targetCPUUtilization": 60,
    "scaleUpCooldownSeconds": 15, "scaleDownStabilizationSeconds": 60
  }
}
```

## Project layout

```
server.js            HTTP server + JSON API (no dependencies)
src/engine.js        simulation engine (cluster, nodes, pods, HPA, CA, load, logs)
public/              dashboard UI (vanilla JS, hand-rolled charts)
public/learn.js      attribute reference, concepts, interview Q&A content
scripts/selftest.js  end-to-end test suite (boots the server, drives the API)
```
