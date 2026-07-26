import ws from 'k6/ws';
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// hold-and-burst.js - models the actual LiveView workload, not a generic HTTP
// load test, as two scenarios running concurrently:
//
//   held  - a standing population of clients that mount once and then hold
//           their Phoenix socket open, heartbeating, like a browser tab a
//           user left open. This is "many idle websockets" (see loadtest/PLAN.md
//           §1/§4): it costs memory and scheduler wakeups, not CPU.
//   storm - a short, sharp wave of clients mounting and reconnecting as fast
//           as possible. This is the connect-storm: it's what actually moves
//           the CPU number the HPA watches.
//
// Splitting these into two scenarios (rather than one iteration doing both,
// as the brief's original sketch does) is a deliberate, measured deviation -
// see "Why two scenarios" below.
//
// Deliberate scope choice, both scenarios: neither sends a `phx_join` for a
// LiveView topic (e.g. "lv:<id>"). Joining would mean replaying the
// CSRF/session handshake `phoenix_live_view`'s JS client performs on mount,
// and - more importantly for what this test isolates - it would start a real
// LiveView process that re-renders on a server-side timer (`ClockLive` ticks
// every 1s once connected). Holding only the *socket transport* open with
// heartbeats models "connected but idle" at the cost Phoenix.Socket itself
// charges (one Erlang process + heartbeat traffic every 30s), without also
// paying per-view render cost. That is the split this script is built to
// expose: mounting is where CPU goes; a held transport is not.
//
// Phoenix socket protocol vsn=2.0.0: frames are JSON arrays
//   [join_ref, ref, topic, event, payload]
// A heartbeat is `[null, ref, "phoenix", "heartbeat", {}]` - handled by
// Phoenix.Socket.Transport directly, no channel join required.
//
// Why two scenarios (calibration note):
// The brief's single-iteration sketch (GET once, open a socket, hold ~2min,
// sleep 1s, repeat) is - by design - a *low request-rate* pattern: each VU
// only issues one HTTP request and one WS upgrade per ~2-minute iteration.
// We ran exactly that shape first (WARM_VUS=15 -> PEAK_VUS=100 over a 10s
// ramp, 90s hold) against this cluster and measured it directly: over the
// full ~2.5 minute run it produced 112 HTTP requests and 112 ws upgrades
// total (~0.75 req/s) and CPU never left baseline (0-1% the entire time,
// confirmed via a 5s-interval `kubectl top pods` timeline). That's expected,
// not a bug - it's the same "held connections are cheap" result this script
// is built to demonstrate (see `held` below), just accidentally applied to
// the *whole* test instead of being contrasted against a real burst. A
// separate tight-loop calibration (plain `GET /clock`, 50 VUs, no think
// time) hit ~10.6k req/s and pushed measured CPU to 257% of the HPA target
// (1078m + 1497m against a 500m x 2 request) - proof the app and cluster
// *can* generate a real spike, just not from the "one request per 2-minute
// iteration" shape. So: `held` keeps the brief's original per-iteration
// pattern (proven CPU-cheap at 100 concurrent VUs, sustained 90s - see
// loadtest/PLAN.md §4), and `storm` is a new, separately-tuned scenario
// whose whole job is to reproduce that tight-loop spike on purpose, layered
// on top of the held population, for a short, bounded window.

const wsConnectErrors = new Counter('ws_connect_errors');
const httpMountDuration = new Trend('http_mount_duration', true);

// --- Load shape -------------------------------------------------------
// Tuned for a 4 vCPU host running the *entire* kind cluster (control-plane +
// 2 workers) *and* k6 itself - not the brief's reference 50/400 VUs, which
// assumes a real multi-node cluster. Crossing 65% average utilization on a
// 2-pod/500m-request deployment only takes ~325m of *sustained* CPU, which
// is a low bar given enough request rate, but "enough request rate" is the
// operative phrase - see the calibration note above. Every number below is
// overridable via env vars so the same script scales up on real hardware.
// See loadtest/PLAN.md §2-3 for the actual numbers observed against this
// cluster.
const HELD_VUS = Number(__ENV.HELD_VUS || 60); // standing "idle sockets" population
const WARM_TIME = __ENV.WARM_TIME || '20s'; // held ramps 0 -> HELD_VUS
const HOLD_TIME = __ENV.HOLD_TIME || '100s'; // held stays flat for the rest of the test (covers pre-storm baseline + the storm itself + post-storm cool-down)
const DOWN_TIME = __ENV.DOWN_TIME || '20s';
const SOCKET_HOLD_MS = Number(__ENV.SOCKET_HOLD_MS || 130000); // long enough a held VU doesn't reconnect mid-test
const HEARTBEAT_MS = Number(__ENV.HEARTBEAT_MS || 30000);

const STORM_VUS = Number(__ENV.STORM_VUS || 24); // calibrated: see PLAN.md §2-3 (32 VUs measured 151%+, compounding across two HPA sync cycles to 2->5->6; scaled back for a single cleaner step)
const STORM_START = __ENV.STORM_START || '40s'; // let `held` establish a clean low-CPU baseline first
const STORM_RAMP = __ENV.STORM_RAMP || '8s'; // sharp: the "connect storm" shape
const STORM_HOLD = __ENV.STORM_HOLD || '15s'; // one HPA sync cycle's worth of sustained peak, not several
const STORM_RAMPDOWN = __ENV.STORM_RAMPDOWN || '7s';
const STORM_SOCKET_HOLD_MS = Number(__ENV.STORM_SOCKET_HOLD_MS || 0); // 0 = close as soon as open fires; ws.connect() blocks the VU for this long per iteration, so >0 directly caps throughput (see storm())

export const options = {
  scenarios: {
    held: {
      executor: 'ramping-vus',
      exec: 'held',
      startVUs: 0,
      stages: [
        { duration: WARM_TIME, target: HELD_VUS },
        { duration: HOLD_TIME, target: HELD_VUS },
        { duration: DOWN_TIME, target: 0 },
      ],
      gracefulRampDown: '10s',
      gracefulStop: '10s',
    },
    storm: {
      executor: 'ramping-vus',
      exec: 'storm',
      startVUs: 0,
      startTime: STORM_START,
      stages: [
        { duration: STORM_RAMP, target: STORM_VUS },
        { duration: STORM_HOLD, target: STORM_VUS },
        { duration: STORM_RAMPDOWN, target: 0 },
      ],
      gracefulRampDown: '5s',
      gracefulStop: '5s',
    },
  },
};

function target() {
  return __ENV.TARGET || 'http://localhost:4000';
}

// held: connect, hold the LiveView websocket open, heartbeat. One mount per
// ~SOCKET_HOLD_MS-long iteration - deliberately low request rate.
export function held() {
  const base = target();

  const res = http.get(`${base}/clock`);
  check(res, { 'page 200': (r) => r.status === 200 });
  httpMountDuration.add(res.timings.duration, { scenario: 'held' });

  const wsUrl = base.replace('http', 'ws') + '/live/websocket?vsn=2.0.0';
  const socketRes = ws.connect(wsUrl, {}, (socket) => {
    socket.on('open', () => {
      let ref = 0;
      socket.setInterval(() => {
        socket.send(JSON.stringify([null, String(++ref), 'phoenix', 'heartbeat', {}]));
      }, HEARTBEAT_MS);
      socket.setTimeout(() => socket.close(), SOCKET_HOLD_MS);
    });
    socket.on('error', () => wsConnectErrors.add(1, { scenario: 'held' }));
  });
  check(socketRes, { 'ws upgraded (101)': (r) => r && r.status === 101 });

  sleep(1);
}

// storm: mount as fast as possible (GET /clock + WS upgrade, barely hold,
// close, repeat). No think time - this is the connect-storm, the thing that
// actually spikes CPU and trips the HPA.
export function storm() {
  const base = target();

  const res = http.get(`${base}/clock`);
  check(res, { 'page 200': (r) => r.status === 200 }, { scenario: 'storm' });
  httpMountDuration.add(res.timings.duration, { scenario: 'storm' });

  const wsUrl = base.replace('http', 'ws') + '/live/websocket?vsn=2.0.0';
  const socketRes = ws.connect(wsUrl, {}, (socket) => {
    socket.on('open', () => {
      // ws.connect() blocks the VU until the socket closes, so a
      // setTimeout-based delay here directly caps iteration throughput -
      // measured: 32 VUs with a 500ms delay topped out at ~31 req/s (a
      // ~2-iterations/sec/VU ceiling from the timer, not from the server).
      // STORM_SOCKET_HOLD_MS defaults to 0: close as soon as the upgrade
      // completes, so the only per-iteration cost is the real GET + WS
      // upgrade round-trip, which is what actually reproduces the tight-loop
      // calibration's throughput (see PLAN.md §2-3).
      if (STORM_SOCKET_HOLD_MS > 0) {
        socket.setTimeout(() => socket.close(), STORM_SOCKET_HOLD_MS);
      } else {
        socket.close();
      }
    });
    socket.on('error', () => wsConnectErrors.add(1, { scenario: 'storm' }));
  });
  check(socketRes, { 'ws upgraded (101)': (r) => r && r.status === 101 }, { scenario: 'storm' });
}
