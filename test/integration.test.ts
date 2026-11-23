import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createAssistantMessageEventStream, type AssistantMessage, type TranscriptContext } from "@earendil-works/pi-ai";
import { getModel } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionFactory, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import pauseExtension, { ENTRY_TYPE } from "../src/index.ts";
import type { PauseRecord } from "../src/pause-controller.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 1000; i++) {
    if (check()) return;
    await new Promise((r) => setTimeout(r, 2));
  }
  assert.fail("Timed out waiting for condition");
}
function message(calls: number | string[] = 0): AssistantMessage {
  const ids = typeof calls === "number" ? Array.from({ length: calls }, (_, i) => `call-${i}`) : calls;
  return {
    role: "assistant", api: "anthropic-messages", provider: "anthropic", model: "claude-sonnet-4-5",
    content: ids.length ? ids.map((id) => ({ type: "toolCall" as const, id, name: "fixture", arguments: {} })) : [{ type: "text", text: "Done" }],
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: ids.length ? "toolUse" : "stop", timestamp: Date.now(),
  };
}

async function harness(t: TestContext, fixtures?: ExtensionFactory, manager?: SessionManager) {
  const dir = await mkdtemp(join(tmpdir(), "pi-pause-test-"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [pauseExtension, ...(fixtures ? [fixtures] : [])],
    systemPromptOverride: () => "Test harness. Never access the network.",
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const runtime = await ModelRuntime.create({ authPath: join(dir, "auth.json"), modelsPath: join(dir, "models.json"), refreshOnCreate: false });
  await runtime.setRuntimeApiKey("anthropic", "test-key-not-real");
  const { session } = await createAgentSession({
    cwd: dir, agentDir: dir, resourceLoader: loader, modelRuntime: runtime,
    model: getModel("anthropic", "claude-sonnet-4-5"), thinkingLevel: "off",
    sessionManager: manager ?? SessionManager.inMemory(dir), settingsManager: settings, tools: fixtures ? ["fixture", "child"] : [],
  });
  const errors: unknown[] = [];
  const ui = { status: undefined as string | undefined, working: undefined as string | undefined };
  // Only UI transport is stubbed; loading, commands, event ordering, tool batches,
  // persistence and cancellation all use the real Pi SDK and real agent loop.
  const uiContext = new Proxy({
    setStatus: (_key: string, text: string | undefined) => { ui.status = text; },
    setWorkingMessage: (text?: string) => { ui.working = text; },
    setWorkingIndicator: () => {},
    notify: () => {},
  }, { get: (target, key) => Reflect.get(target, key) ?? (() => {}) }) as unknown as ExtensionUIContext;
  await session.bindExtensions({ mode: "tui", uiContext, onError: (e) => errors.push(e) });
  if (fixtures) session.setActiveToolsByName(session.getAllTools().filter((t) => t.sourceInfo.source !== "builtin").map((t) => t.name));
  assert.equal(session.isIdle, true);
  const requests: TranscriptContext[] = [];
  const responses: Array<Promise<AssistantMessage>> = [];
  session.agent.streamFunction = (_model, context, options) => {
    const stream = createAssistantMessageEventStream();
    // Real providers honor the aborted signal before making a network request.
    if (options?.signal?.aborted) {
      const aborted = { ...message(), stopReason: "aborted" as const, errorMessage: "Aborted" };
      stream.push({ type: "error", reason: "aborted", error: aborted });
      stream.end(aborted);
      return stream;
    }
    requests.push(structuredClone(context));
    const response = responses.shift();
    assert.ok(response, "Unexpected model request");
    void response.then((m) => { stream.push({ type: "done", reason: m.stopReason === "toolUse" ? "toolUse" : "stop", message: m }); stream.end(m); });
    return stream;
  };
  t.after(async () => {
    await session.abort();
    session.dispose();
    await rm(dir, { recursive: true, force: true });
    assert.deepEqual(errors, [], "No swallowed extension errors");
  });
  return {
    session, ui, requests,
    respond: (m: AssistantMessage | Promise<AssistantMessage>) => responses.push(Promise.resolve(m)),
    records: () => session.sessionManager.getEntries().filter((e) => e.type === "custom" && e.customType === ENTRY_TYPE).map((e) => (e as { data: PauseRecord }).data),
  };
}

test("real SDK: pause a response with 40 calls; persist response, execute zero, then resume exactly once", { timeout: 15000 }, async (t) => {
  const executed: string[] = [];
  const h = await harness(t, (pi) => {
    pi.registerTool({ name: "fixture", label: "Fixture", description: "Test", parameters: Type.Object({}),
      async execute(id) { executed.push(id); return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  });
  const response = deferred<AssistantMessage>();
  h.respond(response.promise);
  h.respond(message());
  const run = h.session.prompt("Make 40 edits");
  await until(() => h.requests.length === 1);
  await h.session.prompt("/pause");
  assert.match(h.ui.status!, /Pausing/);
  response.resolve(message(40));
  await until(() => h.ui.status?.startsWith("Paused") === true);
  await tick();
  assert.equal(executed.length, 0);
  assert.equal(h.requests.length, 1);
  assert.ok(h.session.sessionManager.getEntries().some((e) => e.type === "message" && e.message.role === "assistant"));
  assert.equal(h.records().find((r) => r.event === "paused")?.unfinishedToolCallIds?.length, 40);
  await h.session.prompt("/continue");
  await run;
  assert.equal(executed.length, 40);
  assert.equal(new Set(executed).size, 40);
  assert.equal(h.requests.length, 2);
  assert.equal(h.ui.status, undefined);
  const contextText = JSON.stringify(h.requests);
  assert.ok(!contextText.includes("pause_requested"));
  assert.ok(!contextText.includes("/pause"));
  assert.ok(!contextText.includes("/continue"));
  assert.deepEqual(h.records().map((r) => r.event), ["pause_requested", "paused", "resumed"]);
});

test("real SDK: already-running parallel tools drain; no next request before continue", { timeout: 15000 }, async (t) => {
  const releases = [deferred<void>(), deferred<void>()];
  let started = 0;
  const h = await harness(t, (pi) => {
    pi.registerTool({ name: "fixture", label: "Fixture", description: "Test", parameters: Type.Object({}),
      async execute() { const i = started++; await releases[i].promise; return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  });
  h.respond(message(2)); h.respond(message());
  const run = h.session.prompt("Two tools");
  await until(() => started === 2);
  await h.session.prompt("/pause");
  releases[0].resolve();
  await tick();
  assert.match(h.ui.status!, /Pausing/);
  releases[1].resolve();
  await until(() => h.ui.status?.startsWith("Paused") === true);
  assert.equal(h.requests.length, 1);
  await h.session.prompt("/continue");
  await run;
  assert.equal(h.requests.length, 2);
});

test("real SDK: idle pause stops the next request and Esc does not hang", { timeout: 15000 }, async (t) => {
  const h = await harness(t);
  await h.session.prompt("/pause");
  assert.match(h.ui.status!, /Paused/, JSON.stringify(h.records()));
  const run = h.session.prompt("Do not call model yet");
  await tick();
  assert.equal(h.requests.length, 0);
  await h.session.abort();
  await run;
  assert.equal(h.requests.length, 0);
  await h.session.prompt("/continue");
  assert.equal(h.requests.length, 0, "Continue must not invent a task after Esc");
});

test("real SDK: nested calls of an active orchestrator drain without deadlock", { timeout: 15000 }, async (t) => {
  const release = deferred<void>();
  let parentStarted = false;
  let childExecuted = false;
  const h = await harness(t, (pi) => {
    pi.registerTool({ name: "child", label: "Child", description: "Test child", parameters: Type.Object({}),
      async execute() { childExecuted = true; return { content: [{ type: "text", text: "child ok" }], details: {} }; } });
    pi.registerTool({ name: "fixture", label: "Fixture", description: "Orchestrator", parameters: Type.Object({}),
      async execute(_id, _args, _signal, _update, ctx) {
        parentStarted = true; await release.promise;
        const result = await ctx.executeTool("child", {});
        assert.equal(result.isError, false);
        return { content: [{ type: "text", text: "parent ok" }], details: {} };
      } });
  });
  h.respond(message(1)); h.respond(message());
  const run = h.session.prompt("Run orchestrator");
  await until(() => parentStarted);
  await h.session.prompt("/pause");
  release.resolve();
  await until(() => h.ui.status?.startsWith("Paused") === true);
  assert.equal(childExecuted, true);
  assert.equal(h.requests.length, 1);
  await h.session.prompt("/continue"); await run;
});

test("real SDK: sequential batch pauses between tools, without replaying the finished edit", { timeout: 15000 }, async (t) => {
  const executed: string[] = [];
  let pause: () => Promise<void>;
  const h = await harness(t, (pi) => {
    pi.registerTool({ name: "fixture", label: "Fixture", description: "Sequential test", executionMode: "sequential", parameters: Type.Object({}),
      async execute(id) {
        executed.push(id);
        if (executed.length === 1) await pause();
        return { content: [{ type: "text", text: "ok" }], details: {} };
      } });
  });
  pause = () => h.session.prompt("/pause");
  h.respond(message(3)); h.respond(message());
  const run = h.session.prompt("Three sequential edits");
  await until(() => h.ui.status?.startsWith("Paused") === true);
  assert.deepEqual(executed, ["call-0"]);
  assert.equal(h.records().find((r) => r.event === "paused")?.boundary, "before_tool_call");
  await h.session.prompt("/continue"); await run;
  assert.deepEqual(executed, ["call-0", "call-1", "call-2"]);
});

test("real SDK: pause during parallel preflight does not deadlock on prepared siblings", { timeout: 15000 }, async (t) => {
  const preflight = deferred<void>();
  let waiting = false;
  let executed = 0;
  const h = await harness(t, (pi) => {
    pi.on("tool_call", async (event) => {
      if (event.toolCallId === "call-1") { waiting = true; await preflight.promise; }
    });
    pi.registerTool({ name: "fixture", label: "Fixture", description: "Test", parameters: Type.Object({}),
      async execute() { executed++; return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  });
  h.respond(message(3)); h.respond(message());
  const run = h.session.prompt("Parallel preflight");
  await until(() => waiting);
  await h.session.prompt("/pause");
  preflight.resolve();
  await until(() => h.ui.status?.startsWith("Paused") === true);
  assert.equal(executed, 0);
  await h.session.prompt("/continue"); await run;
  assert.equal(executed, 3);
});

test("real SDK: continue during an in-flight response cancels the pause request", { timeout: 15000 }, async (t) => {
  let executed = 0;
  const h = await harness(t, (pi) => {
    pi.registerTool({ name: "fixture", label: "Fixture", description: "Test", parameters: Type.Object({}),
      async execute() { executed++; return { content: [{ type: "text", text: "ok" }], details: {} }; } });
  });
  const response = deferred<AssistantMessage>();
  h.respond(response.promise); h.respond(message());
  const run = h.session.prompt("Response still pending");
  await until(() => h.requests.length === 1);
  await h.session.prompt("/pause");
  await h.session.prompt("/continue");
  response.resolve(message(1));
  await run;
  assert.equal(executed, 1);
  assert.deepEqual(h.records().map((r) => r.event), ["pause_requested", "resumed"]);
});

test("real SDK: restore a pause latch into a fresh runtime without inventing a continuation", { timeout: 15000 }, async (t) => {
  const manager = SessionManager.inMemory();
  manager.appendCustomEntry(ENTRY_TYPE, {
    version: 1, event: "paused", state: "paused", timestamp: "2026-01-01T20:00:00Z",
  } satisfies PauseRecord);
  const h = await harness(t, undefined, manager);
  assert.match(h.ui.status!, /Paused/);
  await h.session.prompt("/continue");
  assert.equal(h.requests.length, 0);
  h.respond(message());
  await h.session.prompt("New task");
  assert.equal(h.requests.length, 1);
  assert.ok(!JSON.stringify(h.requests).includes("pause_restored"));
});
