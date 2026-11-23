import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PauseController, type PauseRecord } from "./pause-controller.ts";

export const ENTRY_TYPE = "pi-pause";

export default function pauseExtension(pi: ExtensionAPI) {
  let uiContext: ExtensionContext | undefined;
  const unfinished = new Set<string>();
  let ownsWorkingUI = false;

  const render = () => {
    const ctx = uiContext;
    if (!ctx?.hasUI) return;
    if (controller.state === "running") {
      ctx.ui.setStatus(ENTRY_TYPE, undefined);
      if (ownsWorkingUI) {
        ctx.ui.setWorkingMessage();
        ctx.ui.setWorkingIndicator();
        ownsWorkingUI = false;
      }
      return;
    }
    ownsWorkingUI = true;
    const paused = controller.state === "paused";
    const text = paused
      ? "Paused — /continue to resume"
      : "Pausing… finishing current request / running tools";
    ctx.ui.setStatus(ENTRY_TYPE, text);
    ctx.ui.setWorkingMessage(text);
    ctx.ui.setWorkingIndicator(paused ? { frames: ["⏸"] } : undefined);
  };

  const controller = new PauseController(
    (record) => pi.appendEntry(ENTRY_TYPE, record),
    render,
  );
  const useContext = (ctx: ExtensionContext) => { uiContext = ctx; };
  const gate = async (boundary: string, ctx: ExtensionContext, signal = ctx.signal) => {
    useContext(ctx);
    await controller.gate(boundary, signal, [...unfinished]);
  };

  pi.registerCommand("pause", {
    description: "Pause before new tool calls/requests; let started work finish.",
    handler: async (_args, ctx) => {
      useContext(ctx);
      if (!ctx.hasUI) return; // No interactive way to release a latch in print/JSON mode.
      if (!controller.request(ctx.isIdle(), [...unfinished])) render();
    },
  });
  pi.registerCommand("continue", {
    description: "Release the pause without injecting a message or restarting tools.",
    handler: async (_args, ctx) => {
      useContext(ctx);
      if (!controller.resume() && ctx.hasUI) ctx.ui.notify("Pi is not paused.", "info");
    },
  });

  pi.on("session_start", (_event, ctx) => {
    useContext(ctx);
    if (!ctx.hasUI) return;
    const last = ctx.sessionManager.getBranch().findLast(
      (entry) => entry.type === "custom" && entry.customType === ENTRY_TYPE,
    );
    if (last?.type === "custom") {
      const data = last.data as Partial<PauseRecord> | undefined;
      if (data?.version === 1 && data.timestamp && (data.state === "paused" || data.state === "pausing")) {
        controller.restore(data as PauseRecord);
        ctx.ui.notify("Pause restored. Pending execution cannot survive a process restart; /continue releases the pause only.", "warning");
      }
    }
  });

  pi.on("context", async (_event, ctx) => { await gate("before_model_request", ctx); });

  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    for (const part of event.message.content) {
      if (part.type === "toolCall") unfinished.add(part.id);
    }
    // Do not hold message_end: Pi persists the response AFTER this notification.
    // The root tool_call gate below suspends execution after persistence instead.
  });

  pi.on("tool_call", async (event, ctx) => {
    // Nested calls belong to already-started work (e.g. a codemode script).
    // Holding them would prevent the parent from draining and can deadlock.
    if (event.parentToolCallId) return;
    // In Pi 1.6, root parallel calls are preflighted BEFORE any sibling executes.
    // A latch here holds the batch, not a fictitious running sibling.
    await gate("before_tool_call", ctx);
  });
  pi.on("tool_execution_end", (event) => {
    if (!event.parentToolCallId) unfinished.delete(event.toolCallId);
  });
  pi.on("turn_end", async (_event, ctx) => { await gate("after_tool_batch", ctx); });
  pi.on("session_before_compact", async (event, ctx) => {
    await gate("before_compaction", ctx, event.signal);
    if (event.signal.aborted) return { cancel: true };
  });
  pi.on("cache_warming_decision", () => {
    if (controller.state !== "running") return { action: "stop" as const };
  });
  pi.on("agent_settled", (_event, ctx) => {
    useContext(ctx);
    unfinished.clear();
    controller.settle("agent_settled");
    render(); // Pi may have removed the working row; the footer remains visible.
  });
  pi.on("session_shutdown", (event, ctx) => {
    useContext(ctx);
    controller.close(event.reason);
    if (ctx.hasUI && ownsWorkingUI) {
      ctx.ui.setStatus(ENTRY_TYPE, undefined);
      ctx.ui.setWorkingMessage();
      ctx.ui.setWorkingIndicator();
    }
  });
}
