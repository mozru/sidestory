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
