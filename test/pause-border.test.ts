import assert from "node:assert/strict";
import { test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { decoratePauseEditor, pauseBorder } from "../src/pause-border.ts";
import type { PauseState } from "../src/pause-controller.ts";

const plain = (text: string) => text;

test("pause status is right-aligned with one trailing border column", () => {
  const line = pauseBorder("─".repeat(80), 80, "paused", plain);
  assert.equal(visibleWidth(line), 80);
  assert.ok(line.endsWith(" ⏸ Paused · /continue ─"));
  assert.ok(!line.startsWith(" ⏸"));
});

test("running state leaves the existing editor border exactly unchanged", () => {
  const border = "\x1b[36m── Working ──────────────────\x1b[0m";
  assert.equal(pauseBorder(border, 40, "running", plain), border);
});

test("both paused and pausing fit tiny/narrow widths and ANSI/CJK prefixes", () => {
  for (const state of ["paused", "pausing"] as const) {
    for (let width = 0; width <= 120; width++) {
      const line = pauseBorder("\x1b[32m── 中文 left border " + "─".repeat(120) + "\x1b[0m", width, state,
        (s) => `\x1b[36m${s}\x1b[0m`);
      assert.ok(visibleWidth(line) <= width, `${state} overflow at ${width}: ${visibleWidth(line)}`);
      assert.equal(visibleWidth(line), width);
    }
  }
});

test("decorator never mutates cached lines; label works while idle and restores on continue", () => {
  const cached = ["─".repeat(80), "unchanged editor input", "─".repeat(80)];
  let state: PauseState = "running";
  let invalidations = 0;
  const editor = { render: (_width: number) => cached, invalidate: () => { invalidations++; }, handleInput: (_data: string) => {} };
  const originalRender = editor.render;
  const originalInput = editor.handleInput;
  const cleanup = decoratePauseEditor(editor, () => state, plain);
  assert.equal(editor.render(80), cached);
  state = "paused";
  const paused = editor.render(80);
  assert.match(paused[0], /Paused/);
  assert.equal(cached[0], "─".repeat(80));
  assert.equal(paused[1], cached[1]);
  assert.equal(paused[2], cached[2]);
  assert.equal(editor.handleInput, originalInput);
  state = "running";
  assert.equal(editor.render(80), cached);
  cleanup();
  assert.equal(editor.render, originalRender);
  assert.equal(invalidations, 1);
});

test("theme colors are recomputed at render time and resizing does not retain an old label", () => {
  let color = "36";
  const editor = { render: (width: number) => ["─".repeat(width)], invalidate() {} };
  decoratePauseEditor(editor, () => "paused", (text) => `\x1b[${color}m${text}\x1b[0m`);
  assert.ok(editor.render(80)[0].includes("\x1b[36m"));
  color = "35";
  const narrow = editor.render(15)[0];
  assert.ok(narrow.includes("\x1b[35m"));
  assert.ok(!narrow.includes("\x1b[36m"));
  assert.equal(visibleWidth(narrow), 15);
  assert.match(stripTerminalSequences(narrow), /Paused/);
});
