# liveview-on-eks

**Phoenix LiveView, packaged as an OTP release, deployed to Kubernetes via Kustomize, with a production posture aimed at AWS GovCloud.**

This is my take-home submission: take an existing Phoenix LiveView demo app and make it genuinely production-ready on Kubernetes - a real multi-stage build, a rollout that doesn't drop live sockets, an HPA whose signal I can defend, and a deployment story that holds up in AWS GovCloud specifically, not just "AWS in general." The README is written the way I'd defend it in the walkthrough: what I built, what I measured, what I deliberately didn't do, and what I got wrong along the way before fixing it.

**TL;DR:** A Phoenix LiveView app packaged as an OTP release and deployed to EKS via Kustomize, with Karpenter-managed nodes and a production posture aimed at AWS GovCloud. Three findings carry the most weight: the rolling-deploy chain (surge-first rollout, widened HTTP drainer, `preStop` delay) measurably drops zero connections across a real rollout; the CPU-based HPA is honestly flagged as the *available* signal, not the *ideal* one, for a connection-holding workload; and node placement uses a dedicated, tainted, on-demand-only Karpenter pool sized to control blast radius, not just cost.

## Contents

- [What this is](#what-this-is)
- [The production artifact](#the-production-artifact)
- [How deploys don't drop sockets](#how-deploys-dont-drop-sockets)
- [The HPA signal: CPU is available, not ideal](#the-hpa-signal-cpu-is-available-not-ideal)
- [Multiple replicas and cross-pod state](#multiple-replicas-and-cross-pod-state)
- [Instance families and capacity types](#instance-families-and-capacity-types)
- [GovCloud considerations](#govcloud-considerations)
- [What I deliberately left out](#what-i-deliberately-left-out)
- [What I'd do differently with more time](#what-id-do-differently-with-more-time)
- [Assumptions](#assumptions)
- [Discovery log](#discovery-log)

## What this is

**Upstream.** The app itself is [`chrismccord/phoenix_live_view_example`](https://github.com/chrismccord/phoenix_live_view_example) at commit `bbaa800` (see `UPSTREAM-SHA.txt`) - a grab-bag of LiveView demos (clock, thermostat, snake, pacman, search-with-autocomplete, presence, paginated CRUD, an image editor, a `top`-powered process monitor). I vendored it as-is and touched as little of it as I could justify. Everything under `deploy/`, `karpenter/`, `loadtest/`, the `Dockerfile`, and `kind-config.yaml` is new. Inside the app itself I changed exactly nine things, in two groups.

**To make it run as a release (six):** two new files (`lib/demo_web/health_plug.ex`, `lib/demo/release.ex`) and four edits (`config/runtime.exs`, `config/prod.exs`, `lib/demo_web/endpoint.ex`, `lib/demo_web/live/page_live.ex`) - so the app boots as a release, serves a health check, and drains cleanly. Two of those edits exist only because I found real, pre-existing bugs by actually booting the compiled release instead of just compiling it; both are in the [discovery log](#discovery-log) below, because how I found them is as informative as the fix.

**To keep upstream's committed signing material out of the image (three):** `config/config.exs`, `config/dev.exs`, `config/test.exs`. Upstream hardcodes a `secret_key_base` in `config/config.exs`, which applies to *every* environment and therefore gets compiled into the production release. Phoenix's own generator instead puts dev/test values in `dev.exs`/`test.exs` and reads production's from the environment in `runtime.exs`; I restored that layout. Details and the verification in [No secrets in layers](#the-production-artifact).

### Repo map

| Path | What it is |
|---|---|
| `Dockerfile`, `.dockerignore` | Multi-stage build producing a `mix release` artifact in a 129MB Debian-slim runtime image |
| `config/runtime.exs`, `config/prod.exs` | Env-driven prod config (`PHX_SERVER`, `PHX_HOST`, `CHECK_ORIGIN`, `DATABASE_URL`, `SECRET_KEY_BASE`) and the widened HTTP connection drainer |
| `lib/demo_web/health_plug.ex` | `/healthz` - a DB-independent liveness/readiness endpoint |
| `lib/demo/release.ex` | `Demo.Release.migrate/0` - the release-mode migration task (there's no Mix at runtime) |
| `deploy/base/` | Kustomize base: `Deployment`, `Service`, `ServiceAccount`, `HorizontalPodAutoscaler`, `PodDisruptionBudget` |
| `deploy/overlays/local/` | kind dev overlay: namespace, a throwaway in-cluster Postgres, dev config/secrets |
| `deploy/overlays/govcloud-prod/` | Production overlay: a 3-replica floor (raised on the HPA, not the Deployment), Karpenter node placement, default-deny `NetworkPolicy`, GovCloud ECR image |
| `deploy/examples/hpa-custom-metric.yaml` | A design sketch (explicitly **not** applied anywhere): scale on connected sockets, not CPU |
| `karpenter/` | `NodePool` + `EC2NodeClass` for a dedicated, tainted node pool |
| `loadtest/` | The k6 load-test script (`hold-and-burst.js`) and the write-up of what it found (`PLAN.md`) |
| `kind-config.yaml` | 1 control-plane + 2 worker kind topology used for every proof in this README |

### Prerequisites

What a clean machine needs before running the steps below, with the versions actually used for every number in this README:

- **Docker** - builds the image, runs the standalone PID-1 check
- **kubectl** (v1.35) - cluster interaction, `rollout status`
- **kustomize** (v5.8.1), or `kubectl kustomize` - renders the overlays
- **kind** - local cluster (default-image cgroup v1 caveat is in the Quickstart below)
- **Helm** (v4.x) - only for the Karpenter CRD `helm template` step
- **k6** (v1.6) - the load test

### Quickstart

This is the exact sequence I used to produce every number in this document, run against a local `kind` cluster.

```bash
# 1. Create the cluster (1 control-plane + 2 workers, per kind-config.yaml)
kind create cluster --name demo --config kind-config.yaml

# On a cgroup-v1 host (I hit this on WSL2) the default kind node image's kubelet
# refuses to start at all - "kubelet is configured to not run on a host using
# cgroup v1". If `kubectl get nodes` never reaches Ready, recreate with an
# older, cgroup-v1-capable node image instead:
#   kind delete cluster --name demo
#   kind create cluster --name demo --config kind-config.yaml --image kindest/node:v1.31.0

# 2. Build the image and load it into the cluster (kind nodes don't pull from a registry)
docker build -t demo:local .
kind load docker-image demo:local --name demo

# 3. Deploy - namespace + throwaway Postgres + the app (renders 10 resources)
kubectl apply -k deploy/overlays/local
kubectl -n demo rollout status deploy/demo

# 4. Smoke-check
kubectl -n demo port-forward svc/demo 4000:80 &
curl http://localhost:4000/healthz   # -> ok
curl -i http://localhost:4000/       # -> HTTP 200, LiveView homepage

# 5. Load test (see loadtest/PLAN.md for why the real run targets the in-cluster
#    Service DNS name instead of this port-forward: a host port-forward pins to
#    one backing pod for its whole life and can't show multi-pod HPA fan-out)
k6 run loadtest/hold-and-burst.js -e TARGET=http://localhost:4000
```

The production overlay isn't meant to run on this cluster (it shares the `demo` name/namespace with the local overlay, and its image lives in a GovCloud ECR repo this cluster can't reach) - it's validated as rendered output and as a server-side API-schema check instead:

```bash
kustomize build deploy/overlays/govcloud-prod   # renders 7 resources cleanly, deterministic
```

Same story for Karpenter - I installed the real v1.11.1 CRDs into the kind cluster and validated the `NodePool`/`EC2NodeClass` against the live API server rather than trusting an offline linter:

```bash
helm template karpenter-crd oci://public.ecr.aws/karpenter/karpenter-crd --version 1.11.1 \
  | kubectl apply -f -
kubectl apply --dry-run=server -f karpenter/
# nodepool.karpenter.sh/liveview created (server dry run)
# ec2nodeclass.karpenter.k8s.aws/liveview created (server dry run)
```

Both objects passed schema and CEL validation (e.g. the EC2NodeClass's "specify exactly one of `role`/`instanceProfile`" rule) on the first attempt.

## The production artifact

### The build

```dockerfile
ARG BUILDER_IMAGE="hexpm/elixir:1.14.5-erlang-25.3.2.21-debian-bookworm-20260713-slim"
ARG RUNNER_IMAGE="debian:bookworm-20260713-slim"

FROM ${BUILDER_IMAGE} AS builder

RUN apt-get update -y && apt-get install -y build-essential git ca-certificates \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
RUN mix local.hex --force && mix local.rebar --force
ENV MIX_ENV=prod

# Deps first - cache layer survives app-code changes
COPY mix.exs mix.lock ./
RUN mix deps.get --only $MIX_ENV
RUN mkdir config
COPY config/config.exs config/prod.exs config/
RUN mix deps.compile

COPY priv priv
COPY lib lib
COPY assets assets
# esbuild wrapper downloads its pinned binary (0.12.18) here - needs network.
# In GovCloud CI this build runs commercial-side; the image is promoted into GovCloud ECR.
RUN mix assets.deploy
RUN mix compile

# runtime.exs is read at boot, not compile - copy last so config tweaks don't bust caches
COPY config/runtime.exs config/
RUN mix release

FROM ${RUNNER_IMAGE}

# procps: TopLive shells out to `top -bn1` (BusyBox top lacks -b - Alpine would break it)
# wamerican: SearchLive greps /usr/share/dict/words
# dict: SearchLive definitions (needs egress to dict.org - degrades gracefully without it)
RUN apt-get update -y \
    && apt-get install -y libstdc++6 openssl libncurses5 locales ca-certificates procps wamerican dict \
    && apt-get clean && rm -rf /var/lib/apt/lists/* \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen

ENV LANG=en_US.UTF-8 LANGUAGE=en_US:en LC_ALL=en_US.UTF-8 MIX_ENV=prod

WORKDIR /app
COPY --from=builder --chown=nobody:root /app/_build/prod/rel/demo ./
USER nobody

# The release script exec's into the BEAM: the VM is PID 1, traps SIGTERM,
# and runs a clean OTP shutdown (endpoint drainer included). No shell, no tini.
ENTRYPOINT ["/app/bin/demo"]
CMD ["start"]
```

Two stages: a `hexpm/elixir` builder that compiles the app and assembles a `mix release`, and a bare Debian runtime that only ever sees the assembled release directory - no Mix, no Hex, no source, no compiler. Dependencies are copied and fetched before application code so an app-only change reuses the entire dependency-compile cache layer; `config/runtime.exs` is copied dead last, right before `mix release`, because it's read at *boot*, not compile time, so touching it shouldn't invalidate anything upstream.

**`mix release` is the artifact, not `mix phx.server`.** A release strips out Mix entirely - I confirmed this directly against the running container: `Code.ensure_loaded?(Mix)` returns `false`, and calling `Mix.env()` raises `UndefinedFunctionError` because the module doesn't exist in the release at all. `mix phx.server` is a Mix task; it can't run in an environment with no Mix, and shipping it would mean shipping the whole dev toolchain (Hex, the compiler, source) into production for no benefit. The release's boot script instead does something more direct.

**PID 1 is the BEAM itself.** The release's generated boot script (`bin/demo`) `exec`s into the Erlang VM for the `start` command - no wrapper shell survives, nothing sits between Kubernetes and the VM:

```
$ docker run -d --rm --name demo-app -e PHX_SERVER=true -e PHX_HOST=localhost \
    -e CHECK_ORIGIN=false -e SECRET_KEY_BASE=<64+ chars> -e DATABASE_URL=<ecto://...> demo:local
$ docker exec demo-app ps -o pid,comm
  PID COMMAND
    1 beam.smp
   37 epmd
   ...
```

I checked this two ways: inside a standalone Docker container, and - more importantly - inside a live pod in the kind cluster (`cat /proc/1/comm` → `beam.smp`). That's why there's no `tini`/`dumb-init` in this image: those exist to reap orphaned children and forward signals correctly for processes that don't handle PID-1 responsibilities themselves. The BEAM does - it receives `SIGTERM` directly and runs its own OTP application shutdown sequence (see [How deploys don't drop sockets](#how-deploys-dont-drop-sockets)). Adding an init wrapper here would just be an extra layer forwarding a signal the VM already handles correctly.

**Why Debian-slim, not distroless or Alpine.** I read the demo code before picking a base image, and two of the demos shell out to host binaries:

- `TopLive` (`lib/demo_web/live/top_live.ex`) runs `System.cmd("top", ["-n", "1", "-b"])`. BusyBox's `top` - what Alpine ships - doesn't support `-b`; that call would fail on every render.
- `SearchLive` (`lib/demo_web/live/search_live.ex`) greps `/usr/share/dict/words` for autocomplete and shells to the `dict` binary for definitions.

Neither failure shows up at build time or even at boot - only the first time someone clicks "Top" or "Search" in a browser. A distroless or Alpine base would build fine and then silently break two demos in a way no automated check in this pipeline would catch. So the runtime stage installs `procps` (real `top`), `wamerican` (the dictionary word list), and `dict`, on top of plain `debian:bookworm-slim`.

**Image size: 129MB**, unchanged across every rebuild in this project (a template-only fix later on didn't touch deps or base layers).

**Toolchain: pinned to the app's 2021 dependency freeze.**

| Component | Version |
|---|---|
| Elixir | 1.14.5 |
| Erlang/OTP | 25.3.2.21 |
| Debian | `bookworm-20260713-slim` (same date-stamped image for both builder and runtime - verified they share the same base layer) |
| Phoenix | 1.6.0 |
| Phoenix LiveView | 0.16.4 |
| Cowboy | 2.9.0 (via `plug_cowboy` 2.5.2) |
| esbuild (asset wrapper) | 0.12.18, pinned binary |

`mix deps.get` surfaces Hex security advisories against several of these (`cowboy`, `cowlib`, `decimal`, `phoenix`, `plug`, `plug_cowboy` - mostly DoS-class buffer/decompression issues). I didn't bump anything: the assignment is explicitly about deploying this app's frozen 2021 toolchain, not re-platforming it, and bumping any one of these risks breaking the pinned Elixir/OTP compatibility matrix. In a real production adoption of this app, updating that dependency tree would be one of the first things I'd do - noted here rather than silently ignored.

**No secrets in layers - and I checked rather than assumed.** `DATABASE_URL` and `SECRET_KEY_BASE` are read from the environment at *boot* (`config/runtime.exs`), never baked into an `ARG`/`ENV` at build time, never copied in from a `.env` file (`.dockerignore` excludes `deploy/` entirely from the build context). They arrive at runtime via `envFrom: [secretRef: demo-secrets]` in the Kubernetes Deployment.

That covers secrets *this deployment* introduces. It did **not** originally cover one the vendored app brought with it, and finding that required actually grepping the built image rather than reading the Dockerfile. Upstream hardcodes a `secret_key_base` in `config/config.exs` - and `config.exs` is *compile-time* config, so `mix release` evaluates it at build time and writes the result into `releases/<vsn>/sys.config` **inside the image**. The Dockerfile was never at fault: no source config file ships. The *value* did, one level down, in the release's own config. It's stored as an Erlang byte list (`<<84,86,48,...>>`) rather than plain text, so a naive `grep` for the secret returns nothing - I got a false "clean" result on the first attempt.

Production was never actually exposed - `runtime.exs` requires `SECRET_KEY_BASE` and raises without it, so the committed value could never sign anything in prod. But "it's inert" is not the same as "it isn't there," and re-publishing another project's exposed secret in a public repo is still publishing it. So I moved it to where Phoenix's generator puts such values (`dev.exs`/`test.exs`, as obvious placeholders - Plug's cookie store requires ≥64 bytes) and left `config.exs` without one. Phoenix defaults `secret_key_base` to `nil`, so nothing needs it at compile time. Verified against the rebuilt image:

```
$ docker run --rm demo:local sh -c 'grep -c secret_key_base /app/releases/*/sys.config'
0        # not the value, not even the key
```

Image size unchanged at 129MB; `/healthz`, the LiveView dead render, and a signed session cookie all still work on the cluster with the key supplied only from the environment.

While there I also regenerated both `signing_salt`s. Those are *not* secrets - they're domain separators that let one `secret_key_base` derive different keys for session cookies vs LiveView tokens, and Phoenix's own generator commits them into `endpoint.ex` and `config.exs` in every app it creates. Phoenix's source makes the distinction explicit, dropping only one key when it scrubs config: `conf = Keyword.drop(secret_conf, [:secret_key_base])`. I regenerated them anyway so this repo republishes no credential material copied from upstream.

### Migrations: `Demo.Release.migrate/0`

Since there's no Mix in a release, there's no `mix ecto.migrate` either. `lib/demo/release.ex` is the standard Phoenix-recommended replacement - a small module compiled into the release itself:

```elixir
defmodule Demo.Release do
  @moduledoc "Release tasks (no Mix in a release). Run: /app/bin/demo eval 'Demo.Release.migrate()'"
  @app :demo

  def migrate do
    Application.load(@app)

    for repo <- Application.fetch_env!(@app, :ecto_repos) do
      {:ok, _, _} = Ecto.Migrator.with_repo(repo, &Ecto.Migrator.run(&1, :up, all: true))
    end
  end
end
```

It's invoked as a Kubernetes `initContainer` on the same Deployment, using the same image:

```yaml
initContainers:
  - name: migrate
    image: demo:local
    args: ["eval", "Demo.Release.migrate()"]
```

**Multi-replica nuance worth knowing:** an `initContainer` runs once *per pod*, not once per Deployment - so at 3 replicas, three separate processes call `Demo.Release.migrate()` independently, and the same thing happens again on every future scale-up event. That's safe here, not by luck: `ecto_sql`'s `lock_for_migrations/3` wraps the run in a transaction that first issues `LOCK TABLE "schema_migrations" IN SHARE UPDATE EXCLUSIVE MODE` (on by default via `:migration_lock`). That lock mode conflicts with itself, so concurrent migrators serialize - the second and third callers block until the first commits, then see the migrations already applied and exit cleanly with nothing left to do. (Worth naming precisely: it's a *table* lock on `schema_migrations`, not a `pg_advisory_lock` - I described it as an advisory lock until I read `ecto_sql` 3.7.0's Postgres adapter.)

**"Safe" is not the same as "right", and this is the weakest design choice in the submission.** The lock makes concurrent migrators *correct*; it doesn't make this a good production pattern. Two costs it does nothing about:

- **Privilege coupling.** The initContainer and the app container read `DATABASE_URL` from the same Secret, so they share one database identity - and that identity must hold DDL rights (`CREATE`/`ALTER`/`DROP TABLE`) for migrations to work. The consequence is that **every app pod runs with credentials that can destroy the schema.** What I'd actually want is an application user restricted to `SELECT`/`INSERT`/`UPDATE`/`DELETE`, with DDL rights held solely by whatever performs migrations. This pattern makes that separation impossible.
- **A slow migration throttles scale-up.** A migration that takes minutes - a large index build, say - holds that table lock for its whole duration, and any pod the HPA starts meanwhile blocks in its initContainer before the app container can begin. The scale-up number above (4 pods `Ready` in ~9s) holds *because the migration was a no-op*; it says nothing about the day it isn't. For a bursty, connection-holding workload that means capacity frozen at precisely the wrong moment.

**Why I shipped it anyway - a scoping decision, not an oversight.** With CI/CD deliberately out of scope, an `initContainer` is the only pattern that delivers "schema exists before the app serves traffic" from a single `kubectl apply -k`. The correct answer is a one-shot `Job` per deploy, but that requires sequencing a bare kustomize apply can't express (`Job` + `kubectl wait`, a Helm `pre-upgrade` hook, or an Argo CD `PreSync` hook) - and it's only worth building alongside the pipeline that would gate it. With that pipeline I'd run migrations as a `Job` using a *separate* Secret carrying the DDL user, leaving the app pods least-privilege. A cheaper intermediate step, if I wanted the startup guarantee without the write privileges: make the initContainer a read-only *check* that fails when migrations are pending, and perform the migration deliberately elsewhere. It's a small amount of wasted work on every scale-up (a lock wait plus a no-op migration check), not a correctness risk.

## How deploys don't drop sockets

### Pod hardening

Before the rollout mechanics, the pod itself runs about as locked-down as I could make it without breaking the app:

```yaml
securityContext:               # pod-level
  runAsNonRoot: true
  runAsUser: 65534
  runAsGroup: 65534
  seccompProfile:
    type: RuntimeDefault
---
securityContext: &ctrsec        # container-level, shared via YAML anchor by both
  allowPrivilegeEscalation: false   # the main container and the migrate initContainer -
  readOnlyRootFilesystem: true      # they can never silently drift apart
  capabilities: {drop: ["ALL"]}
```

`readOnlyRootFilesystem: true` means the BEAM's own `RELEASE_TMP` needs somewhere writable - that's the one `emptyDir` volume (`tmp`, mounted at `/tmp`) both containers share. I verified this is actually enforced, not just declared: `touch /this-should-fail` inside a running pod returns `Read-only file system`; `touch /tmp/this-should-work` succeeds.

The `ServiceAccount` carries zero permissions on purpose:

```yaml
apiVersion: v1
kind: ServiceAccount
metadata:
  name: demo
automountServiceAccountToken: false
```

There is no `Role`, `ClusterRole`, or `RoleBinding` anywhere in this repo - I checked. The workload never calls the Kubernetes API for anything, so it gets an identity (for audit/future IRSA-style AWS role mapping) but no token mounted and no RBAC grant at all, not even a read-only one. Least privilege by *absence*, not by a narrowly-scoped grant that still has to be maintained.

### The `/healthz` design

All three probes hit the same endpoint, and that endpoint is deliberately DB-independent:

```elixir
defmodule DemoWeb.HealthPlug do
  @moduledoc """
  Liveness/readiness endpoint. Deliberately does NOT check the database:
  most LiveView demos work without it, and failing readiness on an RDS blip
  would drop every healthy pod's open sockets - worse than degraded pages.
  """
  import Plug.Conn

  def init(opts), do: opts

  def call(%Plug.Conn{request_path: "/healthz"} = conn, _opts) do
    conn |> send_resp(200, "ok") |> halt()
  end

  def call(conn, _opts), do: conn
end
```

It's plugged in `endpoint.ex` immediately after the LiveView socket mount and before `Plug.Static` - the first real plug in the pipeline, ahead of sessions, CSRF, and the router. A `GET /healthz` never touches Ecto, never touches the router, and costs almost nothing.

The reasoning is the same argument threaded through this whole section: **readiness that depends on the database is worse than readiness that doesn't.** If `/healthz` failed during a transient RDS blip, every pod would flip `NotReady` simultaneously, the Service would drop every endpoint at once, and every currently-open LiveView socket would be torn down for a database hiccup that most of the demos in this app don't even need to render (Clock, Snake, Thermostat, Pacman, Presence - none of them touch Postgres). A DB-dependent readiness check turns a partial, recoverable degradation (the `/users` CRUD pages 500, everything else keeps working) into a total outage.

All three probes use it, tuned differently for what each is for:

```yaml
startupProbe:    {periodSeconds: 2,  failureThreshold: 30}  # up to 60s to boot
readinessProbe:  {periodSeconds: 5,  failureThreshold: 2}   # 10s to leave rotation
livenessProbe:   {periodSeconds: 10, failureThreshold: 3}   # 30s before a restart
```

**Proof - I killed the database and watched.** The argument above is only worth what the app actually does, so I measured it: a migrated app and its Postgres on a private Docker network, then `docker stop` on the database.

| | app alive | `/healthz` | `/` (LiveView) | `/users` (DB-backed) |
|---|---|---|---|---|
| baseline | yes | 200 | 200 | 200 |
| DB down +5s | yes | **200** | **200** | 500 |
| DB down +20s | yes | **200** | **200** | 500 |
| DB down +45s | yes | **200** | **200** | 500 |
| DB down +75s | yes | **200** | **200** | 500 |
| DB back +5s | yes | 200 | 200 | 500 |
| DB back +20s | yes | 200 | 200 | **200** |

`RestartCount: 0` for the whole run. The app rode out 75 seconds with no database at all, kept every non-DB page serving, and healed itself roughly 20 seconds after Postgres came back - that's the connection pool's own backoff, not a restart. This is the "partial, recoverable degradation" the design is chosen for, measured rather than asserted: because `/healthz` never wavered, the pods never left the Service, and **no open WebSocket was torn down for a database problem.**

**The honest boundary: surviving an outage is not the same as starting during one.** The result above is for a pod that was *already running*. A pod that tries to **start** while the database is unreachable behaves completely differently - Postgrex can't establish its initial pool, the supervisor exceeds its restart intensity, and the release exits non-zero (I hit this by accident while testing, and confirmed it: the endpoint comes up, logs `failed to connect ... :econnrefused`, then the application terminates). In Kubernetes that is `CrashLoopBackOff`.

So during a sustained RDS outage the existing fleet keeps serving, but anything requiring a *new* pod won't get one - an HPA scale-up, a node replacement, a rolling deploy. Capacity freezes at whatever is already running. That's a real limitation and I'd rather name it than have it discovered: it argues for *not* deploying into a database outage, and it makes the DB-independent readiness probe more important rather than less, since the running pods are the only ones you'll have.

### The Service: `ClusterIP`, and deliberately no session affinity

```yaml
spec:
  type: ClusterIP
  ports:
    - {name: http, port: 80, targetPort: http, appProtocol: http}
```

**Why `ClusterIP` and not `LoadBalancer`.** The app speaks plain HTTP on `:4000` and assumes something in front terminates TLS - an ALB Ingress, or this org's istio `Gateway`/`VirtualService`. A `type: LoadBalancer` Service would provision its own AWS load balancer per Service, bypass that shared L7 boundary, and stand up a separate internet-facing endpoint inside a GovCloud perimeter. `NodePort` is worse again: it pins traffic to node ports that move as Karpenter recycles nodes. `ClusterIP` keeps the Service as the stable in-cluster routing target and leaves TLS, WAF, and hostname routing to the layer that should own them.

**No `sessionAffinity` - this is the LiveView-specific part of the answer.** It's tempting to reach for `sessionAffinity: ClientIP` on a "stateful-feeling" WebSocket app, and it would be wrong here. A LiveView WebSocket is a *single* long-lived connection: it lands on a `Ready` pod, `mount/3` runs there, and it stays on that pod for its entire life. There's no second request to route consistently, so stickiness buys nothing - and it actively hurts the drain path, because the whole rollout design depends on a disconnected client being free to reconnect to a *different*, healthy pod. Pinning clients to pods by source IP fights that.

The one case that genuinely would need affinity is LiveView's **long-poll fallback** transport, used when a proxy blocks WebSockets: there a session really is a sequence of separate HTTP requests that all have to reach the same pod. Nothing here configures it, so that fallback path is a real gap if it's ever exercised in production - flagged rather than pre-emptively "solved" with an affinity setting the primary transport doesn't want. (`appProtocol: http` is set so istio/ALB select the L7 protocol explicitly instead of sniffing it.)

Worth noting what this Service is *not* doing: it isn't a discovery mechanism for the pods to find each other. That would need a second, headless Service - see [Multiple replicas and cross-pod state](#multiple-replicas-and-cross-pod-state).

### The chain

This is the sequence that keeps the Service serving through a rolling deploy, end to end:

1. **`maxUnavailable: 0`, `maxSurge: 1`** on the Deployment's rolling-update strategy - the replacement pod must exist and be healthy before its predecessor is touched. With `maxSurge: 1`, replacements happen one at a time, not all at once.
2. The new pod starts, passes its `startupProbe`, then its `readinessProbe`, and only then is added to the Service's endpoints.
3. Only *after* the new pod is `Ready` does Kubernetes begin terminating the old one. `preStop` fires first: `sleep 10`. This isn't padding - it buys time for kube-proxy/endpoint-slice propagation to catch up across the cluster before the pod actually stops accepting connections, closing the small window where a load balancer might still route a new connection to a pod that's about to disappear.
4. After `preStop` returns, Kubernetes sends `SIGTERM` - directly to the BEAM, since it's PID 1.
5. The BEAM's standard OTP shutdown sequence begins, and as part of it the endpoint's HTTP drainer (`Plug.Cowboy.Drainer`, wired in automatically by `Cowboy2Adapter`) stops accepting new connections and waits for in-flight ones to finish. **This window is 30 seconds, not the framework default of 5** - see the drainer discovery below.
6. Whatever LiveView/WebSocket connections were still open on that pod get a clean disconnect as the drainer completes (rather than a dropped TCP connection).
7. The LiveView JS client's own reconnect logic notices the socket closed and reconnects - against a different, healthy pod, since the old one is on its way out - and re-mounts.
8. `terminationGracePeriodSeconds: 90` is the outer bound. The expected path (`preStop` 10s + up to 30s drain) finishes in well under half that budget; if something hangs, kubelet SIGKILLs at 90s rather than waiting forever.

**Deploy or scale-down - the same chain, because it's attached to the pod, not the reason it's leaving.** Steps 3–8 are all pod-spec-level (`preStop`, `terminationGracePeriodSeconds`, the `SIGTERM` → drainer path), so they fire on *any* termination: a rolling deploy replacing a pod, the HPA scaling in, or Karpenter draining a node during consolidation. The assignment asks about deploy *and* scale-down specifically - for scale-down the extra protection is that the HPA's scale-in is deliberately paced (300s stabilization, 10%/60s - see [the HPA signal](#the-hpa-signal-cpu-is-available-not-ideal)) so socket-holding pods are removed slowly, and the `PodDisruptionBudget` (`maxUnavailable: 1`) caps concurrent voluntary disruptions to one at a time regardless of trigger (proven below).

**The drainer detail, precisely, because it's easy to get backwards:** Phoenix 1.6's `Cowboy2Adapter` starts an HTTP connection drainer automatically - its config key defaults to `[]`, which is truthy in Elixir (only `nil`/`false` are falsy), so it's on unless explicitly disabled. But `Plug.Cowboy.Drainer`'s own default `:shutdown` window is **5000ms**. I widened it explicitly in `config/prod.exs`:

```elixir
config :demo, DemoWeb.Endpoint,
  drainer: [shutdown: 30_000]
```

**And on 1.6.0, that is the only drain knob there is.** Current Phoenix has *two* drainers: `socket/3` accepts its own `:drainer` option, and the docs are explicit that "after the socket drainer runs, the lower level HTTP/HTTPS connection drainer will still run, and apply to all connections." That socket-level drainer is where the widespread "Phoenix drains sockets for you" impression comes from - and it does **not** exist in 1.6.0. At this pinned version the HTTP drainer above is the entire mechanism, which is exactly why its 5-second default matters more here than it would on a modern Phoenix: there is no second layer behind it. Verified by reading the pinned sources (`Cowboy2Adapter` at phoenix 1.6.0, `Plug.Cowboy.Drainer` at plug_cowboy 2.5.2) rather than trusting prose written against a newer version.

### Evidence

**Proof A - a rolling restart drops nothing.** I triggered `kubectl rollout restart deploy/demo` against the live cluster while running a curl loop **inside** the cluster, hitting the Service's DNS name (`demo.demo.svc.cluster.local`) rather than a host `kubectl port-forward` - a port-forward pins to one specific backing pod for the life of the tunnel and doesn't fail over, so it would have measured "does my one pinned pod survive," not "does the Service keep serving." (My first attempt used a host port-forward and showed 188 failures - all of them the tunnel dying the instant its pinned pod started terminating, not a real gap. I caught that and redid it correctly.)

**Result: 600 requests over 120 seconds, `fail=0`.** The pod timeline shows why:

| Event | Timing |
|---|---|
| Surge pod #1 created → Ready | - |
| Old pod #1 starts Terminating | **13ms after** its replacement was Ready |
| Surge pod #2 created → Ready | - |
| Old pod #2 starts Terminating | **28ms after** its replacement was Ready |
| Each old pod fully gone (`Completed`) | ~11.5–11.6s after Terminating began (10s `preStop` + fast drain) |

In both replacement pairs the surge pod was fully serving traffic *before* its predecessor even began to leave - capacity was never actually reduced, which is exactly what zero curl failures over 600 requests says.

*Re-verified after switching `preStop` from `exec: ["sh","-c","sleep 10"]` to the native `sleep` lifecycle action:* another in-cluster rolling restart returned **535 requests, `fail=0`**, and timing a single pod deletion end to end gave **11s** - the 10-second `preStop` hold plus a fast drain. The kubelet-managed delay behaves identically to the forked-shell version, without needing a shell in the image.

**Proof B - the same `PodDisruptionBudget` (`maxUnavailable: 1`) also protects against non-deploy disruption.** I drained one of the two kind worker nodes (the same mechanism Karpenter itself uses during node consolidation - see [Instance families and capacity types](#instance-families-and-capacity-types)). The replica on the *untouched* node stayed `1/1 Running` for the entire operation; only the replica on the drained node went through Terminating → replacement Ready → gone. At no point were both replicas down together - exactly what `maxUnavailable: 1` guarantees, empirically, not just on paper.

### Honest limit

None of this migrates LiveView *state*. A reconnect is a fresh `mount/3` on whatever pod the client lands on next, not a resumed copy of the old process's assigns - LiveView server state lives in one Erlang process on one pod, and that process is gone once its pod is. Anything that has to survive a reconnect (a paginated list's current page, a selected filter, an in-progress form) needs to be recoverable from the URL (`push_patch`/query params - LiveView's own idiom for this) or the database, not held only in socket assigns. I didn't script a persistent WebSocket client to capture the client-side reconnect experience live in this headless test environment - the HTTP-continuity proof above plus this structural argument (a healthy pod is always available to reconnect against, and the drainer gives connections a clean close instead of a dropped packet) is the evidence I have, and I'm not overstating it as more than that.

## The HPA signal: CPU is available, not ideal

The base HPA is plain CPU utilization:

```yaml
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
spec:
  scaleTargetRef: {apiVersion: apps/v1, kind: Deployment, name: demo}
  minReplicas: 2
  maxReplicas: 10
  metrics:
    - type: Resource
      resource: {name: cpu, target: {type: Utilization, averageUtilization: 65}}
  behavior:
    scaleUp:
      stabilizationWindowSeconds: 0      # bursty traffic: react immediately
      policies:
        - {type: Percent, value: 100, periodSeconds: 15}
        - {type: Pods, value: 4, periodSeconds: 15}
      selectPolicy: Max
    scaleDown:
      stabilizationWindowSeconds: 300    # scale-in kills pods holding live sockets - do it slowly
      policies:
        - {type: Percent, value: 10, periodSeconds: 60}
```

**Who owns `spec.replicas`.** The base `Deployment` deliberately omits `replicas` entirely, and that omission is load-bearing. Setting a literal replica count alongside an HPA means every `kubectl apply -k` - or every GitOps reconcile - writes the manifest's number back over whatever the autoscaler had decided. That isn't a cosmetic fight: a `Deployment` scale-down is the ReplicaSet controller **deleting pods directly**, which does *not* go through the Eviction API, so the `PodDisruptionBudget` never sees it and cannot pace it. An apply landing mid-burst - HPA at 8, manifest says 3 - would drop five pods' worth of live sockets in a single step, which is precisely the failure this whole submission is built to prevent, arriving through a side door. So the replica *floor* lives on the autoscaler: `minReplicas: 2` in base, raised to `3` in the govcloud-prod overlay (`deploy/overlays/govcloud-prod/patch-hpa.yaml`) so the zone spread can rest at one pod per us-gov-west-1 AZ.

### Why CPU is the available signal, not the ideal one

I measured this directly rather than asserting it. Using `loadtest/hold-and-burst.js` (two concurrent k6 scenarios - `held`, a standing population of clients that open a Phoenix socket and just heartbeat every 30s with no LiveView `phx_join`, and `storm`, a short burst of clients mounting and reconnecting as fast as possible with no think time), I captured a clean within-run A/B on the *same pods*:

| Phase | Held sockets | Measured CPU (2 demo pods) | HPA reading |
|---|---|---|---|
| Held-only, before the storm | 60, fully ramped, heartbeating | ~3–7m each (≈11m total against a 1000m combined request) | **0–1% / 65%** |
| Connect-storm (60 held + up to 24 storming) | 60 + storm | 782m + 957m (plus 1,563m on the k6 pod itself) | **183% / 65%** (peak) |
| Post-storm, still held | 60, unchanged | back to ~3–7m per pod | **0–2% / 65%** |

The same 60 held sockets are present in all three rows. What moves CPU by two orders of magnitude is whether a connect-storm is happening *concurrently* - not how many sockets are already open. A held Phoenix socket transport with no `phx_join` is one lightweight Erlang process idling on `receive`, waking every 30 seconds to shuttle a heartbeat - that's a process-table entry and a small mostly-idle heap: memory and scheduler wakeups, not CPU cycles. CPU only moves when real work happens - rendering a dead-render page, running the Plug pipeline, signing a session cookie, completing a WebSocket upgrade handshake. A fleet can be holding thousands of connected-but-idle users and sit at 5% CPU, one mount storm away from a memory/scheduler problem the CPU metric can't see coming.

The redeeming property, and why I'm not throwing CPU out: it happens to correlate well with *when you actually need to scale* for the connect-storm shape, because arrival-rate is exactly what does cost CPU. CPU is a fine, standard signal for "is the app doing work right now," and a blind one for "how many users are we actually carrying right now."

**A wrinkle that cuts both ways - LiveView hibernates idle processes, and this app mostly defeats it.** `phoenix_live_view` 0.16.4 starts every LiveView as a GenServer with `hibernate_after: 15000` (`channel.ex`: `endpoint.config(:live_view)[:hibernate_after] || 15000`), and this app never configures it, so it runs on that default. After 15 seconds without a message the BEAM hibernates the process - call stack discarded, garbage collected, heap compacted to a minimum. Published field reports put an active LiveView around 3MB against roughly 150kB hibernated; that ratio swings enormously with what a given LiveView keeps in `assigns`, so treat it as directional, not a number to size against.

That would make idle held connections far cheaper than "held sockets cost memory" implies - except that **six of the vendored demos drive themselves on timers**: `clock_live` and `top_live` tick every second, `thermostat_live` every 100ms, `rainbow_live` once per frame, `snake_live` and `pacman_live` continuously. A process receiving a message every second never reaches 15 seconds idle, so it never hibernates. Only the quiet views - Search, the CRUD/pagination pages, the image editor - ever would.

So per-socket cost in *this* app is bimodal rather than a single number, and which mode dominates depends on which page users are on - which is why the 2000-sockets-per-pod figure in `deploy/examples/hpa-custom-metric.yaml` is a placeholder to calibrate, not a derived one.

### Then why not scale on memory?

The obvious follow-up, and it deserves an answer: memory is a `type: Resource` metric that metrics-server already provides, so it needs *none* of the custom pipeline a socket gauge would - and it's the resource I just argued held connections actually consume. Three reasons it's a worse signal here:

1. **BEAM memory doesn't shrink on demand.** The VM allocates from the OS and holds it; per-process garbage collection returns memory to the VM's own allocators, not necessarily to the kernel. After a storm subsides, RSS stays elevated - so a memory-driven HPA would scale up and then never scale back down, defeating the paced scale-in above entirely.
2. **`request == limit` makes memory pressure an OOMKill, not a throttle.** At 512Mi for both, crossing the limit is an immediate `SIGKILL`: no `preStop`, no drainer, every socket on that pod dropped abruptly - precisely the failure this whole design exists to prevent. Scaling *on* memory means deliberately steering toward an event whose failure mode is maximally destructive. CPU has no equivalent cliff, because I set no CPU limit. Note this reason exists *because* of that packing decision - the two are coupled, so adopting memory as the signal would mean revisiting it too.
3. **It lags.** CPU spikes at the *moment* of a connect storm - the start of the event, when extra capacity is still useful. Memory rises as a *consequence* of connections already accepted, so by the time it crosses a threshold the pod is already near its ceiling.

**And on a current cluster there's a better answer to memory pressure than horizontal scaling at all.** In-place pod resource updates went **Stable in Kubernetes 1.35** - CPU and memory on a *running* pod can be adjusted without recreating it. For a workload whose central problem is that replacing a pod drops every socket it holds, that inverts the trade: grow the pods you already have instead of adding pods and later removing them. On a 1.35+ cluster I'd combine the two - the HPA horizontally for connect storms, in-place vertical resize to absorb the memory growth of standing connections. The cluster I validated against is 1.31, so it wasn't available here, but it's the direction I'd take this.

### What the HPA actually did

Driving the `storm` scenario to a peak of 183%/65% produced a clean single-step rescale, and the arithmetic reconciles exactly: the HPA's desired-replica formula is `ceil(currentReplicas × currentMetricValue / target)` - `ceil(2 × 183 / 65) = ceil(5.63) = 6`. Independently, the `scaleUp` behavior policy caps how much can be added in one step: the larger of +100% (2→4) or +4 pods (2→6), and it picks the max, landing on 6. The metric said 6 and the policy allowed 6 - both numbers arrived at the same place. All 4 new pods went `Ready` within about 9 seconds of `Pending` (the image was already resident on every node).

Scale-down was strictly paced, not immediate, even with CPU back near 0%: the controller held at 6 replicas for roughly 344 seconds after the peak (consistent with the 300s `stabilizationWindowSeconds` plus a sync-cycle or two - it keeps the *highest* recommendation seen in that window), then stepped down one pod roughly every 60–61 seconds - 6→5→4→3→2 - matching the `{Percent: 10, periodSeconds: 60}` policy exactly. Total wall-clock from burst start to fully settled back at the 2-replica floor: about 10 minutes 21 seconds.

### The better signal

`deploy/examples/hpa-custom-metric.yaml` is a design sketch - clearly marked as not applied anywhere, not wired into any overlay's `resources:` - for what I'd actually want in production: a `Pods`-type metric on `phoenix_socket_connected` (average 2000 connected sockets per pod), kept *alongside* CPU rather than instead of it, so the HPA scales on whichever metric currently demands more replicas - CPU still catches a connect storm fast; the socket gauge catches "we're one mount away from saturation" that CPU structurally can't see. The pipeline that sketch assumes doesn't exist yet - and building it is more than plumbing. Phoenix fires `[:phoenix, :socket_connected]` on connect, but there is **no corresponding disconnect event** at any Phoenix version I could find, so a live *gauge* of currently-connected sockets can't be assembled from built-in telemetry alone: something has to observe teardown (monitor the transport process, decrement on `:DOWN`) or the number only ever climbs. Past that, the chain is `:telemetry` → `PromEx`/`telemetry_metrics_prometheus` → Prometheus → `prometheus-adapter` (or KEDA's Prometheus trigger, often less fiddly than hand-written adapter rules) → the HPA. Until that pipeline exists, applying that file would just leave the HPA stuck at "unable to fetch metrics" - which is exactly why it's an example, not a deployed manifest. Full traffic-shape reasoning and the raw numbers behind all of this are in `loadtest/PLAN.md`.

## Multiple replicas and cross-pod state

Most of this app is fine at 2+ replicas with zero extra work - each LiveView process lives entirely inside one client's connected socket on one pod, with no cross-pod dependency. Clock, Thermostat, Snake, Pacman, Search, the image editor: none of them care which pod they're on.

Two demos do, and they're quietly broken across pods without me doing anything else:

- `Demo.PubSub` (`{Phoenix.PubSub, name: Demo.PubSub}` in `application.ex`) uses `phoenix_pubsub`'s default adapter.
- `DemoWeb.Presence` (`lib/demo_web/channels/presence.ex`) is built directly on `Phoenix.Presence`.

Both fan messages out over **distributed Erlang** - process groups that only span BEAM nodes that have joined the same Erlang cluster. I confirmed this deployment doesn't set that up at all: no `libcluster` dependency anywhere in `mix.exs`/`mix.lock`, no headless Service, no `RELEASE_DISTRIBUTION`/`RELEASE_NODE`/`RELEASE_COOKIE` in any overlay's config. Each pod's BEAM is a fully isolated node that has never heard of the others. That's a conclusion from reading the supervision tree and the deployment config, not from spinning up two browser tabs against two pods - but it's not a guess either: this is exactly how `Phoenix.PubSub`'s default adapter and distributed Erlang work, and the absence of any clustering wiring is directly verifiable in this repo.

Concretely: the "CRUD users with live pagination" pages broadcast their live-update events over `Demo.PubSub` - a create/update/delete from a session on pod A never reaches a session on pod B. The Presence demo (`/presence_users/:name`) only shows the subset of "present" users whose sockets happen to be on the *same* pod as the viewer - and with no session affinity on the Service, two browsers hitting the same URL will often land on different pods by nothing more than kube-proxy's normal round-robin.

**This is deferred, and here's exactly the fix I'd ship:**

1. Add `{:libcluster, "~> 3.3"}` to `mix.exs` (regenerate `mix.lock` in the pinned builder container).
2. A `Cluster.Supervisor` child in `application.ex` using `Cluster.Strategy.Kubernetes.DNS`, pointed at a new headless Service (`demo-headless`, `clusterIP: None`) so each pod can discover its siblings by DNS.
3. Inject `POD_IP` via the downward API; set `RELEASE_DISTRIBUTION=name`, `RELEASE_NODE=demo@<pod-ip>`, and a shared `RELEASE_COOKIE` sourced from a Secret - these go in `rel/env.sh.eex`, which the release reads before it starts distributed Erlang.
4. Verify with 3 replicas: two sessions port-forwarded to different pods on `/presence_users/:name` should see each other; a CRUD create on one pod's session should appear live on a session connected to a different pod.

**Why I deferred it instead of building it:** time ceiling, and a deliberate one. This is a multi-file change (app dependency, supervision tree, a new Service, release env-var wiring, `RELEASE_COOKIE` handling) with real surface area to get subtly wrong under time pressure - exactly the kind of thing that looks done in a demo and isn't actually correct. I'd rather hand over a fully-proven drain path, HPA behavior, and GovCloud posture than a fourth moving part that's 80% verified. The custom-metrics HPA sketch above got built in the time available because it's genuinely self-contained (one YAML file, clearly inert); this isn't that.

**One thing that does *not* need fixing:** the WebSocket transport itself needs no sticky sessions. A fresh WS connection to any `Ready` pod is a complete, valid mount - the LiveView process starts wherever the connection lands, with no dependency on prior pod affinity. The full reasoning - including why the long-poll fallback transport is the one case that *would* need affinity, and why nothing here configures it - is under [The Service](#the-service-clusterip-and-deliberately-no-session-affinity).

## Instance families and capacity types

```yaml
requirements:
  - {key: kubernetes.io/os, operator: In, values: [linux]}
  - {key: kubernetes.io/arch, operator: In, values: [amd64]}
  - {key: karpenter.sh/capacity-type, operator: In, values: [on-demand]}
  - {key: karpenter.k8s.aws/instance-category, operator: In, values: [m, c]}
  - {key: karpenter.k8s.aws/instance-generation, operator: Gt, values: ["5"]}
  - {key: karpenter.k8s.aws/instance-cpu, operator: In, values: ["4", "8", "16"]}
  - {key: karpenter.k8s.aws/instance-memory, operator: Gt, values: ["7000"]}
```

**`m`/`c`, generation 6+.** General-purpose or compute-optimized, nothing specialized this workload doesn't need. `Gt 5` means m6i/c6i and newer. I did *not* verify family-by-family availability against the GovCloud API - no GovCloud credentials, the same limitation I flag for Bottlerocket below - and on reflection it doesn't need verifying: Karpenter `requirements` are a **filter over what the region actually offers**, not a demand for it. A family that isn't published in us-gov-west-1 is simply never selected, and nothing errors at apply time. That said, "narrows" has a floor worth stating: Karpenter's scheduling docs are explicit that if constraints leave *no* overlap, nodes never launch and pods stay `Pending`. With six other requirements already bounding the set, `m`/`c` at generation 6+ is a wide enough target that zero-overlap isn't a realistic risk here - but it's a filter with a failure mode, not a free one.

**Mid-size only (4/8/16 vCPU) - a deliberate blast-radius control.** Node size determines how many concurrently-held sockets are at risk on a single node failure or drain. A handful of huge nodes packs more connections per failure domain; a swarm of tiny nodes wastes more capacity on per-node daemonset/kubelet overhead relative to app capacity. Mid-size is the balance point for a connection-holding workload specifically - this is the same reasoning that motivates the `PodDisruptionBudget` and topology spread elsewhere in this repo, just applied one layer down at the node level.

**On-demand only - spot rejected, deliberately, not as a cost-avoidance default.** A spot interruption gives a 2-minute warning, then reclaims the instance outright - every socket that node was holding drops in the same few seconds, and every one of those clients' reconnect logic fires at roughly the same moment, against whatever capacity is left. That's a reconnect stampede landing at the exact moment capacity just got worse - the wrong risk profile for a workload whose entire value is long-lived connections. I'd use spot without hesitation for the k6 load-generation pods or genuinely stateless batch work; not for this.

**amd64-only today, Graviton as a stated lever, not a current decision.** The image is single-architecture (no `buildx`/multi-arch manifest). Moving to arm64/Graviton is a real, known cost lever for this workload but needs a multi-arch build pipeline this submission doesn't have - listed under [what I'd do with more time](#what-id-do-differently-with-more-time), not silently skipped.

**Consolidation, tuned slower than Karpenter's stateless defaults:**

```yaml
disruption:
  consolidationPolicy: WhenEmptyOrUnderutilized
  consolidateAfter: 10m
  budgets:
    - {nodes: "20%", reasons: [Empty, Drifted]}
    - {nodes: "10%", reasons: [Underutilized]}
    - {nodes: "0", reasons: [Underutilized], schedule: "0 13 * * mon-fri", duration: 8h}
```

`consolidateAfter: 10m` is longer than Karpenter's stateless default on purpose - repacking a node means evicting it, and eviction means reconnects, for a workload where that's not free. The budgets are reason-scoped: a genuinely empty or drifted node can be reclaimed more freely (20%) than a live-but-underutilized one being repacked out from under active connections (10%), and the last budget is a hard business-hours freeze - `0` nodes, Underutilized only, `13:00 UTC` for 8 hours. Karpenter's cron is UTC-only and can't track DST, so `13:00–21:00 UTC` lands at 09:00–17:00 ET during EDT (summer) and 08:00–16:00 ET during EST (winter) - the local window drifts an hour by season, but either way it brackets the core of the business day. (If a business needs the window pinned to local wall-clock year-round, that's an argument for a small controller that reschedules the budget across DST, not for a UTC cron.) No voluntary repacking of live nodes during peak traffic; underutilized consolidation still runs freely off-hours.

The dedicated pool is tainted (`workload: liveview`, `NoSchedule`) and its nodes carry the matching label, so this pool's disruption settings alone govern this workload's nodes - no churny stateless/batch neighbor's scheduling pressure bleeds into it. The `nodeSelector`/`toleration` pair in `deploy/overlays/govcloud-prod/patch-deployment.yaml` matches this taint/label exactly; I grepped both files to confirm the key/value/effect line up on every axis. And this is exactly the mechanism [Proof B](#how-deploys-dont-drop-sockets) demonstrates against: Karpenter's own consolidation drains nodes the same way I manually drained one to test the PDB - that proof is a direct rehearsal of what happens when Karpenter reclaims a node in this pool.

## GovCloud considerations

**Partition-agnostic references, not hardcoded ARNs.** `EC2NodeClass.spec.role` is set by *name* (`Karpenter-demo-cluster-Node-Role`), not a full ARN. An ARN embeds its partition (`aws` vs `aws-us-gov`); a role reference hardcoded against the commercial partition would silently fail to resolve in GovCloud. By-name resolution works unchanged in either partition.

**No ECR Public in GovCloud, so the build has to happen commercial-side.** `mix assets.deploy` downloads a pinned esbuild binary; `mix deps.get` pulls from Hex - both need internet egress that GovCloud's boundary doesn't (and shouldn't) provide. The Dockerfile's own comment on that line spells this out: the build runs commercial-side, and only the finished image - with those artifacts already baked in - gets promoted into a GovCloud-private ECR repo. Nothing inside the GovCloud boundary ever reaches out to hex.pm or an esbuild CDN. The overlay's image reference reflects the target shape: `123456789012.dkr.ecr.us-gov-west-1.amazonaws.com/demo:v0.1.0` - a documented placeholder account ID, and a pinned tag, never `:latest`.

**FIPS endpoints.** Production AWS SDK traffic should set `AWS_USE_FIPS_ENDPOINT=true` (or address the FIPS-suffixed regional endpoints directly). I haven't wired this into `config.env` because the app makes no direct AWS API calls today - it only talks to Postgres. Flagging it here as forward-looking guidance for the day that changes (ESO/IRSA-driven AWS calls, for instance), not as a gap I patched around.

**Bottlerocket, fact-checked rather than assumed.** Bottlerocket has been GA across AWS GovCloud regions since November 2021 - AWS's own GA announcement, not something I could confirm directly against the AMI catalog myself (no GovCloud credentials for a console/API check). I went looking for reasons *not* to trust that and found one worth chasing down: [`bottlerocket-os/bottlerocket#4668`](https://github.com/bottlerocket-os/bottlerocket/issues/4668), opened October 2025, reports the x86_64 k8s Bottlerocket AMI missing from SSM Parameter Store in us-gov-west-1 - exactly the lookup path Karpenter's `amiSelectorTerms: [{alias: ...}]` depends on. At a glance that looks like a live blocker for this exact NodePool. Reading the actual thread: it's closed, a maintainer reproduced the SSM lookup and got back a real AMI ID (`ami-09483b06ffffa4bb6`), and the original report turned out to be a console-pagination and shell-quoting artifact, not a missing parameter. I kept Bottlerocket (`bottlerocket@v1.57.0`, pinned rather than `@latest` so an AMI change is a deliberate, budgeted Drift event, not a surprise) and left the verification command plus an AL2023 fallback directly in the `EC2NodeClass` comment, so nobody has to redo this research if AMI resolution ever fails for real:

```
# the maintainer's reproduction was against the aws-k8s-1.34 path - substitute your cluster's minor version
aws ssm get-parameter --region us-gov-west-1 \
  --name /aws/service/bottlerocket/aws-k8s-1.34/x86_64/latest/image_id
```

**CMK-encrypted EBS.** Both volumes (`/dev/xvda` OS, `/dev/xvdb` data) are `gp3`/`encrypted: true` today. A customer-managed KMS key (`kmsKeyID`) is left as a documented `TODO` comment rather than a fabricated key ARN - there's no real GovCloud KMS key for this exercise to reference, and I'd rather leave an honest gap marker than a placeholder that looks real. Listed as a go-live gate in [what I deliberately left out](#what-i-deliberately-left-out).

**IMDSv2 required, hop-limit 1.** `metadataOptions: {httpEndpoint: enabled, httpTokens: required, httpPutResponseHopLimit: 1}` - a container inside a pod can't reach the node's own instance-credential metadata. IRSA is unaffected; it doesn't go through IMDS.

**`send-metrics = false`.** Bottlerocket's own telemetry is disabled in `userData` - no phone-home from a host sitting inside a GovCloud boundary.

**3 AZs, zone spread.** us-gov-west-1 has 3 availability zones; the Deployment's `topologySpreadConstraints` (hostname *and* zone, `maxSkew: 1`) mean the govcloud-prod overlay's 3-replica floor - set on the HPA's `minReplicas` rather than the Deployment, so it actually holds at steady state - can rest one pod per zone. Both constraints are `whenUnsatisfiable: ScheduleAnyway`, i.e. best-effort placement, not a hard guarantee: during a connect storm I would rather a pod schedule somewhere imperfect than sit `Pending` waiting for capacity in the "right" zone. `DoNotSchedule` would make the spread strict and let Karpenter provision into the missing zone, at the cost of slower burst response - a defensible trade the other way, and the one I'd revisit first if a single-AZ loss were the dominant risk.

**Secrets never in git.** `demo-secrets` is deliberately absent from the govcloud-prod overlay - no `secretGenerator`, the Deployment's `envFrom` reference is left dangling on purpose. In a real deploy the Secrets Store CSI driver (AWS provider, via IRSA) supplies that material from AWS Secrets Manager before the pods can serve - see [what I left out](#what-i-deliberately-left-out) for why I'd pick it over the External Secrets Operator, and what that costs. Nothing about `DATABASE_URL`/`SECRET_KEY_BASE` ever touches this repo.

**`dict.org` egress won't exist inside the boundary.** Found by reading the code, same as the base-image decision: `SearchLive`'s "definitions" handler shells to the `dict` binary, which needs outbound network access to a dict server. A GovCloud deployment's default-deny egress `NetworkPolicy` here only opens DNS and the RDS CIDR - `dict.org` isn't in that allow-list, and I wouldn't expect a real GovCloud boundary to route there either. (Worth flagging: kind's default CNI doesn't enforce `NetworkPolicy` at all, so this policy is authored and validated as a manifest, not actually enforced on this local cluster - real enforcement would need a NetworkPolicy-capable CNI like Calico/Cilium, or this org's istio `AuthorizationPolicy` in the ambient-mesh world.) Net effect: the "Search with autocomplete" half of the demo still works (it greps the local `/usr/share/dict/words` file - no network needed), but "definitions" will fail or hang. That's a real, small, honest product gap in this specific demo app running in GovCloud - not something I patched, since rewriting the demo's behavior is outside this exercise's scope, but exactly the kind of thing I'd rather surface here than have someone discover live in a walkthrough.

## What I deliberately left out

Each of these is a real gap, not an oversight I'm hoping nobody notices - here's what I'd do for each:

- **TLS termination / Ingress or istio VirtualService.** Nothing in this repo terminates TLS; the app speaks plain HTTP on `:4000`. I'd front the Service with either a classic ALB Ingress or this org's istio VirtualService/Gateway pattern, terminate TLS there, and point `PHX_HOST`/the implicit `CHECK_ORIGIN` default at the real public hostname (today `app.example.gov` is a placeholder).
- **Secrets Store CSI driver wiring.** The overlay expects `demo-secrets` to exist; nothing here creates it. I'd use the **AWS Secrets and Configuration Provider (ASCP) with the Secrets Store CSI driver** rather than the External Secrets Operator, because of where the secret ends up at rest: ESO's job is to *materialise a Kubernetes Secret*, so the value lives in etcd permanently whether or not anything is consuming it. The CSI driver mounts secret material into the pod's own tmpfs, with access granted per-pod via IRSA scoped to specific secret ARNs - a smaller resting footprint inside a regulated boundary. Two honest wrinkles I'd have to handle, both from the driver's own docs: (1) this Deployment consumes secrets as **environment variables** (`envFrom`), which the CSI driver only supports via `secretObjects` syncing - and *"the volume mount is required for the Sync With Kubernetes Secrets... solely relying on the syncing with Kubernetes secrets feature thus does not work,"* so the pod must mount the CSI volume even though it only wants env vars; (2) that sync recreates a Kubernetes Secret, which gives back the etcd footprint the CSI driver was chosen to avoid. Getting the full benefit means reading secrets from the mounted files instead of the environment - a small `config/runtime.exs` change - which is the version I'd actually ship. Also worth knowing: the synced Secret is deleted once no pod mounts it, which is fine at a replica floor of 3 and would bite at scale-to-zero.
- **Observability** - Prometheus/Grafana, and the custom socket-metric pipeline the HPA sketch assumes. I'd stand up `kube-prometheus-stack` (or this org's existing one), wire `PromEx`/`telemetry_metrics_prometheus` into the app for the `phoenix_socket_connected` gauge, and add `prometheus-adapter` so `deploy/examples/hpa-custom-metric.yaml` reads a real series instead of being inert.
- **CI/CD.** Everything here was built and validated by hand. I'd build a pipeline that builds the image commercial-side, runs the same smoke checks I ran manually (`/healthz`, `/`, `/clock`, `/users`, uid, PID 1), promotes to GovCloud ECR, then applies per environment (`kubectl apply -k` or a GitOps controller).
- **`libcluster`** - covered in full in [Multiple replicas and cross-pod state](#multiple-replicas-and-cross-pod-state); deferred on the time ceiling, with the exact fix already written up there.
- **apt-package pinning in the Dockerfile.** `procps`/`wamerican`/`dict`/etc. install whatever's current in the Debian snapshot at build time. I'd pin exact versions (or vendor a lockfile) so a rebuild six months from now can't silently drift the runtime image's package set.
- **A real production memory-sizing check.** The base Deployment's 512Mi request/limit is the real-EKS-*intent* number, not a verified one - the app's uncontended footprint was never actually measured, and the only clean 256MB result covered the migrate task rather than the running app (full story in the [discovery log](#discovery-log)). I'd re-measure steady-state RSS on a realistically-provisioned node before trusting 512Mi at production traffic.
- **`PodPriority`.** No `PriorityClass` is set on this Deployment. I'd add one so a connection-holding workload isn't first in line for eviction under node pressure.
- **A database connection-count budget.** `POOL_SIZE=10` is per *pod*, so the HPA multiplies it: at `maxReplicas: 10` that's 100 connections from this app alone - exactly a stock Postgres `max_connections` default. Worse during a burst, because the migrate initContainer reads the same `POOL_SIZE`, so each starting pod briefly opens a second pool. I never sized this against a real RDS instance's limit; I'd derive `POOL_SIZE` from `max_connections` divided by `maxReplicas` with headroom, or put PgBouncer in front.
- **Separating migration privileges from application privileges.** The migrate initContainer and the app container share one Secret and therefore one database identity - which must hold DDL rights, so every app pod carries credentials that can drop tables. The fix is a migration `Job` with its own Secret and a DDL-capable user, leaving the app on `SELECT`/`INSERT`/`UPDATE`/`DELETE` only. Reasoning in full under [Migrations](#the-production-artifact); it needs the deploy pipeline that's also out of scope here.
- **A node-level `terminationGracePeriod` on the NodePool.** Deliberately unset, so Karpenter waits indefinitely for pods to drain rather than force-deleting them - the right default when the alternative is dropping live sockets. The cost is that a genuinely stuck pod can stall a node drain forever. I'd add a generous backstop (well above the pod's own 90s) once I'd seen how the workload actually behaves in production.
- **`kmsKeyID`.** Left as a `TODO` comment in the `EC2NodeClass` rather than a fabricated key ARN - a real go-live gate once a real customer-managed key exists for this workload's compliance boundary.
- **Not left out, but worth finding here if you're looking:** upstream's committed `secret_key_base` and signing salts. That *was* going on this list, until grepping the built image showed the value shipping inside the release's `sys.config`. It's fixed rather than documented - see [No secrets in layers](#the-production-artifact).

## What I'd do differently with more time

- **Wire the custom-metric HPA end-to-end** - the sketch (`deploy/examples/hpa-custom-metric.yaml`) exists; the Telemetry→Prometheus→adapter pipeline behind it doesn't yet.
- **A reconnect-stampede load scenario after a forced node kill.** `loadtest/PLAN.md` names this as the single biggest missing test: hold a socket population, then `kubectl delete pod` (or cordon+drain) a slice of the fleet mid-soak, and watch whether the PDB and topology spread actually absorb the stampede without cascading - a much sharper, more correlated event than the smooth synthetic ramp `hold-and-burst.js` currently drives.
- **Graviton multi-arch build** - a `buildx`/CI matrix producing an arm64 image alongside amd64, then flipping the Karpenter NodePool's arch requirement to pick it up.
- **Automate a Karpenter `do-not-disrupt` surge window during deploys.** A rolling Deployment update and a Karpenter consolidation event could in principle land at the same time today. I'd add a scoped `karpenter.sh/do-not-disrupt: "true"` pod annotation (or budget-schedule coordination) during active rollout windows so the two mechanisms never fight each other.

## Assumptions

- **RDS is provided externally.** Nothing in this repo provisions a database; the app receives `DATABASE_URL` via environment (a plain env file locally, a Secret in prod).
- **The target cluster already has Karpenter ≥1.11 (v1 CRDs) and metrics-server installed.** This repo adds a `NodePool`/`EC2NodeClass` and an HPA that assume both already exist - it installs neither.
- **An L7 in front terminates TLS.** The app itself only ever speaks plain HTTP on `:4000`; nothing here terminates TLS (see [what I left out](#what-i-deliberately-left-out)).
- **Placeholder values are clearly marked in comments, not silently embedded:** the GovCloud account ID (`123456789012` in the ECR image ref), the RDS CIDR (`10.0.0.0/16` in the `NetworkPolicy`), and the production host (`app.example.gov` in `PHX_HOST`) all need real values at actual deploy time.
- **The local kind overlay's 2Gi memory bump is a host artifact, not an app requirement** - specific to running kind-on-WSL2 with a triple-nested container runtime and a 3-node control plane sharing 4 vCPUs with the workload itself. `deploy/base` keeps the real-EKS-intent numbers (512Mi/256Mi); only `deploy/overlays/local` patches them up, with the measurements that justify it recorded in that file's own comment.

## Discovery log

These are the things that actually went sideways building this, in the order they mattered, not a curated highlight reel - including what I chose to chase down (the Bottlerocket SSM scare, in [GovCloud considerations](#govcloud-considerations)) and what I knowingly took on faith (Bottlerocket's GovCloud GA date, and GovCloud instance-family availability).

- **Releases don't serve HTTP unless told to.** `mix phx.server` implicitly sets `server: true`; a compiled release skips that Mix task entirely, so without `PHX_SERVER=true` wired into `config/runtime.exs`, the release boots, connects to Postgres, and never opens a listener. An easy one to forget the first time you package a Phoenix app for real.

- **The `check_origin: case ... end` inline parse bug crashed every prod boot, and `mix compile` had no way to catch it.** An inline `case ... end` used as a keyword-list value inside a parenthesis-free `config :demo, Endpoint, check_origin: case ... end` call parses its `do/end` as belonging to the *outer* `config` call, not `case` - a `do/end` block attaches to the outermost enclosing call, which is exactly the ambiguity parentheses exist to resolve. The result was `config/4 undefined`, on every boot, unconditionally. `mix compile` never saw it, because `runtime.exs` is a `Config.Reader` script evaluated only at *boot*, not at compile time - a dev workflow or a compile-only CI check would sail right past this. I found it by actually booting the compiled release and reading the crash's AST dump. Fixed by binding `check_origin` to a local variable before passing it to `config`, matching this same file's own existing style for `database_url`/`secret_key_base`.

- **A second, independent bug: the homepage 500'd on every single request in prod.** `page_live.ex` unconditionally referenced `Routes.live_dashboard_path/2`, a route helper that only exists when `router.ex`'s dev/test-only block registers the LiveDashboard route. The compiler even warned about this in every build (`live_dashboard_path/2 is undefined or private`) - easy to read past a warning when the build still succeeds. It only became a hard failure once the release could actually boot far enough to serve a request. Fixed to match the pattern the app's own root layout (`root.html.heex` + `layout_view.ex`) already used elsewhere - `function_exported?(Routes, :live_dashboard_path, 2)` plus `@compile {:no_warn_undefined, ...}` - rather than inventing a new idiom. `page_live.ex` was simply the one place the original author hadn't applied their own established pattern.

- **The app shells out to `top` and `dict` - found by reading the code, not by a failed build.** A distroless or Alpine base would have built cleanly and then silently broken two demos the first time someone clicked them in a browser. Covered in full in [The production artifact](#the-production-artifact).

- **Phoenix 1.6 drains HTTP by default - but only for 5 seconds, and "it drains by default" is the thing that stops you from checking the number.** I went looking for whether draining needed turning on and found it already was: `Cowboy2Adapter` reads `Keyword.get(config, :drainer, [])`, and `[]` is truthy in Elixir, so the drainer starts unless you explicitly pass `false`. The window was the actual problem - `plug_cowboy` 2.5.2's moduledoc documents `:shutdown` as "Defaults to 5000ms," which is nothing beside a 90-second pod grace period. The part that cost me real time was version-matching the *documentation* to the pinned dependency: modern Phoenix has a second, socket-level drainer (`socket/3`'s own `:drainer` option, which runs before the HTTP one), and most writing about "Phoenix graceful shutdown" describes that - but it isn't in 1.6.0. Reading more documentation would not have helped; reading the documentation *for the right version* did.

- **esbuild-only assets meant no Node build stage - not what I walked in expecting.** `phoenix ~> 1.6.0` sits right at the edge of Phoenix's esbuild transition, and I'd planned for an `npm ci && npm run deploy` stage. The vendored app already uses the `esbuild` Mix wrapper end to end (`mix assets.deploy` → `esbuild default --minify && phx.digest`), which downloads its own pinned binary at build time - no Node or npm anywhere in the toolchain. A simpler Dockerfile than planned.

- **`Demo.PubSub`/`Phoenix.Presence` are distributed-Erlang-dependent, and this deployment has no clustering at all.** Confirmed by reading the supervision tree and grepping for any clustering config (`libcluster`, `RELEASE_DISTRIBUTION`, a headless Service) - there is none. At 2+ replicas the CRUD live-updates and the presence demo are quietly pod-local. Full detail and the deferred fix in [Multiple replicas and cross-pod state](#multiple-replicas-and-cross-pod-state).

- **The brief's own suggested k6 load shape produced literally zero CPU movement.** One HTTP request plus one WS upgrade per VU, then a ~2-minute hold, repeated - run exactly as sketched, it generated 112 total requests over a 2.5-minute run (~0.75 req/s), and CPU never left baseline. Not broken - it's arrival-rate versus population-size: a large *standing* VU count doesn't create a large *arrival rate* if each VU only mounts once every two minutes. I redesigned it into two concurrent scenarios (`held` for standing idle sockets, `storm` for a genuine connect burst), and hit a real k6 gotcha along the way: `ws.connect()` blocks the calling VU until the socket closes, so an early version's `setTimeout(..., 500)` close became an accidental ~2-iterations/sec/VU throughput ceiling that had nothing to do with the server or the app. Fixed by closing synchronously inside the `open` handler.

- **kind's default node image won't boot at all on a cgroup v1 host.** `kind create cluster` with the current default node image hard-fails on WSL2 - kubelet refuses to start ("kubelet is configured to not run on a host using cgroup v1"), confirmed via `journalctl -u kubelet` inside the node container. `--image kindest/node:v1.31.0` (an older, cgroup-v1-capable image) works. Documented as a comment in `kind-config.yaml` rather than baked into the file itself, since it would be actively wrong guidance on a cgroup v2 host.

- **Memory footprint is environment-dependent, not fixed - the migrate task fit 256MB uncontended, but the running app settled at ~1.7GiB under this host's contention.** The base Deployment's 512Mi limit OOM-looped on kind-on-WSL2; live RSS polling during a manual boot showed the full app (`start`) settling around 1.7GiB. A flat `docker run --memory=256m` of the *same image* running the *same migration task* outside kind (no nested control-plane, no CPU contention) succeeded reliably - but that's the migrate task, not the full app, whose uncontended footprint I never actually measured. The app isn't "just huge" - this specific host's triple-nested container runtime plus a 3-node control plane sharing 4 vCPUs slows BEAM's boot enough that memory keeps climbing before it can finish settling. Patched to 2Gi in the local overlay only; `deploy/base` keeps 512Mi as the real-EKS intent, flagged as needing a real-node check before I'd trust it at production traffic.

**On AI use:** I used an AI coding assistant throughout this build for scaffolding, boilerplate, and documentation/API lookups against current Phoenix/Kubernetes/Karpenter docs rather than stale training data on fast-moving APIs. Every design decision in this README is one I can defend on its own merits in the walkthrough, and this discovery log is what actually went wrong and what I actually learned fixing it.
