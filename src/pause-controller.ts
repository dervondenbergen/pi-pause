export type PauseState = "running" | "pausing" | "paused";

export interface PauseRecord {
  version: 1;
  event: string;
  timestamp: string;
  state: PauseState;
  requestedAt?: string;
  pausedAt?: string;
  durationMs?: number;
  boundary?: string;
  unfinishedToolCallIds?: string[];
  reason?: string;
}

/** Process-local latch. It never cancels work, fabricates tool results or starts a turn. */
export class PauseController {
  state: PauseState = "running";
  requestedAt?: string;
  pausedAt?: string;
  private closed = false;
  private waiters = new Set<() => void>();

  constructor(
    private readonly record: (record: PauseRecord) => void,
    private readonly changed: () => void,
    private readonly now = () => Date.now(),
  ) {}

  private emit(event: string, extra: Partial<PauseRecord> = {}) {
    this.record({
      version: 1, event, timestamp: new Date(this.now()).toISOString(),
      state: this.state, requestedAt: this.requestedAt, pausedAt: this.pausedAt,
      ...extra,
    });
    this.changed();
  }

  request(idle: boolean, unfinishedToolCallIds: string[] = []) {
    if (this.closed || this.state !== "running") return false;
    this.requestedAt = new Date(this.now()).toISOString();
    this.state = "pausing";
    this.emit("pause_requested", { unfinishedToolCallIds });
    if (idle) this.settle("idle", unfinishedToolCallIds);
    return true;
  }

  settle(boundary: string, unfinishedToolCallIds: string[] = []) {
    if (this.closed || this.state !== "pausing") return;
    this.state = "paused";
    this.pausedAt ??= new Date(this.now()).toISOString();
    this.emit("paused", { boundary, unfinishedToolCallIds });
  }

  /** Wait only at a boundary known to have no executing root tools/model stream. */
  async gate(boundary: string, signal?: AbortSignal, unfinishedToolCallIds: string[] = []) {
    while (!this.closed && this.state !== "running" && !signal?.aborted) {
      this.settle(boundary, unfinishedToolCallIds);
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener("abort", wake);
          this.waiters.delete(wake);
          resolve();
        };
        this.waiters.add(wake);
        signal?.addEventListener("abort", wake, { once: true });
        if (signal?.aborted || this.closed || this.state === "running") wake();
      });
    }
    // Esc must release the hook, but is NOT a request to continue the task.
    if (!this.closed && signal?.aborted && this.state === "paused") {
      this.state = "pausing";
      this.emit("run_aborted", { boundary });
    }
  }

  resume() {
    if (this.closed || this.state === "running") return false;
    const durationMs = this.pausedAt ? Math.max(0, this.now() - Date.parse(this.pausedAt)) : undefined;
    this.state = "running";
    this.emit("resumed", { durationMs });
    this.requestedAt = undefined;
    this.pausedAt = undefined;
    for (const wake of [...this.waiters]) wake();
    return true;
  }

  restore(record: PauseRecord) {
    if (record.state === "running" || this.closed) return;
    this.state = "pausing";
    this.requestedAt = record.requestedAt ?? record.timestamp;
    this.pausedAt = record.pausedAt;
    this.emit("pause_restored", { reason: "Pause latch restored; pending execution is process-local." });
    this.settle("session_start");
  }

  close(reason: string) {
    if (this.closed) return;
    this.closed = true;
    if (this.state !== "running") this.emit("runtime_closed", { reason });
    for (const wake of [...this.waiters]) wake();
  }
}
