// In-memory liveness tracker for the long-running tick loops (digest /
// recurring / email / alerts / gcal). Each scheduler calls recordTick
// from its fire callback; /api/health and /api/metrics read the map.
//
// Design notes:
//   - Process-local. Timestamps reset on restart, which is the right
//     behavior for a "is the scheduler currently alive?" probe.
//   - No lock — the V8 single thread serializes the writes.
//   - We track LAST tick, not error count or latency. Adding either is
//     a one-liner here when an operator asks for it.

const ticks = new Map(); // schedulerName → ISO timestamp string

export function recordTick(name) {
  ticks.set(name, new Date().toISOString());
}

export function getTick(name) {
  return ticks.get(name) ?? null;
}

export function getAllTicks() {
  return Object.fromEntries(ticks);
}

// For tests that want a deterministic state.
export function _resetTicksForTests() {
  ticks.clear();
}
