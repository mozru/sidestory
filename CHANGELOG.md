# Changelog

## 0.1.0 (unreleased)

First release.

- Free-form HTML explainers beside the editor, linked to the code both ways: move through the explainer and the editor shows and highlights the code; move the cursor and the explainer follows.
- Big systems: an overview explainer can point to detail explainers, which readers skip, peek at in place, or dive into and come back from, with a trail showing where they are.
- Readers keep their place in interactive explainers: switches, tabs, open `<details>` and typed text survive edits to the explainer. CSS `:target` works.
- Pin Anchors says why it left an anchor alone and lets you accept intended code changes; **Re-anchor Section to Selection** (also a button on sections whose code is lost or out of date) points a section at new code. Pin keeps the manifest's formatting.
- Live: edits to the code (saved or not) and to the explainer appear immediately, keeping your place, focus and anything you're typing.
- Sections follow code that moves, and say when it changed, needs a look, or can't be found.
- Theme-native: colors, fonts and high-contrast support come from your VS Code theme.
- Works in Restricted Mode, over Remote-SSH, WSL, Dev Containers, Codespaces and browser VS Code.
- Safe with untrusted repositories: explainer content can't run script, reach the network, read files outside the repository, or cover the panel's controls (see SECURITY.md).
- Interactive widgets (opt-in): React components in an explainer, written like Claude artifacts (Tailwind, shadcn/ui-style components, Recharts, D3, Motion, lucide-react, lodash), each in a sandboxed frame. They follow the steps, read the code their explainer points at, highlight lines, and reveal code when clicked; what the reader sets is kept. They run only in trusted workspaces, with `codeExplainer.widgets.enabled` on, after you agree in a VS Code dialog, and readers without them see each widget's fallback. Guide: `docs/WIDGETS.md`; boundary and accepted risks: `SECURITY.md`.
- Widget checking without running anything: diagnostics in the Problems panel, **Check Widgets**, and a standalone checker for Claude Code and scripts (`node dist/check.cjs <explainer-dir> [--json] [--types] [--pin]`), which can also pin anchors from the files on disk (asking before it pins code that widgets read). **Add Widget Types** adds declarations for `tsc` and IntelliSense.
