# Load-test plan: HPA under burst

This is both the write-up for Task 5 (metrics-server + k6 + HPA scale-up demo)
and the standalone "load-test plan" bonus deliverable: what we tested, how,
what we saw, and what a real production test would add on top.

## 1. Traffic model: three shapes, three different costs

A LiveView app doesn't have one "load" profile - it has (at least) three, and
they stress completely different parts of the system. This matters because
the HPA only has one signal (CPU), and the point of this exercise is to show
where that signal is a good proxy for load and where it isn't.

| Shape | What happens | What it costs | CPU-visible? |
|---|---|---|---|
| **Connect-storm** | Many clients mount within a short window: HTTP dead-render (`GET /clock` - Plug pipeline, template render, session-cookie signing, CSRF token generation), then a WS upgrade (Cowboy handshake). | CPU + a burst of process spawns. Cost scales with **arrival rate**, not standing population. | **Yes** - this is the one that moves the HPA. |
| **Held-connections** | A large population of already-connected sockets doing nothing but a 30s heartbeat. | Memory (one lightweight Erlang process per socket, small heap) and scheduler wakeups every heartbeat. Cost scales with **population size**, not activity. | **No** (or barely) - this is the gap CPU-based HPA doesn't see. |
| **Interaction load** | A client is actually inside a joined LiveView (`phx_join`'d to an `lv:*` topic) and either the user is clicking/typing (`phx-click`, `phx-change`, form submits) or the view pushes itself on a timer - e.g. `ClockLive` calls `Process.send_after(self(), :tick, 1000)` on connected mount and re-renders every second for as long as that view stays joined. | CPU, proportional to `(joined LiveViews) x (event/tick rate) x (render+diff cost)`. This is where the *application's own logic* runs repeatedly, not just transport plumbing. | **Yes, and it's the most direct proxy for "real" per-user cost** - but it's also invisible in a raw socket/connection count, which is why a mailbox-depth or per-view render-rate metric (see §6) is the more honest signal for this category specifically. |

`loadtest/hold-and-burst.js` deliberately drives only the first two shapes.
See "Deliberate scope choice" in the script's header comment: it opens the
Phoenix socket **transport** (`/live/websocket?vsn=2.0.0`) and keeps it alive
with heartbeats, but never sends a `phx_join`. Joining would mean replaying
the CSRF/session handshake `phoenix_live_view`'s JS client performs on mount
*and* it would start a real `ClockLive` process that ticks every second -
which would quietly turn the "held connections" arm of the test into
interaction load and contaminate the exact comparison this test exists to
make (§5). A transport-only hold isolates "socket exists, memory is spent,
CPU is not" cleanly.

## 2. What we ran locally

**metrics-server**: applied upstream `components.yaml`, patched
`deploy/metrics-server` in `kube-system` with `--kubelet-insecure-tls`
(kind's kubelet serving certs aren't signed for the kubelet's real IP, which
the stock metrics-server rejects). Confirmed via `kubectl top nodes` /
`kubectl top pods -n demo` returning real numbers and `kubectl -n demo get
hpa demo` moving from `<unknown>/65%` to a real `NN%/65%`. Full numbers in
the Task 5 report.

**Script**: `loadtest/hold-and-burst.js` runs **two scenarios concurrently**,
not one - this is the one substantive deviation from the brief's sketch, and
it's evidence-driven, not stylistic. Everything else (frame format, heartbeat
shape, `/clock` + `/live/websocket` paths, `__ENV.TARGET`) matches the brief.

**How we got there.** We first implemented the brief's script exactly as
given: one `ramping-vus` scenario per iteration doing `GET /clock`, open
`/live/websocket?vsn=2.0.0`, heartbeat every 30s, hold ~2 minutes, `sleep(1)`,
repeat, with VU counts scaled down from the brief's 50/400 (`WARM_VUS=15 ->
PEAK_VUS=100` over a 10s ramp, 90s hold - see §6 for why this host needs
smaller numbers). We ran it in-cluster exactly as described below. Result:
over the full ~2.5-minute run it produced **112 HTTP requests and 112 ws
upgrades total (~0.75 req/s)**, and CPU never left baseline the entire time -
confirmed with a `kubectl top pods` sample every 5s for the full run (0-1%
HPA utilization throughout, pod CPU steady at 3-7m against a 500m request).

That's not a failure of the test - it's the **same result this script is
built to demonstrate** ("held connections are CPU-cheap"), just applied
accidentally to the *whole* run instead of being contrasted against a real
burst. The brief's per-iteration shape (one HTTP request, one WS upgrade,
then a 2-minute hold) is structurally a *low request-rate* pattern: the
*population* of concurrent sockets can be large, but the *arrival rate* of
new mounts - the thing that actually costs CPU - is capped at roughly
`(peak VUs) / (ramp seconds)`, which for any VU count this host can hold
concurrently is nowhere near enough. We confirmed the app and cluster *can*
produce a real spike with a separate tight-loop calibration (plain
`GET /clock`, 50 VUs, no think time, connection reuse): **~10.6k req/s**,
which pushed **measured CPU to 257% of the HPA target** (1078m + 1497m
against a 500m x 2 request) and, left to run, triggered a real
`SuccessfulRescale` to 6 replicas in one step (§3 has the numbers - that
event is included as supporting evidence even though it came from a
calibration run, not the committed script, because it's a real, clean,
useful data point we'd otherwise have thrown away).

So the committed script splits the brief's one iteration into two scenarios
that each do one job well:

- **`held`** - the brief's original per-iteration shape, unchanged: mount
  once, open the socket, heartbeat, hold. Proven CPU-cheap at 100 concurrent
  VUs sustained for 90s (§4). This is the standing "idle sockets" population.
- **`storm`** - a new scenario, layered on top via `startTime`, whose whole
  job is to reproduce the calibration's tight-loop spike on purpose: mount,
  close as soon as the WS upgrade completes, repeat, no think time. Short
  (30s total: 8s ramp, 15s hold, 7s ramp-down) and VU count calibrated down
  from the 50 that produced 257% (see §3 for the numbers we landed on and
  why) so the resulting scale-up is a controlled, single clean step rather
  than another race toward `maxReplicas`. One implementation gotcha worth
  flagging: `ws.connect()` blocks the calling VU until the socket closes, so
  an early version that closed the socket via `setTimeout(..., 500)` was
  accidentally rate-limited to ~2 iterations/sec/VU by the timer itself, not
  by the server - 32 such VUs topped out at ~31 req/s and never troubled the
  HPA. Closing synchronously as soon as `open` fires (the committed
  behavior, `STORM_SOCKET_HOLD_MS=0`) removes that artificial ceiling.

All stage/VU values for both scenarios are overridable via env vars
(`HELD_VUS`, `WARM_TIME`, `HOLD_TIME`, `DOWN_TIME`, `SOCKET_HOLD_MS`,
`HEARTBEAT_MS`, `STORM_VUS`, `STORM_START`, `STORM_RAMP`, `STORM_HOLD`,
`STORM_RAMPDOWN`, `STORM_SOCKET_HOLD_MS`) so the same script scales up on
real hardware without editing code. `gracefulRampDown`/`gracefulStop` are set
short (5-10s) on both scenarios so the test's wall-clock duration is bounded
and predictable instead of waiting out every VU's full socket hold during
ramp-down.

**How it was run**: as an **in-cluster `Job`** (`grafana/k6:latest`, script
mounted from a `ConfigMap` generated straight from the committed file),
targeting `http://demo.demo.svc.cluster.local` - not a host
`kubectl port-forward`. Task 4 already proved `port-forward` to a `Service`
resolves **one** backend pod for the life of the forwarded connection and
never rebalances, so a port-forwarded load test would only ever load one of
the two pods and couldn't demonstrate the HPA's actual point (average
utilization *across* pods). Routing through the in-cluster `Service` DNS
name means every new HTTP/WS connection goes through kube-proxy's normal
endpoint selection and actually fans out across both pods (and any pods
added mid-test). The Job manifest and `ConfigMap` are not vendored into the
repo (the task scope is `loadtest/hold-and-burst.js` + `loadtest/PLAN.md`
only); they're regenerable in one line from the committed script:

```bash
kubectl -n demo create configmap k6-hold-and-burst \
  --from-file=hold-and-burst.js=loadtest/hold-and-burst.js
kubectl -n demo create job k6-hold-and-burst --image=grafana/k6:latest \
  --dry-run=client -o yaml -- run /scripts/hold-and-burst.js  # + env/volume wiring
```

## 3. Observed HPA reaction

Baseline going in: `demo` at 2/2, HPA `cpu: 0%/65%`, both pods on separate
workers (`demo-worker`, `demo-worker2`), each at ~3m CPU / ~1.7GiB RSS
(idle). The official run used the script's own defaults - `HELD_VUS=60`,
`STORM_VUS=24`, storm window `t=40s..70s` inside the run - via the in-cluster
Job described above. `kubectl -n demo get hpa demo` / `kubectl top pods -n
demo` were sampled every 4s for the full run plus 9 minutes after. Times
below are wall-clock from Job apply (`22:06:33` UTC):

| t | What happened |
|---|---|
| t+0s | Job applied. 2 replicas, cpu 0%/65%. |
| t+20s | `held` finishes ramping to 60 VUs (per-VU: `GET /clock`, open `/live/websocket`, heartbeat, hold). |
| t+35s | cpu ticks to **1%/65%** - 60 concurrently held sockets, essentially still baseline. |
| t+40s..~75s | `storm` scenario's `startTime` fires; k6 ramps 0->24 tight-loop VUs (`GET /clock` + WS-upgrade-then-immediately-close, no think time). |
| **t+79s** | HPA reads **cpu: 183%/65%** (raw `kubectl top pods` at the same moment: 782m + 957m demo pods, plus 1563m on the k6 pod itself). 4 new pods (`2xxcq`, `r7hb9` on `demo-worker`; `th7jl`, `xtb4f` on `demo-worker2`) appear `Pending`. |
| **t+79-88s** | New pods scheduled -> `migrate` init container -> `demo` container -> startup probe passes. All 4 show `Ready` by **t+88s** - ~9s from `Pending` to `Ready` (image already resident on every node, migration is a no-op re-check). |
| t+96s | `SuccessfulRescale New size: 6; reason: cpu resource utilization (percentage of request) above target`. Deployment shows **6/6**. cpu still 173% (new pods only just started absorbing traffic). |
| t+110s | Storm scenario ends (its own 8s ramp + 15s hold + 7s ramp-down = 30s, matching `40+30=70s` -> wall-clock `t=110s`). cpu back to **2%/65%**. |
| t+127s | cpu **0%/65%**, 6/6 pods Ready, `held` continues (60 sockets still open - its own ramp-down isn't until t=140s). |
| t+153s | k6 Job `Succeeded` (150s total k6 run, matching `20+100+20=140s` of scenario stages + ~13s startup/init overhead). |
| **t+96s -> t+440s** | Replicas held at **6** the whole time despite cpu at 0% almost throughout - the `scaleDown.stabilizationWindowSeconds: 300` behavior policy: the controller looks back 300s and keeps the *highest* recommendation in that window, so it won't shrink until 300s past the last high reading. `440 - 96 = 344s`, consistent with 300s + a couple of 15s sync-cycle boundaries. |
| **t+440s** | `SuccessfulRescale New size: 5; reason: All metrics below target`. First scale-down step. |
| t+501s | New size: 4 (**61s** after the previous step). |
| t+561s | New size: 3 (**60s** later). |
| t+621s | New size: 2 (**60s** later) - back to `minReplicas`. |

So: a single clean **2 -> 6** rescale (the `scaleUp` behavior's `max(100%, 4
pods)` policy - from 2 replicas that's `max(+2, +4) = +4` - capped the jump
at exactly 6 regardless of how far over 65% the metric read), triggered by
one real connect-storm, with all 4 new pods Ready within ~9 seconds; then a
**~5m44s stabilization hold** at the elevated count while cpu sat at 0%; then
a strictly cadenced **6 -> 5 -> 4 -> 3 -> 2** scale-down, one pod removed
every 60-61 seconds, matching the `{Percent: 10, periodSeconds: 60}`
scale-down policy (10% of a small replica count rounds to "at least 1 pod
per 60s window" once a decrease is warranted). Full wall-clock from burst
start to fully-settled-at-baseline: **~10m21s**.

k6's own summary for the run: 150s wall time, `vus_max=84` (60 held + 24
storm, exactly `HELD_VUS + STORM_VUS`), 56,199 `ws_sessions` /
56,199 `http_reqs` (**374.7 req/s** average, blended across both scenarios -
`held` alone contributes under 1 req/s, so this is almost entirely the
`storm` scenario's throughput), `checks_succeeded: 98.86%` (1,278 of 112,355
checks failed - concentrated around the peak, i.e. transient `page 200` /
`ws upgraded (101)` failures while the two original pods were briefly
overloaded before the new ones came up; that's the system actually being
stressed, not a script defect).

Two earlier **calibration** runs (not the committed script, but real load
against this same cluster, kept here because they're useful corroborating
data points) produced the same mechanism at different magnitudes:

- A plain tight-loop `GET /clock` calibration (50 VUs, no WS, no think time,
  connection reuse) reached **~10.6k req/s** and **257%/65%** cpu, and - left
  running - triggered the *same* single-step **2 -> 6** rescale.
- The `storm` scenario calibrated in isolation (`HELD_VUS=1`) at 32 VUs / 25s
  hold, *after* the `ws.connect` blocking-close fix described above, reached
  **151%+/65%** and, sustained across two HPA sync cycles, produced a
  **two-step 2 -> 5 -> 6** rescale (two separate `SuccessfulRescale` events
  15s apart) - the data point that motivated tuning `STORM_VUS` down to 24
  and `STORM_HOLD` down to 15s for a single cleaner step in the official
  run. (*Before* the fix, the identical 32 VUs with a 500ms blocking close
  reached only ~31 req/s and never moved the HPA at all - that failed
  attempt is what surfaced the bug.)
- Both calibration runs' scale-downs were also captured and show the
  identical **~60-70s-per-pod** cadence reported above.

## 4. The CPU-vs-held-sockets observation (the HPA-signal argument)

This is the empirical basis for the README's "CPU is the
available-but-not-ideal signal" argument, and the official run above
demonstrates it as a clean **within-run A/B** - same pods, same test, three
back-to-back phases:

| Phase | Held sockets open | `kubectl top pods` (2 demo pods) | HPA cpu% |
|---|---|---|---|
| **held-only** (t=20s-75s, before the storm scenario's `startTime` fires) | 60, fully ramped and heartbeating | ~3-7m each (≈**11m total**, against a 1000m combined request) | **0-1%/65%** |
| **connect-storm** (t=79-110s) | 60 held + up to 24 storm | **782m + 957m** (demo pods) - plus 1,563m on the k6 pod itself | **183%/65%** (peak) |
| **post-storm, still held** (t=127s+, now 6 pods) | 60 (unchanged - `held`'s own ramp-down isn't until t=140s) | back to **3-7m per pod** across all 6 | **0-2%/65%** |

The **same 60 concurrently held sockets are present in all three rows** -
what changes cpu by two orders of magnitude is whether a connect-storm is
happening *concurrently*, not how many sockets are already open. A separate,
even more extreme version of this same result: the first (superseded)
single-scenario version of this script held **100** concurrent sockets flat
for a full 90s (no storm at all that run) and cpu never left **0-1%** the
entire time - 112 total HTTP+WS mounts over the full ~2.5 minute run.

Why: a held Phoenix socket transport (no `phx_join`, see the script's header
comment) is one lightweight Erlang process idling on a `receive`, waking up
once every `HEARTBEAT_MS` (30s default) to shuttle a few bytes. That costs a
process table entry and a small, mostly-idle heap - memory and scheduler
wakeups - not CPU cycles. CPU only moves when work actually happens:
rendering a dead-render HTML response, running the Plug pipeline, signing a
session cookie, completing a WS upgrade handshake. A LiveView app can be
holding thousands of "connected" users and be doing *nothing* CPU-wise; the
HPA's CPU-utilization signal is blind to that population by design. It's a
fine, standard signal for "is the app currently doing work" (the
connect-storm shape), and a bad one for "how many users are we actually
carrying right now" (the held-connection shape) - which is exactly the case
for a second, connection-aware metric (§5).

## 5. What a production load test would add

This was a 4 vCPU laptop-class kind cluster, one load generator process, and
a ~2.5-minute burst. A real pre-production load test for this service would
need to add:

- **Distributed load generation.** Here, k6 shares the exact same 4 vCPUs as
  the pods it's loading - the load generator itself is a confound. In
  production this would be k6 Cloud or several k6 workers spread across
  separate nodes/AZs (or `execution-segment`-sharded runs), so the generator
  can never be the bottleneck and its own CPU use never shows up on the same
  `kubectl top nodes` output as the thing being measured.
- **A real load balancer in front**, not a bare `ClusterIP`. An ALB/NLB
  introduces its own idle-timeout (ALB defaults to 60s - shorter than this
  app's 30s heartbeat interval is fine, but worth explicitly tuning and
  testing against), connection draining during pod termination (interacting
  with this Deployment's `preStop: sleep 10` + `terminationGracePeriodSeconds:
  90`), cross-AZ target distribution, and, if TLS terminates at the app
  instead of the LB, real crypto CPU cost on every connect that this
  plaintext-HTTP kind test doesn't pay at all.
- **Socket-count / mailbox-depth as a custom metric.** §4 shows CPU
  under-signals held-connection load by design (that's what "sockets cost
  memory, not CPU" means). A production HPA for this workload should
  seriously consider a second, LiveView-aware signal - e.g. connected socket
  count or Erlang process mailbox depth exported via Telemetry ->
  `PromEx`/Prometheus -> `prometheus-adapter` -> a `metrics.k8s.io`-style
  custom/external metric - so the HPA can react to "10,000 idle-but-held
  sockets are about to blow the memory limit" even when CPU is nowhere near
  65%. CPU alone is fine for the connect-storm shape and blind to the
  held-connection shape; a real deployment carrying meaningful standing
  socket population needs both.
- **A reconnect-stampede scenario after a forced node kill.** The
  synthetic ramp in `hold-and-burst.js` is a smooth, controlled connect-storm.
  The real-world event it's standing in for - an AZ failure, a node group
  recycle, or a rolling upgrade of the underlying EKS nodes - is much
  sharper and fully correlated: every client whose pod just disappeared
  runs the *same* exponential-backoff reconnect logic at roughly the *same*
  moment, against whatever capacity is left. A realistic test would
  `kubectl delete pod` (or cordon+drain) a fraction of the fleet mid-soak
  while sockets are held, and watch both the HPA reaction and whether the
  PDB (`maxUnavailable: 1` here) and `topologySpreadConstraints` actually
  keep the remaining pods able to absorb the stampede without cascading.
- **A sustained soak** (hours, not minutes). A 2.5-minute burst can't catch
  slow leaks - BEAM process/ETS table growth, a connection that isn't
  actually released, gradual RSS creep against a *fixed* 2Gi memory
  limit/request (this deployment intentionally sets no CPU limit but does
  fix memory request == limit; a slow leak is an OOMKill, not a throttle).
  Hours-long soaks at a realistic standing "held connections" population are
  what would actually validate that number.
- **Protocol-accurate LiveView clients for the interaction-load shape.**
  As noted in §1, this script intentionally never joins a LiveView topic. A
  production test that wants to characterize the third traffic shape (real
  `phx-click`/`phx-change` interaction, or view-driven timers like
  `ClockLive`'s 1s tick) needs a client that completes the real join
  handshake - either k6's browser module driving actual `phoenix_live_view`
  JS, or a purpose-built Elixir/Phoenix test client - plus a
  renders-per-second or per-view-process metric to make that load's cost
  visible the way raw connection counts can't.

## 6. Host limitations (honest accounting)

- 4 vCPUs total, shared by the kind control-plane node, both worker nodes,
  and the k6 load generator itself - there is no real per-"node" CPU
  isolation on this host, it's one pool. Any CPU number in §3/§4 is a
  measurement against that shared pool, not against dedicated node capacity.
- Each app pod's steady-state RSS (~1.7GiB, see `deploy/overlays/local/
  kustomization.yaml`'s memory-bump comment) already sits close to its local
  2Gi memory limit before any load is applied, purely from kind-on-WSL2 BEAM
  boot overhead. We deliberately did not chase `maxReplicas: 10` - scaling
  that far on this host risks memory pressure and control-plane flakiness
  (etcd/kube-apiserver share the same 4 vCPUs) that would destabilize the
  cluster for no evidentiary gain over a clean, smaller scale-up. A 2->N
  scale event with a captured timeline is a complete demonstration of the
  mechanism; it doesn't need to be a 2->10 event.
