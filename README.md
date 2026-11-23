# pi-pause

Cooperative `/pause` and `/continue` for [Pi](https://pi.dev). Let the current model request or already-started tool work finish, then hold the agent at a safe boundary. Pending calls wait in memory; they are not blocked with fake errors or replayed.

## Install

Develop the package anywhere — it does **not** need to live in Pi's extensions directory.

```sh
# Local development checkout, available in all your Pi sessions:
pi install /absolute/path/to/pi-pause
```

In an existing **idle** Pi session, run `/reload`. A local package is loaded directly from its checkout, so editing the code and reloading picks up your changes.

To try it without installing:

```sh
pi -e ./src/index.ts
```

Install from GitHub:

```sh
pi install git:github.com/dervondenbergen/pi-pause
# Once a corresponding release tag exists, you can pin it with @v0.1.0.
```

The package is named `@dervondenbergen/pi-pause` and marked `"private": true` to prevent accidental npm publishing. Installation from GitHub or a local checkout is unaffected.

No build step or runtime npm dependencies are required. Pi supplies the extension API. Tested with `@earendil-works/pi-coding-agent` **1.6.0**; this package relies on its awaited event hooks and root-tool preflight semantics. Other versions need verification.

## Usage

1. Run `/pause` while Pi works (or while idle).
2. Wait for **⏸ Paused · /continue** at the right of the editor border before closing your laptop.
3. Later, reopen the laptop, let networking reconnect, and run `/continue` in the **same running Pi process**.

While work is draining, the **right side of the editor's top border** shows **Pausing… finishing current work**. At a safe gate it changes to **⏸ Paused · /continue**. This label persists while idle, with no duplicate footer or left-hand Working status. Narrow terminals get a shorter label. RPC/SDK clients without the TUI editor receive a single footer status instead.

- A model request already in progress finishes receiving its response. The response is persisted, but its new root tool calls wait.
- **A visible tool card does not mean execution has started.** Pi 1.6 emits `tool_execution_start` and marks the UI card as started during preflight, before the awaited `tool_call` gate. The first waiting tool can therefore be visible while paused without having run. An abort can give it an `Operation aborted` result without any tool side effects.
- A sequential tool batch can stop between calls.
- Tools already running in parallel finish together before the pause is confirmed.
- `/continue` during **Pausing…** cancels the pause request.
- `/continue` only releases the latch: it does not add a chat message or invent a new task.
- An idle pause also holds the next task before its model request.
- `Esc` still **aborts**, rather than pauses, a task. Waiting hooks release on abort. After that, `/continue` only unlocks the pause; send a normal prompt if you want new work.
- Prompt-cache warming decisions return `stop` while paused or pausing.

### Important limits

This is cooperative scheduling, not process suspension or a sandbox:

- **An already-started orchestrator such as `codemode` must finish, including its nested tool calls.** A script editing 40 files is one running root call and may take time. Holding its children could deadlock its parent. The UI keeps saying **Pausing…** until it drains.
- A tool already admitted through preflight can still start if another extension delays a later part of that preflight. In Pi's parallel mode, preflight happens before the whole batch starts. Pi only confirms **Paused** when this extension reaches a safe gate; `/pause` is a request, not an instantaneous execution barrier.
- Background shell processes, MCP connections, provider sockets, cache refreshes already started, and independent work launched by other extensions are not suspended. A long pause can expire external connections or credentials; this extension does not guarantee that providers reconnect successfully.
- New model calls, tool execution and compaction in the normal agent loop are gated. An in-flight request, active tool or manual compaction can take time to finish.
- Pending execution lives **in memory**. Closing the lid is fine; quitting Pi, crashing, rebooting or aborting loses the waiting call stack. A restored pause latch is **not** a restored task. The extension warns about this on restoration; check the workspace and send a normal prompt when needed.
- `/reload` requires an idle agent. A task held at a pause gate is still busy: `/continue` and let it finish, or use `Esc` to abort before reloading. Do not reload a paused active task expecting its continuation to survive.
- The TUI decorates the existing custom editor's render output, or uses Pi's `CustomEditor` when none was configured. Input handlers, keybindings, focus and base editor content are retained; cached render arrays are not mutated. The normal Working indicator is temporarily hidden during a pause and shown again on continue. Extensions replacing the editor after this package can displace the decoration.
- Interactive TUI and UI-enabled RPC/SDK sessions are supported. `/pause` is a no-op in non-interactive print/JSON mode, where there would be no way to issue `/continue`.

## Invisible diagnostics

Events use `pi.appendEntry("pi-pause", data)`, **not** `sendMessage` or hidden chat messages. They are persisted as `custom` session entries, with no registered renderer and no contribution to model context. They are diagnostic metadata, not secret/encrypted data; anyone with the session data may read them.

Recorded events include `pause_requested`, `paused`, `resumed`, `run_aborted`, `runtime_closed` and `pause_restored`. Data includes a schema version, ISO UTC timestamps, state, pause duration on resume, safe boundary and unfinished root call IDs when known. Tool arguments, file contents and credentials are not copied into these records. “Unfinished” includes prepared calls; it does not claim that a call is executing.

A debugging agent can inspect the raw session JSONL for these entries, e.g. to correlate a connection failure with an overnight pause. The last pause state is restored from the **active branch** on session start/reload, but pending execution is never reconstructed or replayed.

## Development and tests

Requires Node.js 22.19+.

```sh
npm ci --ignore-scripts
npm run check
```

Tests cover the latch, next-day timestamps, abort/shutdown, cache warming, compaction gates, restoration, right-aligned border layout, narrow widths, ANSI/wide characters, theme changes and cached render arrays. Integration tests use the **real Pi SDK and agent loop**, with deterministic fake model responses and harmless fixture tools (no API keys or paid model calls). Cases include 40 pending calls, a visible preflight tool card with zero executions, parallel draining, sequential edits, parallel preflight, nested tools and model-context exclusion. UI transport is stubbed in the automated SDK tests. The right-hand pause border was also smoke-tested in the real Pi CLI in a pseudo-terminal; overnight sleep/reconnect still warrants a manual test.

### Manual smoke test

In a disposable workspace, ask Pi to perform several harmless actions. Try `/pause` during a response, during a shell `sleep`, and while idle. Wait for **Paused**, verify no new root work starts, then `/continue`. Test `Esc` while paused, and check `/reload` only while idle. Do not first test this on important uncommitted work.

To remove a local installation:

```sh
pi remove /absolute/path/to/pi-pause
# Then /reload in idle sessions.
```
