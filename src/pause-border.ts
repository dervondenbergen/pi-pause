import { CustomEditor, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, truncateToWidth, visibleWidth, type Component } from "@earendil-works/pi-tui";
import type { PauseState } from "./pause-controller.ts";

type Color = (text: string) => string;

/** Preserve the left border and put a width-aware status at the right edge. */
export function pauseBorder(line: string, width: number, state: PauseState, color: Color): string {
  if (state === "running") return line;
  if (width <= 0) return "";
  const labels = state === "paused"
    ? [" ⏸ Paused · /continue ", " ⏸ Paused ", " ⏸ "]
    : [" Pausing… finishing current work ", " Pausing… ", " … "];
  const label = labels.find((text) => visibleWidth(text) + 3 <= width);
  if (!label) return color(truncateToWidth(state === "paused" ? "⏸" : "…", width, "", true));
  const prefixWidth = width - visibleWidth(label) - 1;
  const prefix = sliceByColumn(line, 0, prefixWidth, true);
  return prefix + color("─".repeat(Math.max(0, prefixWidth - visibleWidth(prefix))) + label + "─");
}

/** Decorate only render output, leaving input, shortcuts and focus on the same editor. */
export function decoratePauseEditor<T extends Component>(editor: T, state: () => PauseState, color: Color) {
  const originalRender = editor.render;
  const render = function (this: T, width: number) {
    const lines = originalRender.call(this, width);
    if (state() === "running" || lines.length === 0) return lines;
    // Built-in editors may return cached arrays. Never mutate those arrays.
    const decorated = [...lines];
    decorated[0] = pauseBorder(lines[0], width, state(), color);
    return decorated;
  };
  editor.render = render;
  return () => {
    if (editor.render === render) editor.render = originalRender;
    editor.invalidate();
  };
}

export interface PauseBorderHandle {
  refresh(): void;
  dispose(): void;
}

export function installPauseBorder(ctx: ExtensionContext, state: () => PauseState): PauseBorderHandle {
  const previous = ctx.ui.getEditorComponent();
  let refresh = () => {};
  let disposed = false;
  const cleanups: Array<() => void> = [];
  ctx.ui.setEditorComponent((tui, theme, keys) => {
    const editor = previous?.(tui, theme, keys)
      ?? new CustomEditor(tui, theme, keys, { embedWorkingStatus: true });
    if (!disposed) {
      cleanups.push(decoratePauseEditor(editor, state, (text) => ctx.ui.theme.fg("accent", text)));
      refresh = () => { editor.invalidate(); tui.requestRender(); };
    }
    return editor;
  });
  return {
    refresh: () => { if (!disposed) refresh(); },
    dispose: () => {
      disposed = true;
      for (const cleanup of cleanups) cleanup();
      cleanups.length = 0;
      refresh = () => {};
    },
  };
}
