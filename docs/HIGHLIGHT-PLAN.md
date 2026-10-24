# Syntax highlighting for code blocks: plan

`<pre><code class="language-python">` blocks in explainers are plain monospace today, next to an editor that is colored. This adds highlighting in the reader's own VS Code theme without giving explainer content any new power.

## 1. Choice: Shiki (TextMate grammars, JavaScript regex engine) in a worker in the extension host

| | Shiki in the extension host | highlight.js / Prism in the webview |
|---|---|---|
| Grammars | VS Code's own TextMate grammars: the same tokens the editor makes | Their own lexers: different token boundaries and categories |
| Colors | The active theme's `tokenColors`, scope for scope: the same colors as the editor | ~15 generic classes (keyword, string…) mapped to CSS variables; VS Code exposes no token colors as CSS variables, so the mapping would be guessed (`--vscode-symbolIcon-*`, `--vscode-debugTokenExpression-*`) and never match the editor |
| CSP | Runs in Node: no CSP, no eval either (the JS engine compiles grammar regexes with `new RegExp`) | Must run in the panel: more panel script, more code that touches content |
| Panel cost | None: the panel gets lengths and colors | Tokenizing on the panel's main thread on every live update |
| Size | ~165 KB engine (minified) + grammars, ~270 KB in the .vsix | ~40–100 KB |

Shiki wins on the one thing this feature is for: looking like the editor beside it. The size is affordable (§6). The WASM Oniguruma engine isn't needed: the JS engine handles every grammar we ship (`forgiving: true` leaves an unsupported pattern unmatched rather than failing the grammar).

Superseded by §10: grammars now come from the installed extensions (VS Code's built-in language extensions and whatever the reader added), tokenized by `vscode-textmate` with VS Code's own Oniguruma WASM. §2–§5 still hold, with "grammar id" read as "language name, resolved by the host" (§10.2); §6's shipped grammars and alias table are gone.

## 2. Data flow

1. **Panel** (`src/webview/highlight.ts`), on every render, before the morph: finds code blocks in the sanitized tree (`pre > code` or a `pre` with no element children; language from a `language-x` / `lang-x` class on the `code`, else on the `pre`). Only blocks whose content is **text only** are highlighted: author markup inside code (`<mark>`, `<b>`) is left exactly as written. The language name goes through a fixed alias table (`src/shared/highlight-languages.ts`, a `Map`, so `language-constructor` or `language-__proto__` find nothing); unknown languages stay plain.
2. **The incoming tree stays plain** (measured: morphing ~4,800 identical spans costs ~44 ms per render, against 0.4 ms plain). Instead, the morph is told to **leave a live highlighted block alone** (idiomorph's `beforeNodeMorphed` returns false) when it is colored (fully or partly) and the incoming block has the same text (compared with the text the panel colored, kept beside the element, not the live `textContent`), language and attributes (the panel's own `data-cx-*` attributes left out of the comparison): unchanged blocks cost one string comparison. Blocks colored under an older theme are kept too, and recolored in place when the new theme's runs arrive, so typing during a theme switch doesn't flash every block plain. After the morph, every live block that isn't fully colored under the current theme (plain, partly colored, or an older theme) is looked up by `(theme, language, text)` in the panel's cache and colored in place; misses are sent in one `highlight` message per render: `{blocks: [{id, lang, code}]}`.
   - **The block being edited doesn't flash plain.** Before the morph replaces a highlighted block's text, the panel keeps its old text and runs; after the morph it reuses the runs for the lines before the first changed line (TextMate tokenizes strictly top to bottom, so they're exactly right) (cut at the end of the last unchanged line, newline included) and leaves the rest a plain text node until the reply arrives. Such a block is "partly colored": it is kept by the morph like any colored block while its text is unchanged, and is requested again after every render until it's complete (the host joins a request for a block already being tokenized to that job rather than queueing it twice), so a request replaced by a newer one, or a patch deferred by a selection, is never lost. (When idiomorph replaces the block instead of morphing it, e.g. sections reordered, it flashes plain once.) The "add up to exactly" rule below applies to host results, not to this carried prefix.
   - Highlighted blocks carry `data-cx-hl="<token>"`, a random value per panel (as the detail boxes' `data-cx-box` is), so author HTML can't pass for one; the sanitizer also removes any author `data-cx-hl` (the one sanitizer change). The panel decides "text only" on the freshly sanitized tree, which never holds its own spans.
   - Comments inside a text-only `<code>` (`<!-- … -->`) are dropped when it's colored; they aren't shown anyway.
3. **Extension host** (`src/extension/highlight/`): validates the message (zod: known language ids only; caps in §5), answers from its own LRU cache, and queues the rest for the **highlight worker** (`dist/highlight-worker.cjs`, a `worker_thread` like the widget compiler's).
4. The worker loads each grammar the first time it's needed (`dist/highlight/grammars/<id>.json`, with its embedded languages), tokenizes with Shiki's `codeToTokensBase`, and returns, per block, **run lengths and style indexes**: `[len, style, len, style, …]` covering the whole text, plus the theme's **palette** (`style` → `{color, bold, italic, underline, strikethrough}`; index 0 is "default: no span", used for every token in the theme's foreground with no font style).
5. The host replies `{type: 'highlighted', theme, palette, blocks: [{id, runs} | {id, runs: null}]}` (`null`: too large, timed out, failed: stays plain and isn't asked again for that text and theme).
6. The panel caches the runs (numbers only, never DOM), and remembers `runs: null` answers by `(theme, lang, text)` so it doesn't ask again, and **patches the live block in place** if it still shows that text (no re-render, no "updated" marks, no scroll change: the text and layout are identical, only wrapped in spans). A block holding the reader's text selection is patched only once the selection leaves it. Later renders keep it (step 2).

`highlighted` and `highlightTheme` go through the panel's existing origin check like every host message, so widget frames (origin `null`) can't send them.

The panel never receives code or markup back: it slices **its own text** with the lengths, makes `<span>`s with `textContent`, and sets colors through CSSOM (`span.style.color = …`) from palette entries it re-validates (`/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i`). No string becomes HTML or CSS text anywhere.

## 3. Theme

**Which theme.** `vscode.window.activeColorTheme` gives only the kind, so the host works out the name the way VS Code does: `workbench.colorTheme`, or with `window.autoDetectColorScheme` the preferred dark/light theme, or in high contrast (`window.autoDetectHighContrast`) the preferred high-contrast theme for the kind. Old names are migrated first as VS Code does (`Default Dark Modern` → `Dark Modern`, `Default Dark+` → `Dark+`, `Default Light Modern`, `Default Light+`, and `Experimental Dark`/`VS Code Dark` → the default). It finds the contribution in `vscode.extensions.all` (`contributes.themes`, matched on `id` first, then `label`; built-ins have NLS placeholder labels but always an `id`) and **checks the contribution's `uiTheme` against the active kind** (`vs`, `vs-dark`, `hc-black`, `hc-light`): if they disagree, our guess is wrong and we fall back.

**Loading it.** `src/extension/highlight/theme.ts` (pure, with an injected `readFile`, so it's unit-tested):
- JSONC via `jsonc-parser` (comments, trailing commas), each file ≤ 2 MB, 4 MB for the whole chain;
- the contribution's `path` and every `include` must stay inside the theme's extension folder, checked on real paths (symlinks followed) for `file:` URIs; ≤ 8 levels, cycles refused; included `tokenColors` come first, `colors` are merged, the including file wins;
- `tokenColors` given as a path to a `.json` file is followed the same way; a `.tmTheme` (plist) theme or `tokenColors` path isn't supported (falls back);
- the old `settings` key is read as `tokenColors`;
- the user's `editor.tokenColorCustomizations` is applied on top, globally and per theme (`"[Theme Name]"`, `"[A][B]"` and `*` wildcards, matched against the theme's settings id as VS Code does): `comments`, `strings`, `keywords`, `numbers`, `types`, `functions`, `variables` (a color or `{foreground, fontStyle}`, mapped to the scopes VS Code uses) and `textMateRules` (at most 1,000 rules, scopes ≤ 1,000 characters: it can come from a workspace's settings);
- the result is normalized to `{type, fg, bg, settings}` with only hex colors and known font styles kept, and keyed by a hash of that normalized form.

**Fallbacks**, in order: the theme above → VS Code's default theme for the kind, named by the setting's own default (`inspect('workbench.colorTheme' | 'workbench.preferred…ColorTheme').defaultValue`, today Dark 2026, Light 2026, Default High Contrast, Default High Contrast Light), loaded the same way if listed → a copy bundled with us of those four VS Code themes (MIT, include chains already resolved, ~15 KB zipped), so the fallback looks like VS Code's own defaults. Every failure is logged once to Output.

**Changes.** The host recomputes on `onDidChangeActiveColorTheme` and on configuration changes to `workbench.colorTheme`, `workbench.preferred*ColorTheme`, `window.autoDetect*` and `editor.tokenColorCustomizations`, and (only if the key changed) posts `{type: 'highlightTheme', theme}` to every panel. The panel then re-requests its live blocks under the new key and patches them as results arrive; the old key's entries stay in its LRU, so switching back is instant. The host never posts a result made under a theme that is no longer current (it re-runs it).

**Known limits.** Semantic highlighting (colors the language server adds, e.g. TypeScript parameters in some themes) isn't reproduced: blocks look like the editor with semantic highlighting off. In a **remote** window, Sidestory runs on the remote host and usually can't see theme extensions installed on the local side, so colors usually come from VS Code's default theme of the same kind there. While the reader previews themes in the theme picker, `workbench.colorTheme` isn't written yet: blocks keep the previous theme's colors, or, when the previewed theme is of another kind, show VS Code's default theme of that kind, until a theme is chosen. Token colors are chosen by themes for `editor.background`; code blocks keep `textCodeBlock-background`, slightly lower contrast for the dimmest token colors (e.g. 3.4 → 2.8 for `#646695` in Dark 2026); kept, so code blocks look the same with or without a known language. Author CSS that sets a code block's background can make tokens hard to read, as it already can with plain text.

Not done: checking the guessed theme against the panel's `--vscode-editor-background`. `workbench.colorCustomizations` (per theme, with wildcards) changes that color legitimately, so a mismatch proves little, and the picker-preview case above is transient.

## 4. Security

The highlighter adds no script, network or file path to the panel and no new way for content to reach the host:
- **New message `highlight`** from the panel, schema-checked like the rest: `lang` must be one of our grammar ids, `id` an integer, sizes capped (§5). The host reads no file the message names; grammar files are fixed names in our own `dist/`.
- **The panel builds the spans itself** from text already in the sanitized DOM, with `textContent` and CSSOM. HTML or entities inside code (`&lt;script&gt;` in the source, which the parser already turned into text) stay text. Author class names are only a lookup key into a fixed table, never interpolated. A message from the host is trusted no more than needed: palette entries are re-validated, and runs are ignored unless every length is an integer ≥ 1, every style an integer inside the palette, and the lengths add up to exactly the block's length in UTF-16 units.
- **The sanitizer changes by one attribute:** it drops author `data-cx-hl`. Nothing highlighted goes through it, because nothing highlighted is parsed. An author writing their own `<span style="color:…">` in code already could, and gets exactly that (text-only rule); it's compared as author markup for the "updated" flash.
- **Untrusted input in the host:** explainer code is tokenized by fixed grammars in a worker with a heap limit; a hostile input that makes a grammar regex backtrack is cut off by the per-block time limit (the worker is terminated and replaced), never in the extension host's own thread. **Circuit breaker:** after 3 timeouts or worker crashes (cold-grammar timeouts and their retries included), or 20 s of worker time, in a panel within 5 minutes, that panel's code stays plain until it shows another explainer (logged once), so an explainer can't keep a core busy with endless distinct slow blocks. Each panel has at most one request waiting (a newer one replaces it). Theme files come from installed extensions (the user's), not the repository; `editor.tokenColorCustomizations` can come from a workspace's settings, so it goes through the same hex/font-style validation (it can't do more than make text a color it could already make the editor).
- **Restricted Mode:** highlighting works there too (it runs nothing from the repository).

SECURITY.md gets a paragraph saying this.

Tests: script/HTML-looking code stays text (`<img onerror>` inside a block: no element created), author markup inside code untouched, `language-__proto__`/unknown classes plain, forged/malformed host results (bad colors, runs too long or short, out-of-range styles) ignored, schema rejects unknown languages and oversize requests.

## 5. Performance and memory

- **Lazy:** the worker starts on the first request, loads a grammar on first use (and, for markdown, the shipped grammars named by its fences' info strings, mapped through the same alias `Map` to fixed grammar ids before any file name is built, which Shiki only uses if already loaded), and exits after 2 minutes idle (an `unref`'d timer; grammars and themes freed). The worker is `unref`'d. Nothing loads for explainers without code blocks.
- **Caps** (blocks over them stay plain): 2,000 lines or 100,000 UTF-16 code units per block; a line over 2,000 characters is left plain as a whole (Shiki's `tokenizeMaxLineLength`); per message at most 200 blocks and 1 MB in all; per render at most 100,000 spans.
- **Time:** loading a grammar (and tokenizing a one-line sample to warm it) has its own 10 s limit, outside the per-block clock. The worker tokenizes one block per job with a limit of max(1 s, 30 ms per KB), plus Shiki's own 500 ms per-line limit. Over it, the worker is terminated and replaced (replies from a replaced worker are ignored by job id); the block is remembered as plain only if the grammar was already warm, otherwise it's retried once. Heap limit 128 MB.
- **Caches:** host LRU of results by `(theme key, lang, sha256(code))`, runs as `Uint32Array`, 4 MB of real bytes; panel LRU of runs (numbers, never DOM nodes) by `(theme, lang, code)`, bounded by 1 MB of code text. Spans are built when applied (cheap next to layout).
- **Live updates at typing speed:** unchanged blocks are skipped by the morph and cost nothing more; the edited block keeps its colors above the edit and alone is requested. Requests are coalesced per panel: a newer request replaces one still waiting (never the one running). The reader's place is kept because highlighting changes no layout, and live patches touch only the text inside one `code`.
- Comparisons for the "updated" flash treat a highlighted block as its text, so highlighting never marks a section as changed.
- Measured in the panel perf test: render time and DOM count of an explainer with 40 highlighted blocks vs plain; heap back to baseline across content updates.

## 6. Size

Shipped grammars (`dist/highlight/grammars/*.json`, from `@shikijs/langs` 4.5.0, exact pins): typescript, tsx, javascript (also `jsx`: VS Code's JavaScript grammar includes JSX), python, c, cpp (+ cpp-macro, regexp, glsl it embeds), rust, go, java, csharp, system-verilog, verilog, vhdl, json, jsonc, yaml, toml, shellscript, sql, html, css, markdown (+ html-derivative, tiny; fenced code in markdown is highlighted for the languages we ship), diff. The build turns `@shikijs/langs`' ES modules into one JSON file per grammar (dependencies by name, loaded by the worker). ~211 KB zipped. Engine and core in the worker bundle (~165 KB minified, ~50 KB zipped). Expected .vsix: ~1.36 MB → ~1.65 MB. A unit test fails the build above 2 MB, and `.vscodeignore` allows exactly `dist/highlight-worker.cjs` and `dist/highlight/**`.

Aliases: `ts`, `typescript`, `mts`, `cts` → typescript; `tsx`; `js`, `javascript`, `mjs`, `cjs`, `jsx` → javascript; `py`, `python`, `python3`; `c`, `h`; `cpp`, `c++`, `cc`, `cxx`, `hpp`, `hh`; `rs`, `rust`; `go`, `golang`; `java`; `cs`, `csharp`, `c#`; `sv`, `systemverilog`, `svh`; `v`, `verilog`; `vhdl`, `vhd`; `json`, `jsonc`, `json5` → jsonc; `yaml`, `yml`; `toml`; `sh`, `bash`, `shell`, `shellscript`, `zsh`, `console` → shellscript; `sql`; `html`, `htm`, `xhtml`; `css`; `md`, `markdown`; `diff`, `patch`.

## 7. Files

New: `src/shared/highlight-languages.ts` (aliases, ids, caps), `src/extension/highlight/theme.ts` (find, load, normalize), `src/extension/highlight/tokenize.ts` (Shiki → runs + palette; shared by worker and tests), `src/extension/highlight/worker.ts`, `src/extension/highlight/host.ts` (worker manager, caches, theme tracking), `src/webview/highlight.ts`. Hooks: two message types in `src/shared/protocol.ts`; a `case` in the session's message switch and a theme subscription (`src/extension/session.ts`, `extension.ts`); in `src/webview/main.ts` one call before the morph, two message cases, one line in the "updated" comparison. `src/webview/sanitize.ts` drops author `data-cx-hl`. `scripts/build.mjs` builds the worker and writes grammars and the fallback themes (`src/extension/highlight/fallback-themes/*.json`); `.vscodeignore`; `docs/GUIDE.md` "Code blocks" + `npm run sync-skill`; a paragraph in `SECURITY.md`.

## 8. Widgets

A `<Code lang="ts">` UI component needs tokens inside the widget's frame, which means a new bridge request (widget → panel → host → back) with its own validation and rate limits; or shipping Shiki into widget frames. Neither is cheap or small enough for this change: **follow-up**, using the same host highlighter through the bridge and the same palette.

## 9. Tests

- Unit: language mapping and aliases (incl. prototype keys); theme loading (JSONC, include chains, cycles, escapes from the extension folder, `settings` key, `tokenColors` path, customizations, validation, uiTheme mismatch → fallback, kind fallbacks); tokenizer runs (cover the text exactly, `\r\n`, default-color tokens unstyled, caps); host (cache, coalescing, timeout → worker replaced and block plain, theme change re-runs); protocol schema; the size check.
- Panel (Playwright, `test/webview`): colored tokens in light and dark from real tokenizer output (keyword vs string colors differ, match the theme); live update keeps the reader's place, leaves unchanged blocks' spans in place without a new request, keeps colors above an edit; HTML in code stays text; author `data-cx-hl` and markup inside code untouched and still flash "updated" when edited; malformed results ignored; theme change re-requests; render time with 40 highlighted blocks.
- e2e (browser VS Code in Docker): a highlighted block in the real default theme the test sets explicitly (`workbench.colorTheme`) has that theme's keyword color.
- Panel test for a partly colored block whose request was replaced by a newer one (it's completed). Unit test: markdown fences named `../../x` and `__proto__` load nothing.

## 10. Grammars from installed extensions (supersedes the grammar parts of §1, §2, §6)

The reader's VS Code already knows how to color every language it can open: built-in language extensions (`vscode.typescript-basics`, `vscode.python`, `vscode.markdown-basics`…, 80-odd grammars) and any the reader installed (SystemVerilog, VHDL, TOML…). Code blocks use those grammars instead of a fixed set we ship, so a block looks like the same file in the editor, and new languages need no Sidestory release.

### 10.1 Choices

| | Chosen | Why |
|---|---|---|
| Tokenizer | `vscode-textmate` 9.3.2, bundled in the worker (~60 KB) | What VS Code itself runs, same major version as stable (1.95 has 9.1). It resolves `include`s and injections by scope name through a `loadGrammar` callback, which is exactly what discovered grammars need; Shiki's registry is name-based, wants every grammar up front, and is a fork. `@shikijs/core` and `@shikijs/langs` leave the package. |
| Regex engine | Oniguruma: VS Code's own `onig.wasm`, found under `vscode.env.appRoot`, driven by `vscode-oniguruma` 1.7.0's JS (bundled, 12 KB; the exact version VS Code pins) | The grammars are written for Oniguruma. The wasm is at `node_modules/vscode-oniguruma/release/onig.wasm` (desktop 1.95, openvscode-server/remote servers) or `node_modules.asar.unpacked/vscode-oniguruma/release/onig.wasm` (desktop stable 1.14x); same file in all (sha1 `b1644a9e…`). Its JS glue is inside `node_modules.asar` in stable, which a worker can't read, so the 12 KB glue is ours and the 466 KB wasm is VS Code's. |
| Fallback engine | `@shikijs/engine-javascript` (`forgiving: true`) | When no wasm is found, or it fails to load or answer a smoke test (a future VS Code with another ABI): grammars still work, a pattern JS can't express just never matches. Logged once. No wasm is bundled. |

### 10.2 Discovery and language names

- The host builds a **grammar catalog** from `vscode.extensions.all` (`contributes.grammars`: `scopeName`, `path`, `language`, `injectTo`; `contributes.languages`: `id`, `aliases`, `extensions`), and rebuilds it on `vscode.extensions.onDidChange`. Built-in extensions first, then the reader's, so a reader's grammar for a language wins as in VS Code. `embeddedLanguages` and `tokenTypes` only set language ids and token types, not colors: not used.
- **The panel sends the language name** from the first `language-x` / `lang-x` class, lower-cased, if it matches `^[a-z0-9][a-z0-9_+#.-]{0,63}$` (no table in the panel any more). The host maps it: a language `id`, else an alias, else a file extension (`py`, `rs`, `yml`), else a tiny table of fence names VS Code has no alias for (`python3`, `golang`, `node`, `console`, `shell`, `make`, `json5`), all through `Map`s. No grammar → `runs: null` → plain (the panel remembers it).
- **Grammar set changes** (an extension installed or removed) are folded into the theme key the panel sees, so panels re-request and a language that just got a grammar is colored.

### 10.3 Reading other extensions' files

The host reads, the worker parses:
- Each contribution's `path` must resolve inside its extension folder (the same `resolveInside` + real-path check as themes, §3); `.json` is read as JSON, `.tmLanguage`/`.plist`/`.tmGrammar` as plist (vscode-textmate's own parser, as VS Code does); anything else is skipped.
- Per file ≤ 4 MB. A block's grammar set is its grammar plus every scope its files `include` (found by a regex over the text, not parsed in the host) and the injections into those scopes, breadth first, at most 128 grammars and 12 MB (markdown with VS Code's built-ins: 72 grammars, 3.5 MB). Past the caps the remaining includes are left unresolved (those parts stay uncolored), as VS Code does for a missing grammar.
- Parsing (JSON or plist) and compiling happen in the worker, inside its heap limit and the load timeout; a grammar that fails to parse leaves its block plain.
- Grammar files come from installed extensions, never from the workspace, so Restricted Mode is unchanged. The web (vscode.dev) doesn't run Sidestory (no browser entry). In a remote window, extensions on the remote side are read with `fs`; others through `vscode.workspace.fs` when their URI is readable, else skipped.

### 10.4 Worker

`load` carries the grammar texts of one scope's set (with the injections map); the worker registers them and loads the grammar through `vscode-textmate`'s `Registry` (includes resolve from what was sent, else `null`), then tokenizes one line to warm it. The theme goes in with `Registry.setTheme`; runs come from `tokenizeLine2` (foreground id → the registry's color map, font style bits as before; the theme's default foreground and no font style → style 0). A line over 2,000 characters is one plain run, and a line that hits the 500 ms per-line limit is plain with the state carried over unchanged. A catalog change restarts the worker between jobs. Timeouts, breaker, caches, heap limit: §5 unchanged.

### 10.5 Size

Out: the 27 shipped grammars and Shiki core. In: vscode-textmate and the oniguruma glue. Measured in the CHANGELOG's entry and the PR.
