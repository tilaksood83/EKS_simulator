# Fun While Learning — Distributed-System Simulators

**Live site: [https://learnwithts.in](https://learnwithts.in)** · built by **Tilak Sood**

Hands-on, zero-dependency simulators for the systems you usually only read about — break them, watch them heal, understand them. Everything is plain Node.js + vanilla JS: no frameworks, no `npm install`.

## The playgrounds

| Path | What it is |
|---|---|
| [`/shared/`](https://learnwithts.in/shared/) | 🌍 **Shared EKS Cluster** — one live Kubernetes simulation for everyone on the internet, served by the backend. Kill a pod and the whole world sees it die. |
| [`/solo/`](https://learnwithts.in/solo/) | 🧍 **Solo Sandbox** — the same EKS simulation running 100% in your browser. Private, unbreakable-by-strangers, works offline. |
| [`/incident/`](https://learnwithts.in/incident/) | 🚨 **Incident Room** — a hidden fault is injected into a cluster and users are complaining. Diagnose the root cause from events, logs and charts, apply the fix, watch it heal. Tracks your streak. |
| [`/kafka/`](https://learnwithts.in/kafka/) | 📨 **Kafka Lag Lab** — partitions, consumer groups, rebalancing pauses, key skew and broker failure with leader election. Watch consumer lag physics in real time. |
| [`/resilience/`](https://learnwithts.in/resilience/) | 🌩 **Retry Storm** — a client→web→api→db chain where naive retries turn a slow database into a self-inflicted outage. Tune timeouts, backoff and circuit breakers to survive. |

The Incident Room, Kafka Lag Lab and Retry Storm run entirely in the browser — only the Shared Cluster talks to the server.

## Run it yourself

```bash
node server.js          # http://localhost:3000
node server.js 8080     # custom port (or PORT env var)
node scripts/selftest.js  # 75-check end-to-end test suite
```

No `npm install` needed — uses only Node built-ins (Node ≥ 18).

### Docker

```bash
docker run -d -p 3000:3000 tilak83docker/eks_simulator   # straight from Docker Hub
# or build locally:
docker build -t eks-simulator .
docker run -d --name eks-simulator -p 3300:3000 eks-simulator

# run the full test suite against the container
TARGET=http://localhost:3300 node scripts/selftest.js          # bash
$env:TARGET='http://localhost:3300'; node scripts/selftest.js  # PowerShell
```

The image is `node:22-alpine`-based (~230 MB), runs as the non-root `node` user, and has a built-in `HEALTHCHECK` against `/api/state`.

## What the EKS simulation models

> traffic ↑ → pod CPU ↑ → **HPA** adds pods → pods don't fit → Pending → **Cluster Autoscaler** adds EC2 nodes → nodes boot → pods schedule → utilization normalizes

- **EKS control plane** (apiserver, etcd, scheduler, controllers) + managed node group of EC2 worker nodes with realistic *allocatable* capacity (system-reserved + `aws-node`/`kube-proxy` DaemonSet overhead subtracted)
- **Pod lifecycle**: Pending → ContainerCreating → Running → Terminating, with scheduling by resource *requests* (bin-packing), readiness/startup delay, FailedScheduling events
- **Horizontal Pod Autoscaler**: real formula `desired = ceil(current × actual/target)` with 10% tolerance, scale-up cooldown and scale-down stabilization window
- **Cluster Autoscaler**: scales up on unschedulable pods, scales down underutilized nodes (only after checking their pods fit elsewhere), with cordon/drain/evict
- **Load generation**: steady req/s, one-off bursts, spikes, ramps, sine waves — split across deployments by traffic weight
- **Failure modes**: CPU throttling at the limit (latency/p99 rises, requests shed), OOMKilled when memory limit is breached (restarts + events)
- **Observability**: kubectl-style event stream, per-pod logs, control-plane process logs (click any process chip in the topology), live charts, cost tracking
- **Chaos**: kill a specific pod or a random one and watch self-healing — survivors absorb the traffic, the ReplicaSet recreates the pod, the HPA reacts

## Things to try

1. **Spike +400** — watch HPA scale up fast, then scale down slowly (stabilization window) after it ends.
2. **Raise CPU request to 600m and crank load** — pods stop fitting, go Pending, Cluster Autoscaler launches instances (watch the boot delay!).
3. **Set max nodes low, then overload** — pods stuck Pending at capacity with FailedScheduling warnings.
4. **Set memory limit below the request** — OOMKilled events and restart counters.
5. **Kill a pod under load** — survivor CPU spikes while the replacement boots.
6. **In Kafka**: set key skew to 70% and watch one partition drown while adding consumers does nothing.
7. **In Resilience**: 600 req/s + 3 retries with no backoff + a slow DB = a textbook retry storm. Then enable the circuit breaker and watch it self-heal.
8. **In the Incident Room**: build a diagnosis streak without using Reveal.

## API (shared EKS simulation)

```
GET    /api/state                  full simulator state
GET    /api/events                 event stream
GET    /api/pods/:name/logs        per-pod logs
GET    /api/components/:name/logs  control-plane process logs
POST   /api/pods/:name/kill        kill a specific pod (kubectl delete pod)
POST   /api/chaos/kill-random-pod  kill a random running pod
POST   /api/reset                  reset to defaults
PUT    /api/cluster                { name, region, version }
PUT    /api/nodegroup              { instanceType, minNodes, maxNodes, scaleDownUtilizationThreshold, scaleDownDelaySeconds, nodeBootSeconds }
POST   /api/deployments            create
PUT    /api/deployments/:name      update (resource changes trigger a rolling update)
DELETE /api/deployments/:name      delete
POST   /api/load                   { baseRps, pattern: steady|wave, waveAmplitude, wavePeriodSeconds }
POST   /api/load/burst             { requests }
POST   /api/load/spike             { magnitude, durationSeconds }
POST   /api/load/ramp              { to, durationSeconds }
POST   /api/speed                  { speed: 0..60 }   0 pauses
POST   /api/advance                { seconds }        fast-forward deterministically
```

The solo/incident pages reuse this exact API surface via a `fetch` shim that routes calls to an in-browser engine instead of the network.

## Project layout

```
server.js               HTTP server + JSON API (no dependencies)
src/engine.js           EKS simulation engine (dual Node/browser export)
public/index.html       landing page
public/shared/          server-backed EKS dashboard
public/solo/            in-browser EKS dashboard (fetch shim + same UI)
public/incident/        diagnosis game on top of the solo machinery
public/kafka/           Kafka lag simulator (own engine, browser-only)
public/resilience/      retry-storm simulator (own engine, browser-only)
public/learn.js         attribute reference, concepts and practice Q&A
scripts/selftest.js     end-to-end test suite (boots the server, drives the API)
```

## Author

Built by **Tilak Sood** as a personal learning project — hosted on a shoestring ☕.
[GitHub](https://github.com/tilaksood83/EKS_simulator) · [Docker Hub](https://hub.docker.com/repository/docker/tilak83docker/eks_simulator)
