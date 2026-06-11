'use strict';

/* Learning content: every simulator attribute explained, core concepts,
 * and common interview questions. Rendered into the Learn tab by app.js. */

const LEARN_ATTRIBUTES = {
  nodegroup: {
    title: 'Managed Node Group',
    body: 'A set of EC2 instances that join the cluster as worker nodes. EKS manages their lifecycle through an EC2 Auto Scaling Group. The Cluster Autoscaler resizes the group between <code>min</code> and <code>max</code>. Alternatives on EKS: Fargate (serverless pods) and Karpenter (just-in-time, right-sized nodes).',
  },
  instanceType: {
    title: 'Instance type',
    body: 'Determines each node\'s CPU/memory capacity and hourly price. Note: a node\'s <b>allocatable</b> resources are less than its capacity — the kubelet reserves CPU/memory for the system, and DaemonSets like <code>aws-node</code> (VPC CNI) and <code>kube-proxy</code> run on every node. The simulator models this: a t3.medium (2 vCPU) has ~1785m allocatable for your pods.',
  },
  minNodes: { title: 'Min nodes', body: 'Floor for the Cluster Autoscaler. Keeps baseline capacity for sudden traffic so you don\'t cold-start everything. Trade-off: you pay for these nodes 24/7.' },
  maxNodes: { title: 'Max nodes', body: 'Ceiling for the Cluster Autoscaler — your cost guardrail. If pods still don\'t fit at max, they stay <b>Pending</b> with <code>FailedScheduling</code> events. Try it: set max low and crank the load.' },
  scaleDownUtilizationThreshold: {
    title: 'Scale-down utilization threshold',
    body: 'A node is a removal candidate when the sum of its pods\' <b>requests</b> (not actual usage!) is below this fraction of allocatable. Default 0.5 in the real Cluster Autoscaler. CA also checks that every pod on the node fits elsewhere before draining.',
  },
  scaleDownDelaySeconds: { title: 'Scale-down delay', body: 'How long a node must stay underutilized before removal (real CA default: 10 minutes via <code>--scale-down-unneeded-time</code>). Prevents removing a node right before the next traffic wave.' },
  nodeBootSeconds: { title: 'Node boot time', body: 'EC2 launch + OS boot + kubelet join + Ready. Realistically 1–3 minutes — this is why <b>node scale-up is much slower than pod scale-up</b>, and why HPA + CA together still can\'t absorb an instant spike without headroom. Karpenter reduces but doesn\'t eliminate this.' },
  deployment: {
    title: 'Deployment',
    body: 'Declares the desired state for a set of identical pods: image, replica count, resources. The Deployment controller manages ReplicaSets, which create the actual pods. Changing the pod template triggers a <b>rolling update</b> (new ReplicaSet hash — watch pod names change in the simulator).',
  },
  replicas: { title: 'Replicas', body: 'How many identical pods run. With HPA enabled, the HPA owns this number — manually setting it gets overridden on the next HPA evaluation (a classic gotcha: don\'t set <code>replicas</code> in a manifest you apply via GitOps if an HPA manages it).' },
  trafficWeight: { title: 'Traffic weight', body: 'Simulator-specific: relative share of total incoming requests this deployment\'s Service receives. With weights 3 and 1, the first deployment gets 75% of traffic.' },
  cpuRequest: {
    title: 'CPU request',
    body: 'The amount the <b>scheduler reserves</b> on a node for the pod (1000m = 1 vCPU). Two huge consequences: (1) bin-packing — requests determine how many pods fit per node and hence when the Cluster Autoscaler must add nodes; (2) <b>HPA utilization is a percentage of the request</b>. Same usage with a smaller request = higher %, earlier scale-out.',
  },
  cpuLimit: { title: 'CPU limit', body: 'Hard cap enforced by the kernel CFS quota. Exceeding it doesn\'t kill the pod — it gets <b>throttled</b>: latency climbs and throughput flattens. In the simulator, throttled pods turn red and shed requests. Many production teams set CPU requests but no CPU limits to avoid throttling.' },
  memRequest: { title: 'Memory request', body: 'Reserved memory used for scheduling decisions, in MiB. Like CPU requests, it drives bin-packing and Cluster Autoscaler behavior.' },
  memLimit: { title: 'Memory limit', body: 'Hard cap. Unlike CPU, memory is <b>not compressible</b>: exceeding the limit gets the container <b>OOMKilled</b> and restarted (watch for restart counts and <code>OOMKilled</code> events). Try setting the limit below the request to see it happen.' },
  baseCpu: { title: 'Idle CPU', body: 'Simulator-specific: CPU the app consumes with zero traffic (runtime, GC, health checks). Affects how low utilization can go, and therefore how far the HPA scales down.' },
  cpuPerRequest: { title: 'CPU per req/s', body: 'Simulator-specific: marginal CPU cost of traffic, in millicores per 1 req/s. Pod capacity ≈ (cpuLimit − idleCpu) / cpuPerRequest req/s. Raise it to simulate a heavy endpoint that saturates quickly.' },
  startupSeconds: { title: 'Startup time', body: 'Time from scheduling to passing the <b>readiness probe</b>. Until then the pod is not in the Service endpoints and gets no traffic. Long startups make autoscaling laggy — the reason slow-starting JVM apps need generous HPA headroom or predictive scaling.' },
  hpa: {
    title: 'Horizontal Pod Autoscaler (HPA)',
    body: 'Control loop (every 15s in real k8s) that resizes a Deployment based on observed metrics from the <code>metrics-server</code>. The formula: <code>desired = ceil(current × actualUtil / targetUtil)</code>, with a ±10% tolerance band to avoid micro-adjustments. Scale-up is fast; scale-down is deliberately slow (stabilization window).',
  },
  minReplicas: { title: 'HPA min replicas', body: 'Floor for the HPA. Keep ≥2 for availability (survive a node failure / rolling update).' },
  maxReplicas: { title: 'HPA max replicas', body: 'Ceiling for the HPA. When pinned at max with utilization still above target, you\'re under-provisioned — that\'s when you raise max, optimize the app, or scale vertically.' },
  targetCPUUtilization: { title: 'Target CPU utilization', body: 'The average CPU (as % of <b>request</b>) the HPA tries to maintain. Lower target = more headroom for spikes but more idle cost. 50–70% is a common production range. The simulator draws this as the gray line on the CPU chart.' },
  scaleUpCooldownSeconds: { title: 'Scale-up cooldown', body: 'Minimum gap between scale-up events so the HPA reacts to fresh metrics from the new pods rather than stale ones. Real HPA uses scaling policies (e.g. "max 100% increase per 15s").' },
  scaleDownStabilizationSeconds: { title: 'Scale-down stabilization', body: 'The HPA looks back over this window and uses the <b>highest</b> desired replica count seen. Result: instant scale-up, slow scale-down — preventing "flapping" when traffic oscillates. Real default: 300s. Watch the replica chart: square wave up, staircase down.' },
  load: { title: 'Load generator', body: 'Simulates clients calling your API. Steady rate, one-off bursts, spikes, ramps and sine waves. Requests are split across deployments by traffic weight, then evenly across that deployment\'s <b>Running</b> pods (like a Service with round-robin endpoints).' },
  chaos: {
    title: 'Chaos: killing pods',
    body: 'Simulates <code>kubectl delete pod</code> (or a crash, or chaos engineering tools like Chaos Monkey / Litmus). The pod gets SIGTERM and drains; the <b>ReplicaSet controller</b> notices actual replicas &lt; desired and immediately creates a replacement — this is Kubernetes <b>self-healing</b> via reconciliation. Impact while the replacement starts: traffic redistributes to the survivors, their CPU jumps (watch for throttling/errors if they were already near the limit), and once the new pod passes readiness, load rebalances. Lesson: with replicas=1 a pod kill is a brief outage; with N≥2 it\'s invisible to users — if there\'s headroom.',
  },
};

const LEARN_CONCEPTS = [
  {
    q: 'The two layers of autoscaling (the core of this simulator)',
    a: '<b>Layer 1 — HPA</b> adds/removes <i>pods</i> based on metrics (CPU % of request here). <b>Layer 2 — Cluster Autoscaler</b> adds/removes <i>nodes</i>: it scales up when pods are <b>Pending/unschedulable</b> (not when CPU is high!), and scales down when a node\'s requested resources stay under a threshold and its pods fit elsewhere. The chain under load: traffic ↑ → CPU ↑ → HPA adds pods → pods don\'t fit → Pending → CA adds a node → node boots (~minutes) → pods schedule → utilization normalizes.',
  },
  {
    q: 'Pod lifecycle (watch the chip colors)',
    a: '<span style="color:#e8c94d">■ Pending</span> — accepted but not scheduled (often: insufficient resources). <span style="color:#6ca0f6">■ ContainerCreating</span> — scheduled; pulling image, starting, waiting for readiness probe. <span style="color:#4cc38a">■ Running</span> — ready, receiving traffic. <span style="color:#e05c5c">■ Terminating</span> — got SIGTERM, draining connections within the grace period (default 30s real-world).',
  },
  {
    q: 'Requests vs limits — the #1 interview topic',
    a: '<b>Request</b> = scheduler reservation (drives bin-packing, CA decisions, and the denominator of HPA %). <b>Limit</b> = runtime cap (CPU → throttled, memory → OOMKilled). Request &lt; usage &lt; limit is normal (bursting). QoS classes: requests==limits → <code>Guaranteed</code>; some set → <code>Burstable</code>; none → <code>BestEffort</code> (evicted first under node pressure).',
  },
  {
    q: 'What is EKS exactly?',
    a: 'A managed Kubernetes <b>control plane</b>: AWS runs the apiserver, etcd, scheduler and controllers across 3 AZs ($0.10/hr) — you can\'t SSH into them. You bring <b>data plane</b>: managed node groups (EC2), Fargate (serverless pods), or Karpenter-provisioned nodes. AWS integrations: IAM for auth (IRSA / Pod Identity for pod-level AWS permissions), VPC CNI gives pods real VPC IPs, ELB for Services/Ingress, EBS/EFS CSI for storage.',
  },
  {
    q: 'Why is allocatable < node capacity?',
    a: 'kubelet subtracts <code>kube-reserved</code> + <code>system-reserved</code> + eviction thresholds. Then DaemonSets (<code>aws-node</code>, <code>kube-proxy</code>, monitoring agents) consume requests on <b>every</b> node. On small instances this overhead is a large fraction — one reason fewer/bigger nodes can be more efficient than many small ones.',
  },
  {
    q: 'Why scale-down is deliberately slow everywhere',
    a: 'Scaling up too late loses requests; scaling down too eagerly causes flapping (scale down → spike → cold start → errors). So both autoscalers are asymmetric: HPA uses a stabilization window (max desired over last N seconds); CA waits <code>scale-down-unneeded-time</code> and verifies pods fit elsewhere. Adding capacity is cheap; removing it wrongly is expensive.',
  },
  {
    q: 'CPU throttling vs OOMKill',
    a: 'CPU is <b>compressible</b>: hitting the limit just slows you down (CFS throttling → latency spikes — watch p99 in the simulator when pods turn red). Memory is <b>incompressible</b>: hitting the limit kills the container (OOMKilled, exit 137) and kubelet restarts it with exponential backoff (CrashLoopBackOff if it keeps dying).',
  },
  {
    q: 'Beyond CPU-based HPA',
    a: 'Real systems often scale on better signals: memory, requests-per-second per pod, queue depth (KEDA for event-driven workloads on SQS/Kafka), or custom/external metrics via the metrics adapter APIs. CPU is the default because it\'s free, but it\'s a lagging proxy — RPS or queue depth react faster.',
  },
];

const INTERVIEW_QA = [
  {
    q: 'Walk me through what happens when traffic to your EKS service triples.',
    a: 'Pods\' CPU rises above the HPA target → HPA computes <code>desired = ceil(current × actual/target)</code> and scales the Deployment → new pods are created; if nodes have room they schedule and become Ready after startup/readiness; if not, they sit Pending → Cluster Autoscaler sees unschedulable pods and grows the node group ASG → ~1–3 min later nodes join, Pending pods schedule → load per pod drops back near target. Meanwhile existing pods may throttle at their CPU limit, so p99 latency rises until capacity catches up. <i>(Reproduce in the simulator: press "Spike +400".)</i>',
  },
  {
    q: 'A pod is stuck in Pending. How do you debug it?',
    a: '<code>kubectl describe pod</code> → look at Events. Most common: <code>FailedScheduling: insufficient cpu/memory</code> (requests don\'t fit any node — check CA logs/limits), unsatisfiable nodeSelector/affinity, taints without tolerations, PVC unbound, or node group at max. In this simulator: set node group max low, crank load, and watch the Pending row + FailedScheduling events.',
  },
  {
    q: 'HPA isn\'t scaling even though CPU looks high. Why might that be?',
    a: 'Classic causes: (1) metrics-server missing/broken — HPA shows <code>&lt;unknown&gt;</code>; (2) pods have <b>no CPU request</b>, so utilization % is undefined; (3) already at maxReplicas; (4) utilization is within the 10% tolerance band; (5) you\'re looking at usage vs <b>limit</b>, but HPA measures vs <b>request</b>; (6) scale-up policy/cooldown still in effect.',
  },
  {
    q: 'What\'s the difference between the Cluster Autoscaler and Karpenter?',
    a: 'CA works through <b>pre-defined node groups</b> (ASGs): it can only add instances of the group\'s fixed type, evaluates group-by-group, and is relatively slow. <b>Karpenter</b> provisions individual right-sized EC2 instances directly from the pending pods\' aggregate requirements (any instance type, Spot-aware, bin-packing + consolidation), typically much faster and cheaper. Karpenter is now the AWS-recommended default for new clusters.',
  },
  {
    q: 'How do pods on EKS get AWS permissions (e.g. to read S3)?',
    a: 'Never node instance roles (every pod would share them). Use <b>IRSA</b> (IAM Roles for Service Accounts): the cluster\'s OIDC provider lets a pod\'s projected service-account token be exchanged via <code>sts:AssumeRoleWithWebIdentity</code> for role credentials. Newer alternative: <b>EKS Pod Identity</b> — same goal, simpler setup via an EKS API association instead of OIDC trust policies.',
  },
  {
    q: 'Deployment vs StatefulSet vs DaemonSet?',
    a: '<b>Deployment</b>: stateless, interchangeable replicas (this simulator). <b>StatefulSet</b>: stable identity — ordered pod names (db-0, db-1), stable network IDs, per-pod PVCs; for databases/quorum systems. <b>DaemonSet</b>: exactly one pod per node — agents like <code>aws-node</code>, <code>kube-proxy</code>, log shippers (shown as gray chips on every simulated node).',
  },
  {
    q: 'What happens during a node scale-down? Can it break my app?',
    a: 'CA cordons the node (no new pods), then drains it — evicting pods, which reschedule elsewhere. It can hurt if: replicas=1 (brief outage), no PodDisruptionBudget (too many replicas evicted at once), or pods can\'t fit elsewhere. Protections: PDBs, multiple replicas spread via topologySpreadConstraints, <code>safe-to-evict=false</code> annotation for un-movable pods. The simulator shows Evicted events and pods flowing back through Pending when a node drains.',
  },
  {
    q: 'How would you size CPU requests for a service?',
    a: 'Measure real usage (e.g. p95 of <code>container_cpu_usage</code> over a week), set the request near typical-busy usage so HPA % is meaningful, and target utilization 50–70%. Too-high requests waste nodes (CA can\'t pack pods); too-low requests cause noisy-neighbor contention and misleadingly high HPA percentages. VPA in recommendation mode is a good data source. You can demo the effect here: halve the CPU request and watch the same load double the utilization % and trigger earlier scale-out.',
  },
  {
    q: 'Service vs Ingress on EKS?',
    a: '<b>Service</b>: stable virtual IP + load-balancing across pod endpoints — <code>ClusterIP</code> (internal), <code>NodePort</code>, <code>LoadBalancer</code> (provisions an NLB/CLB). <b>Ingress</b>: L7 HTTP routing (host/path) — on EKS the AWS Load Balancer Controller turns Ingress resources into an ALB. Pods get traffic only after passing readiness probes — exactly why new pods in the simulator wait through "startup time" before taking load.',
  },
  {
    q: 'Your container keeps restarting with exit code 137. What\'s going on?',
    a: '137 = 128 + SIGKILL(9) → almost always <b>OOMKilled</b>: memory usage exceeded the limit. Confirm via <code>kubectl describe pod</code> (Last State: OOMKilled) or node events. Fix: raise the memory limit, fix the leak, or tune heap flags (JVM inside containers!). Repeated fast restarts become <code>CrashLoopBackOff</code> with exponential backoff. Try it here: set a deployment\'s memory limit below its request and watch the OOMKilled events and restart counters.',
  },
  {
    q: 'How do you make autoscaling handle a sudden 10× spike?',
    a: 'Pure reactive autoscaling can\'t beat physics (metrics lag + pod startup + node boot). Strategies: overprovision headroom (lower HPA target, min replicas higher, "pause pods" / priority-based balloon pods that get preempted to free instant capacity), faster nodes (Karpenter, pre-pulled images, smaller images), faster pod start (readiness tuning), scale on a leading indicator (RPS/queue depth via KEDA instead of CPU), or scheduled scaling before known peaks.',
  },
  {
    q: 'What happens — step by step — when you kubectl delete a pod owned by a Deployment?',
    a: 'apiserver marks the pod for deletion (grace period, default 30s) → kubelet sends <b>SIGTERM</b>; the endpoint is removed from the Service so no new traffic arrives → app drains in-flight requests (SIGKILL after the grace period if it won\'t exit) → meanwhile the <b>ReplicaSet controller</b> sees observed replicas &lt; desired and creates a replacement pod, which gets scheduled and must pass readiness before serving. Users notice nothing if replicas ≥ 2 with headroom. Try it: the 💀 buttons in this simulator do exactly this — watch the survivors\' CPU and the controller-manager logs.',
  },
  {
    q: 'kube-proxy vs VPC CNI (aws-node) — what do they each do?',
    a: '<code>aws-node</code> (VPC CNI) assigns each pod a real VPC IP from the subnet via ENIs — pods are first-class network citizens, but IP exhaustion becomes a real capacity limit (mitigations: prefix delegation, secondary CIDRs). <code>kube-proxy</code> programs iptables/IPVS rules so Service ClusterIPs route to healthy pod endpoints. Both run as DaemonSets on every node — the per-node overhead this simulator subtracts from allocatable.',
  },
];

// Contextual explainers shown above the topology when interesting events fire.
const EVENT_EXPLAINERS = {
  PodDeleted: () =>
    `<b>Pod killed.</b> The Deployment's desired state says N replicas, but the ReplicaSet controller now observes N−1 — so it creates a replacement immediately (reconciliation = self-healing). Until the new pod passes readiness, the survivors absorb its traffic share: watch their CPU % jump, and p99/errors if they were near the limit.`,
  SuccessfulRescale: rec => rec.message.includes('above')
    ? `<b>HPA scaled UP.</b> Average CPU exceeded the target (measured against the pods' CPU <i>request</i>), so the HPA raised the replica count: desired = ceil(current × actual/target). New pods must schedule and pass readiness before they absorb load.`
    : `<b>HPA scaled DOWN.</b> Utilization stayed below target for the whole stabilization window (the HPA uses the <i>highest</i> desired count seen in the window), so it's now safe to drop replicas without risking flap.`,
  TriggeredScaleUp: () =>
    `<b>Cluster Autoscaler scaled UP.</b> Pods were unschedulable (Pending — no node had enough free <i>requested</i> CPU/memory), so the autoscaler is launching new EC2 instances. Note the delay: instances must boot and join before Pending pods can schedule.`,
  ScaleDown: () =>
    `<b>Cluster Autoscaler scaling DOWN.</b> A node's requested resources stayed below the utilization threshold and all its pods fit elsewhere — so it's cordoned, drained (pods evicted and rescheduled), and the EC2 instance is terminated to save cost.`,
  FailedScheduling: () =>
    `<b>Pod unschedulable.</b> No node has enough free capacity for this pod's resource requests. If the node group isn't at max, the Cluster Autoscaler will fix this by adding a node; if it IS at max, the pod stays Pending — raise max nodes or shrink requests.`,
  OOMKilled: () =>
    `<b>OOMKilled.</b> A container exceeded its memory limit. Memory is incompressible — unlike CPU (which just throttles), breaching a memory limit kills the container (exit 137) and the kubelet restarts it.`,
};
