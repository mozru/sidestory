# Code anchors: research and recommended design

> Written when the folder was `.explain/`, the page was `explainer.html` and sidestories were called explainers.

Answers DESIGN.md §4.2 and open question 1. Researched 2026-10-21.

## 1. What others do

| System | How it anchors | Lesson for us |
|---|---|---|
| **W3C Web Annotation** ([model](https://www.w3.org/TR/annotation-model/)) | *Alternative* selectors for one target: `TextQuoteSelector` (`exact`, `prefix`, `suffix`), `TextPositionSelector`, plus `TimeState` for the version | Store redundant selectors. Position is a hint; the quote is the truth. |
| **Hypothesis** ([fuzzy anchoring](https://web.hypothes.is/blog/fuzzy-anchoring/)) | Cascade: structural path → position + quote check → context-first fuzzy (32-char prefix near start, suffix near end, compare middle) → fuzzy quote search. Uses [diff-match-patch](https://github.com/google/diff-match-patch/wiki/API) Bitap (`Match_Threshold` 0.5, `Match_Distance` 1000 default) | The cascade we adopt. Bitap's 32-bit limit explains the 32-char contexts; whole regions need line-level matching. |
| **CodeTour** ([repo](https://github.com/microsoft/codetour)) | `line`, or a `pattern` regex only when `line` is absent; optional `ref` freezes the code. Drift is caught in CI, not repaired | A line or regex is not enough, and we cannot freeze the code. |
| **Swimm Auto-sync** ([blog](https://swimm.io/blog/how-does-swimm-s-auto-sync-feature-work/), [docs](https://docs.swimm.io/features/keep-docs-updated-with-auto-sync/)) | Patented, language-agnostic. Weighs line numbers, "smart tokens", change size and git history. Moves and 1:1 renames sync silently; deletions and ambiguity become a human task | Copy the auto-accept vs. ask split. Avoid its need for full history. |
| **Gerrit** ([ported comments](https://gerrit.googlesource.com/gerrit/+/HEAD/Documentation/user-porting-comments.txt)) | Diff-maps comments to newer patchsets; on failure, demotes to a **file-level** comment | Degrade to a coarser anchor; never drop. |
| **GitHub PRs** ([REST](https://docs.github.com/en/enterprise-server@3.1/rest/pulls/reviews)) | Commit + diff position; "outdated" when a later commit touches the hunk; never relocated | The anti-pattern. |
| **git** ([blame -M/-C](https://man.archlinux.org/man/extra/git/git-blame.1.en), [`log -L :funcname`](https://git.lorimer.id.au/gitweb.git/diff/13b8f68c1f0b6d4ff5a7bed5a834e7e5e34a9fd0)) | Follows line ranges or regex-defined functions through history; detects moved/copied lines | Correct but slow. Async fallback only. |
| **LHDiff** ([paper](https://www.cs.usask.ca/~croy/papers/2013/LHDiffFullPaper-preprint.pdf), [impl](https://github.com/smartbear/lhdiff)) | Language-independent line mapping: diff, then simhash shortlist, then weighted content + context similarity (about 0.6/0.4 as I recall; verify) | Our fuzzy scorer is LHDiff-shaped, so it works for HDL. |
| **SCIP** ([proto](https://github.com/sourcegraph/scip/blob/main/scip.proto)) | Symbol strings `scheme package descriptor+` (`/` namespace, `#` type, `.` term, `().` method) | Format for our symbol path. Indexes rarely exist for HDL. |
| **Tree-sitter** ([repo](https://github.com/tree-sitter/tree-sitter), [web](https://www.jsdelivr.com/package/npm/web-tree-sitter)) | Incremental CST per edit, also in WASM. [Verilog/SV grammar](https://openapps.pro/packages/tree-sitter-verilog); community VHDL | Structure with no LSP, in every runtime. |
| **Magic Markup** ([arXiv](https://arxiv.org/html/2403.03481v1)) | An LLM gets old and new file and returns the new span, then an exact-match check: 88–90% on 90 cases, about 5 s per tag. It cites Reiss's text+context tracker (ICSE 2008) at 86.5% | LLM for **repair** only, always verified. |
| **Codetations** ([arXiv](https://arxiv.org/html/2504.18702v1)) | **Online:** shift anchors on editor events. **Offline** (pulls, other tools): flag, then LLM re-attach with consent | The online/offline split we adopt. |

**Takeaways:** keep redundant selectors; track live edits incrementally instead of searching per keystroke; text plus context is the language-independent backbone; structure breaks ties; history and LLM are async repair steps; degrade to a coarser anchor instead of failing.

## 2. Answer to open question 1

**Lean on text, not language servers.** The primary selector is quote + context, which works in every viewer and every language. Tree-sitter is the structural layer, because it runs everywhere, in WASM. LSP `documentSymbol` is an optional enhancer that only the VS Code extension uses, and only when a server is present.

**History mapping becomes rare** thanks to **re-pinning**: auto-accepted resolutions are re-pinned whenever anchors are written (optionally on commit). Git diff mapping remains an async fallback for pulls, rebases and branch switches. Nothing *requires* git (shallow clones, static viewer).

## 3. Anchor schema (`manifest.json`, version 2)

```jsonc
"refill": {
  // where, as last written (hints, not truth)
  "file": "rtl/bit_reader.sv",
  "range": { "start": [35, 0], "end": [40, 7] },   // 1-based line, 0-based col
  "granularity": "lines",            // "lines" | "span" | "symbol" | "file"
  "pin": {
    "commit": "a1b2c3d…",            // full SHA where written/re-pinned
    "blob": "9f3e…",                 // git blob SHA of the file (survives rebase/squash)
    "dirty": false                   // true if pinned against unsaved/uncommitted text
  },
  // text selector (W3C TextQuoteSelector, line-oriented)
  "quote": {
    "exact": "if (in_valid && in_ready) begin\n  buf_q <= …\nend",
    "prefix": "…up to 3 lines / 160 chars before",
    "suffix": "…up to 3 lines / 160 chars after",
    "norm": "ws"                     // ws = trim + collapse whitespace; "ws-ci" for VHDL
  },
  "fp": {
    "contentHash": "sha256:…",       // of normalized exact
    "lineHashes": ["a1f0", "77c2", "…"],  // 16-bit per normalized line, for alignment
    "simhash": "0x3c91…"             // 64-bit, for shortlisting
  },
  // structural selectors (optional, all alternatives)
  "syntax": {
    "lang": "systemverilog",
    "path": [
      { "type": "module_declaration", "name": "bit_reader" },
      { "type": "always_construct", "ord": 1, "sig": "always_ff @(posedge clk" },
      { "type": "conditional_statement", "ord": 1, "sig": "if (in_valid && in_ready)" }
    ],
    "rel": { "startLine": 4, "endLine": 9 }   // offset from the enclosing node's start
  },
  "symbol": { "path": "bit_reader#", "kind": "module", "scip": null },
  "tokens": ["in_valid", "in_ready", "buf_q", "cnt_q"],  // identifiers in the region (rename detection)
  // presentation (existing)
  "highlight": ["in_byte"], "color": "charts.purple"
}
```

**Rules:**
- The tooling computes `quote`, `fp`, `syntax` and `pin` from a chosen range. Neither humans nor Claude hand-write them.
- `range`, `file` and `snippet` from v1 still parse: `snippet` becomes `quote.exact`.
- A local cache, `.explain/.cache/resolved.json` (gitignored), stores the last resolution keyed by `(anchorId, file blob SHA or buffer version)`, so switching back to a branch is instant.
- Thread code anchors (§4.3) embed the same object.

## 4. Strategies, in order

Each strategy yields candidates `{file, range, L}`, where **L** is the *location confidence*. Separately, **S** is the *content similarity* between `quote.exact` and the candidate's text, both normalized. S is 1 − normalized token-level edit distance, or the line-LCS ratio for regions longer than 20 lines.

| # | Strategy | When it runs | L |
|---|---|---|---|
| 0 | **Live tracking.** Shift ranges by `TextDocumentChangeEvent.contentChanges`, the way decorations move. Edits inside the range resize it; deleting the whole region sets `orphaned` | every keystroke (VS Code only) | inherits the previous L |
| 1 | **Hint check.** Hash of the text at the cached or manifest range equals `contentHash` | cheap; first | 1.00 |
| 2 | **Exact quote search** (normalized `indexOf`) in the same file. If there are several hits, pick by prefix/suffix agreement, then by distance to the hint | cheap | 1.00 if unique or decided by context, otherwise 0.90 |
| 3 | **Structural.** Re-find the node by `syntax.path`, matching `name`, then `sig` similarity, then `ord`. Apply `rel`. Or use LSP `symbol.path` | when tree-sitter or LSP is available | 0.70 + 0.30·S if the name matches; 0.55 + 0.35·S if matched only by sig/ord |
| 4 | **Context-first fuzzy.** Hypothesis-style: find `prefix` near the hint and `suffix` after it (diff-match-patch, threshold 0.35, distance ≈ 2000 chars), then take the middle | always | see the scorer |
| 5 | **Line-alignment fuzzy.** LHDiff-style: simhash shortlist (top 10 windows of the same line count ±30%), then score | always; capped window | see the scorer |
| 6 | **History mapping.** In-process Myers diff of the `pin.blob` text against the current text, mapping the range. Across files: `git diff -M -C pin.commit` rename/copy detection, then strategies 2–5 in the new file | async, needs git; on branch switch, pull, or when 1–5 fail | the scorer, +0.05 if the diff-mapped range overlaps the candidate |
| 7 | **Workspace search.** Exact or normalized quote (ripgrep), then the first line ± `tokens` density | async, when the file is missing or 1–6 score below 0.6 | 0.95 for an exact unique hit, otherwise the scorer |
| 8 | **Claude repair** (§9) | on demand, or in the Action | Claude proposes a range; it re-enters at step 1 |

**Scorer** for fuzzy candidates (LHDiff-shaped):

```
L = 0.55·S + 0.25·C + 0.10·T + 0.10·P
  S = content similarity
  C = context similarity (prefix/suffix vs. the text around the candidate)
  T = token overlap (Jaccard of `tokens`; a 1:1 rename map counts as a hit)
  P = proximity = exp(−|Δline| / 200)
```

**Ambiguity:** if the second-best candidate is within 0.05 of the best, set `ambiguous: true` and cap L at 0.75.

## 5. States and thresholds

Location (L) and drift (S) are **two axes**: "where is it?" and "is the prose still true?". "Found but heavily changed" is what makes `stale` distinct from `lost`.

| State | Condition | Meaning |
|---|---|---|
| **exact** | S = 1 (normalized hash equal), range = hint | Nothing happened |
| **moved** | S = 1, different lines or file | Code moved; prose is still valid |
| **changed** | L ≥ 0.80 and 0.70 ≤ S < 1 | Same code, edited; prose is probably still valid |
| **stale** | L ≥ 0.60, and S < 0.70 or L < 0.80 | We know roughly where it is, but the prose may be wrong |
| **lost** | no candidate with L ≥ 0.60, or `orphaned` | Don't guess |

**Hysteresis:** cross a boundary by 0.03 to change state, and defer downgrades while the user typed inside the anchor in the last 1.5 s, so badges don't flicker mid-word. Typing *above* an anchor keeps it `exact`, because live tracking moves the hint.

**Granularity fallback**, borrowed from Gerrit: when a `lines` anchor is lost but its enclosing `syntax.path[0..k]` node resolves, show `stale` on the enclosing symbol instead of `lost`. When even that fails but the file exists, fall back to the file (`lost`, with "file-level" shown).

## 6. Algorithm

```ts
// ---- online: called synchronously on every document change (VS Code) ----
onDidChange(doc, changes):
  for a in anchorsIn(doc):                        // usually < 50
    a.range = shift(a.range, changes)             // O(changes)
    if changes intersect a.range: a.dirty = true
  schedule(resolveDirty, idle = 150 ms)           // debounced

// ---- resolve one anchor against the current text (buffer or blob) ----
resolve(a, text, ctx): Result
  n = normalize(text, a.quote.norm)                // cached per doc version
  if hash(slice(n, a.range)) == a.fp.contentHash:
    return state(a.range, L = 1, S = 1)            // 1: hint
  hits = findAll(n, a.quote.exact)                // 2: exact
  if hits.length:
    best = argmax(hits, h => ctxAgree(h, a) * 10 − dist(h, a.range))
    return state(best, L = unique-or-ctx ? 1 : 0.9, S = 1)
  cands = []
  if ctx.tree:    cands += structural(a, ctx.tree)          // 3
  if ctx.symbols: cands += viaSymbols(a, ctx.symbols)
  cands += contextFirst(a, n)                               // 4
  cands += lineAlign(a, n, budgetLines = 4000)              // 5
  best, second = top2(cands, by L)
  if best && second && best.L − second.L < 0.05:
    best.ambiguous = true; best.L = min(best.L, 0.75)
  if best && best.L ≥ 0.60: return state(best)
  return enqueueAsync(a)                                    // 6, 7: off the hot path

// ---- async: branch switch / pull / file missing ----
resolveAsync(a):
  if git && blobExists(a.pin.blob):
    mapped = diffMap(readBlob(a.pin.blob), currentText(a.file), a.range)  // 6
    ...rescore with the overlap bonus
  if fileMissing(a.file):
    for f in gitRenames(a.pin.commit, a.file) ∪ rgSearch(a.quote): resolve(a, f)  // 7
  else: return LOST(fallback = enclosingNode or file)

state(c):
  return exact | moved | changed | stale | lost   // per §5, applying hysteresis
```

**Branch switch:** watch `.git/HEAD`; mark all dirty, hit the blob-SHA cache (instant when switching back), re-resolve visible explainers first.

**Static web viewer:** the Action resolves at build time (full git, tree-sitter WASM) and embeds `resolved.json` with the code snapshot, so the browser needs **no** resolver. For other revisions, the same TS resolver (strategies 1–5, pure JS) runs in a Web Worker.

## 7. Performance budget

Target: typing never waits on anchors. The resolver lives in a `worker_thread` (extension host) or a Web Worker (browser).

| Path | Work | Budget |
|---|---|---|
| Keystroke (synchronous) | Strategy 0 shift + dirty flag, ≤ 200 anchors | **< 0.5 ms total** |
| Idle 150 ms, dirty anchors | Normalize (incremental per changed line) + strategies 1–2 | < 1 ms per anchor; < 5 ms per document |
| Same debounce, unresolved | Tree-sitter incremental reparse (shared with highlighting if available) + 3–5. Bitap limited to a ±2000-char window; line alignment capped at 4000 lines around the hint; simhash shortlist ≤ 10 | < 8 ms per anchor; **< 16 ms per document**, otherwise yield and continue next idle slice |
| Save / focus / HEAD change | Re-validate all anchors of open explainers | < 100 ms per explainer |
| Async | Git diff mapping, rename detection, ripgrep | < 2 s; progress shown, never blocks UI |
| Claude repair | LLM | 5–30 s; explicit, batched |

On a missed deadline, keep the previous state and mark `pending`. A timeout **never** shows a section as lost.

## 8. Presentation

| State | Editor | Explainer section | Click → editor |
|---|---|---|---|
| exact | Normal tint + left bar | Normal | Jump and highlight |
| moved | Normal; hover: "Moved from L35" or "from `old/path.sv`" | Normal, no badge | Jump |
| changed | Normal + gutter dot | "Edited" dot; hover: "Show diff since written" | Jump |
| stale | Hatched tint, `editorWarning` bar; CodeLens "May be out of date · Ask Claude" | Warning badge, faded prose, "Show diff", "Ask Claude to refresh" | Jump to best guess, dashed outline |
| ambiguous | Best outlined, alternatives ghosted | "2 possible matches — pick one" | Best; QuickPick |
| lost | Nothing (or file-level marker) | "Code not found" card showing the original `quote.exact`, so the section still reads; "Anchor to selection", "Ask Claude" | No jump |
| pending | Previous state | Previous state; spinner after 1 s | As before |

Colors are theme tokens (§5.3). A header roll-up ("12 linked · 1 out of date · 1 not found") doubles as a filter. Cursor→section sync ignores lost anchors and ranks stale below exact when regions overlap.

## 9. How Claude repairs anchors

MCP tools (§7.2):
- `explain.anchors.status(explainer)`: per anchor, state, L, S, top 3 candidates, and a diff of the pinned quote against the best.
- `explain.anchors.set(explainer, id, {file, range} | {file, quote})`: the **tool** derives quote, context, fingerprints, syntax path and pin. Claude chooses *where* and never writes hashes. The tool re-runs `resolve` and refuses the write unless it is `exact` (Magic Markup's verification step).
- `explain.anchors.repin(explainer)`: re-pins `moved` anchors and `changed` ones with S ≥ 0.9 (Swimm's "silent for trivial").

**Policy:**
1. **Auto, no LLM:** moved, and changed with S ≥ 0.9; re-pinned when Claude writes, or on commit (optional hook, or the Action).
2. **Claude, unasked:** when Claude itself edited the code (it knows the intent), it repairs anchors and affected prose in the same turn and narrates it.
3. **Claude, with confirmation:** stale, ambiguous and lost anchors from others' changes. Claude proposes a range and a prose patch; the user accepts in the explainer, or as a suggested commit from the Action.
4. **Never** silently rewrite prose or drop an anchor. If Claude can't find the code, the anchor stays `lost` with an explanatory thread.

## 10. Risks and open items

- Duplicated code (`generate` blocks, copy-pasted RTL): context and `syntax.path` disambiguate; the `ambiguous` flag covers the rest.
- SV and especially VHDL tree-sitter grammars are imperfect. Strategy 3 must tolerate `ERROR` nodes; without it, large rewrites just yield more `stale`.
- `pin.blob` may be GC'd after a force-push; only strategy 6 is lost.
- All weights and thresholds are starting points. Calibrate by replaying real (including HDL) repo histories against human-chosen ranges, like Magic Markup's benchmark.
