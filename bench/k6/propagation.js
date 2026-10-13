// k6 load test: N concurrent editors on one document, measuring op propagation latency.
//
// Each VU is one editor. VUs are spread round-robin over the server URLs in SYNC_URLS, so with
// two instances half of all deliveries cross instances (via Redis). Every VU types CPS characters
// per second, each chained after its previous one like real typing. Each op frame carries the
// send time as `trace`; the server echoes it on the broadcast, and every receiving VU records
// now - trace. All VUs share one process clock, so the difference is meaningful.
//
//   docker run --rm -v "$PWD/bench/k6:/scripts" -e EDITORS=50 \
//     -e SYNC_URLS=ws://host.docker.internal:8787/sync,ws://host.docker.internal:8788/sync \
//     grafana/k6:2.3.0 run /scripts/propagation.js
import { check } from 'k6';
import { Counter, Rate, Trend } from 'k6/metrics';
import { setInterval, clearInterval, setTimeout } from 'k6/timers';
import { WebSocket } from 'k6/websockets';

const URLS = (__ENV.SYNC_URLS || 'ws://host.docker.internal:8787/sync').split(',');
const EDITORS = Number(__ENV.EDITORS || 10);
const DURATION_S = Number(__ENV.DURATION_S || 60);
const WARMUP_S = Number(__ENV.WARMUP_S || 5);
const CPS = Number(__ENV.CPS || 5);

export const options = {
  scenarios: {
    editors: {
      executor: 'per-vu-iterations',
      vus: EDITORS,
      iterations: 1,
      maxDuration: `${DURATION_S + WARMUP_S + 60}s`,
    },
  },
  summaryTrendStats: ['min', 'med', 'p(90)', 'p(95)', 'p(99)', 'max', 'count'],
};

const propagation = new Trend('propagation_ms', true);
const opsSent = new Counter('ops_sent');
const opsReceived = new Counter('ops_received');
const connected = new Rate('connected');

export function setup() {
  return { doc: __ENV.DOC || `k6-${String(Date.now())}`, startAt: Date.now() + 3000 };
}

export default function (data) {
  const url = URLS[(__VU - 1) % URLS.length];
  const replica = `k6v${String(__VU)}x${Math.floor(Math.random() * 1e9).toString(36)}`;
  const ws = new WebSocket(url);
  let seq = 0;
  let origin = { clock: 0, replica: '' };
  let typing = null;
  let welcomed = false;
  const measureFrom = data.startAt + WARMUP_S * 1000;
  const stopAt = measureFrom + DURATION_S * 1000;

  ws.onopen = () => {
    ws.send(
      JSON.stringify({
        type: 'hello',
        protocol: 1,
        doc: data.doc,
        replica,
        owns: [],
        user: { name: `vu${String(__VU)}`, color: '#336699' },
        vv: {},
      }),
    );
  };

  ws.onmessage = (e) => {
    const raw = e.data;
    // Hot path: broadcasts. Parsing every frame in full made k6 itself the bottleneck (it used
    // ~2 cores at 100 editors), inflating latencies; read just the traces and count the ops.
    if (raw.startsWith('{"type":"ops"')) {
      opsReceived.add(countOccurrences(raw, '"type":"insert"'));
      const at = raw.indexOf('"traces":[');
      if (at >= 0) {
        const now = Date.now();
        if (now >= measureFrom) {
          const end = raw.indexOf(']', at);
          for (const t of raw.slice(at + 10, end).split(',')) propagation.add(now - Number(t));
        }
      }
      return;
    }
    const msg = JSON.parse(raw);
    if (msg.type === 'welcome' && !welcomed) {
      welcomed = true;
      connected.add(1);
      // Everyone starts typing at the same moment, after all VUs have joined.
      setTimeout(
        () => {
          typing = setInterval(() => {
            if (Date.now() >= stopAt) {
              clearInterval(typing);
              setTimeout(() => ws.close(), 3000); // drain in-flight deliveries
              return;
            }
            seq++;
            const op = {
              type: 'insert',
              id: { clock: seq, replica },
              seq,
              origin,
              char: 'x',
            };
            origin = op.id;
            ws.send(JSON.stringify({ type: 'ops', ops: [op], trace: Date.now() }));
            opsSent.add(1);
          }, 1000 / CPS);
        },
        Math.max(0, data.startAt - Date.now()),
      );
    }
  };

  ws.onerror = () => {
    connected.add(0);
  };
  ws.onclose = () => {
    check(welcomed, { 'joined the document': (w) => w });
  };
}

function countOccurrences(haystack, needle) {
  let count = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) {
    count++;
  }
  return count;
}

export function handleSummary(data) {
  const m = data.metrics;
  const p = m.propagation_ms ? m.propagation_ms.values : {};
  const result = {
    editors: EDITORS,
    instances: URLS.length,
    cps: CPS,
    durationS: DURATION_S,
    opsSent: m.ops_sent ? m.ops_sent.values.count : 0,
    opsReceived: m.ops_received ? m.ops_received.values.count : 0,
    deliveriesMeasured: p.count || 0,
    propagationMs: { p50: p.med, p90: p['p(90)'], p95: p['p(95)'], p99: p['p(99)'], max: p.max },
    connectedRate: m.connected ? m.connected.values.rate : 0,
  };
  const out = __ENV.OUT || `/scripts/results/k6-${String(EDITORS)}-editors.json`;
  return {
    stdout: `${JSON.stringify(result, null, 2)}\n`,
    [out]: `${JSON.stringify(result, null, 2)}\n`,
  };
}
