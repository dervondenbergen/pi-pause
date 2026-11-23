import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import pauseExtension, { ENTRY_TYPE } from "../src/index.ts";
import type { PauseRecord } from "../src/pause-controller.ts";

type Handler = (event: any, ctx: ExtensionContext) => any;
function setup(hasUI = true, branch: unknown[] = [], mode: "rpc" | "tui" = "rpc") {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, { handler: (args: string, ctx: ExtensionContext) => Promise<void> }>();
  const entries: PauseRecord[] = [];
  let idle = true;
  const statuses: Array<string | undefined> = [];
  const visibility: boolean[] = [];
  const editor = { render: (width: number) => ["─".repeat(width), "input", "─".repeat(width)], invalidate() {} };
  const ctx = {
    hasUI, mode, isIdle: () => idle,
    sessionManager: { getBranch: () => branch },
    ui: {
      notify() {}, setStatus(_key: string, value?: string) { statuses.push(value); },
      setWorkingVisible(value: boolean) { visibility.push(value); },
      theme: { fg: (_token: string, text: string) => text },
      getEditorComponent: () => () => editor,
      setEditorComponent: (factory: any) => factory({ requestRender() {} }, {}, {}),
    },
  } as unknown as ExtensionContext;
  // This narrow fake tests only lifecycle wiring; integration.test.ts tests real execution.
  pauseExtension({
    on: (name: string, handler: Handler) => { handlers.set(name, handler); },
    registerCommand: (name: string, command: any) => { commands.set(name, command); },
    appendEntry: (type: string, data: PauseRecord) => { assert.equal(type, ENTRY_TYPE); entries.push(data); },
  } as unknown as ExtensionAPI);
  return {
    entries, ctx, statuses, visibility, editor,
    idle: (value: boolean) => { idle = value; },
    command: (name: string) => commands.get(name)!.handler("", ctx),
    event: (name: string, event: any = {}) => handlers.get(name)?.(event, ctx),
  };
}

test("TUI has a persistent right border label, with no duplicate footer or Working message", async () => {
  const h = setup(true, [], "tui");
  h.event("session_start");
  await h.command("pause");
  assert.match(h.editor.render(80)[0], /Paused · \/continue ─$/);
  assert.ok(h.statuses.every((value) => value === undefined));
  assert.equal(h.visibility.at(-1), false);
  h.event("agent_settled");
  assert.match(h.editor.render(80)[0], /Paused/);
  await h.command("continue");
  assert.equal(h.editor.render(80)[0], "─".repeat(80));
  assert.equal(h.visibility.at(-1), true);
  h.event("session_shutdown", { reason: "reload" });
});

test("cache warming stops during both pausing and paused", async () => {
  const h = setup();
  h.idle(false);
  await h.command("pause");
  assert.deepEqual(h.event("cache_warming_decision"), { action: "stop" });
  h.event("agent_settled");
  assert.deepEqual(h.event("cache_warming_decision"), { action: "stop" });
  await h.command("continue");
  assert.equal(h.event("cache_warming_decision"), undefined);
});

test("print / JSON mode cannot accidentally latch forever", async () => {
  const h = setup(false);
  await h.command("pause");
  await h.event("context");
  assert.equal(h.entries.length, 0);
});

test("compaction waits at the pause latch and cancellation releases it", async () => {
  const h = setup();
  const abort = new AbortController();
  await h.command("pause");
  const compact = h.event("session_before_compact", { signal: abort.signal });
  abort.abort();
  assert.deepEqual(await compact, { cancel: true });
});

test("shutdown releases blocked hooks and logs why, without a model message", async () => {
  const h = setup();
  await h.command("pause");
  const waiting = h.event("context");
  h.event("session_shutdown", { reason: "reload" });
  await waiting;
  assert.equal(h.entries.at(-1)?.event, "runtime_closed");
  assert.equal(h.entries.at(-1)?.reason, "reload");
});

test("restore uses the current branch, not an abandoned branch; resumed state stays running", async () => {
  const paused: PauseRecord = { version: 1, event: "paused", state: "paused", timestamp: "2026-01-01T20:00:00Z" };
  const h = setup(true, [{ type: "custom", customType: ENTRY_TYPE, data: paused }]);
  h.event("session_start");
  assert.equal(h.entries[0].event, "pause_restored");
  assert.equal(h.entries.at(-1)?.state, "paused");
  await h.command("continue");
  const running = setup(true, [{ type: "custom", customType: ENTRY_TYPE, data: h.entries.at(-1) }]);
  running.event("session_start");
  await running.event("context");
  assert.equal(running.entries.length, 0);
});
