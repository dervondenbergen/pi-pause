# Changelog

## [0.1.1]

- Show a persistent, right-aligned pause status in the editor's top border, including while idle.
- Remove duplicate TUI footer and Working status during pauses; retain a single footer fallback for RPC clients.
- Preserve the existing editor's input handlers and render caches, and adapt labels to narrow terminals.
- Document Pi's preflight tool cards: a visible card can precede execution and wait at the pause gate.
- Add regression coverage for visible-but-unexecuted tools, editor lifecycle and border rendering.

## [0.1.0]

- Add cooperative `/pause` and `/continue`, safe-boundary gates and model-invisible session diagnostics.
- Add SDK integration tests, GitHub installation instructions and CI.
