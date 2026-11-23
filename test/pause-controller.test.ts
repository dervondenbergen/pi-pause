import assert from "node:assert/strict";
import { test } from "node:test";
import { PauseController, type PauseRecord } from "../src/pause-controller.ts";

function setup() {
  const records: PauseRecord[] = [];
  let now = Date.parse("2026-01-01T22:00:00Z");
  const controller = new PauseController((r) => records.push(r), () => {}, () => now);
  return { controller, records, advance: (ms: number) => { now += ms; } };
}

test("idle pause is immediate, idempotent and logs a next-day duration", () => {
  const { controller: c, records, advance } = setup();
  assert.equal(c.request(true), true);
  assert.equal(c.state, "paused");
  assert.equal(c.request(true), false);
  advance(12 * 60 * 60 * 1000);
  assert.equal(c.resume(), true);
  assert.equal(c.resume(), false);
  assert.deepEqual(records.map((r) => r.event), ["pause_requested", "paused", "resumed"]);
  assert.equal(records[2].durationMs, 43_200_000);
  assert.equal(records[2].timestamp, "2026-01-02T10:00:00.000Z");
});

test("running work stays pausing until a safe boundary; gates release together", async () => {
  const { controller: c, records } = setup();
  c.request(false, ["edit-1"]);
  assert.equal(c.state, "pausing");
  let released = 0;
  const a = c.gate("before_tool_call").then(() => released++);
  const b = c.gate("before_model_request").then(() => released++);
  await Promise.resolve();
  assert.equal(released, 0);
  assert.equal(c.state, "paused");
  c.resume();
  await Promise.all([a, b]);
  assert.equal(released, 2);
  assert.equal(records.filter((r) => r.event === "paused").length, 1);
});

test("continue while still pausing cancels only the pause request", async () => {
  const { controller: c } = setup();
  c.request(false);
  c.resume();
  await c.gate("next_boundary");
  assert.equal(c.state, "running");
});

test("Esc releases a waiting hook without authorizing continuation", async () => {
  const { controller: c, records } = setup();
  const abort = new AbortController();
  c.request(false);
  const gate = c.gate("before_tool_call", abort.signal);
  abort.abort();
  await gate;
  assert.equal(c.state, "pausing");
  c.settle("agent_settled");
  assert.equal(c.state, "paused");
  assert.ok(records.some((r) => r.event === "run_aborted"));
});

test("already aborted signals never hang", async () => {
  const { controller: c } = setup();
  c.request(false);
  await c.gate("context", AbortSignal.abort());
  assert.equal(c.state, "pausing");
});

test("shutdown releases hooks without logging a false resume", async () => {
  const { controller: c, records } = setup();
  c.request(false);
  const waiting = c.gate("context");
  c.close("reload");
  c.close("reload");
  await waiting;
  assert.equal(records.at(-1)?.event, "runtime_closed");
  assert.equal(records.filter((r) => r.event === "runtime_closed").length, 1);
  assert.equal(c.resume(), false);
});

test("restores only the latch, not an executable task", () => {
  const { controller: c, records } = setup();
  c.request(true);
  const restoredRecords: PauseRecord[] = [];
  const next = new PauseController((r) => restoredRecords.push(r), () => {});
  next.restore(records.at(-1)!);
  assert.equal(next.state, "paused");
  assert.equal(next.requestedAt, c.requestedAt);
  assert.equal(restoredRecords[0].event, "pause_restored");
});
