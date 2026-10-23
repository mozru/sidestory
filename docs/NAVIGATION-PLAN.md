# Navigation in large repositories: plan

> **Status: plan, not implemented** (revision 2, 2026-10-23, after review).
>
> **Covers:**
> - renaming the folder (`.explain/` → `.sidestory/`) and the word users see ("explainer" → "sidestory");
> - tops and their details as the unit of navigation;
> - separating sidestories by folder and by group;
> - four navigation features: Explained here, the sidebar, Go to Step, and a better Open Sidestory list;
> - performance, memory, security and tests.
>
> Decisions already made with the user are marked **(decided)**. Questions still open are in §13, each with a recommendation.

## Contents

1. [Terms](#1-terms)
2. [Rename the folder: `.explain/` → `.sidestory/`](#2-rename-the-folder-explain--sidestory)
3. [Rename the word: "explainer" → "sidestory"](#3-rename-the-word-explainer--sidestory)
4. [Tops and details](#4-tops-and-details)
5. [Separation: packages and groups](#5-separation-packages-and-groups)
6. [The workspace index](#6-the-workspace-index)
7. [Explained here: CodeLens, gutter and status bar](#7-explained-here-codelens-gutter-and-status-bar)
8. [The Sidestory sidebar](#8-the-sidestory-sidebar)
9. [Go to Step](#9-go-to-step)
10. [Open Sidestory](#10-open-sidestory)
11. [Performance, memory, lifecycle and security](#11-performance-memory-lifecycle-and-security)
12. [Tests](#12-tests)
13. [Open questions](#13-open-questions)
14. [Phasing](#14-phasing)
15. [Review log](#15-review-log)

---

## 1. Terms

User-facing words come first. The code names that stay unchanged are in brackets.

- **Sidestory**: one folder `<root>/.sidestory/<name>/` holding `manifest.json` and the page (`explainer.html` today; see §13, Q1) [`ExplainerRef`].
- **Sidestory folder**: a folder named `.sidestory` that holds sidestories. A repository can have several (monorepos).
- **Root**: the folder that contains a Sidestory folder. An anchor's `file` is relative to it, as today.
- **Package**: one Sidestory folder with the sidestories in it.
- **Detail link**: `data-explain-detail="<name>"` in a sidestory's HTML. It points to a sibling in the same Sidestory folder.
- **Detail**: a sidestory that another one links to.
- **Top**: a sidestory that is shown at the top level of its package (§4.2). A top together with the details reachable from it is what readers navigate.
  - The UI never names this unit. Tops appear at the top level and details nest under them. Labels read "Parent › Detail", for example "Stream DMA engine › DMA controller".
  - The word "story" is retired, so it can't be confused with "sidestory".
- **Start here**: the package's entry point, pinned first in the sidebar (§8.2).
- **Step**: a top-level anchored element, meaning one with `data-explain-anchor` and no anchored ancestor. Its title follows one rule, shared by the panel and the index (§6.2).

---

## 2. Rename the folder: `.explain/` → `.sidestory/`

**(decided)** This is a clean switch: nothing is released, so there is no fallback and no migration.

The format names stay as they are:
- the `data-explain-*` attributes;
- `<explain-widget>`;
- `import … from 'explainer'`, the widget module name (§3.2);
- `--cx-*` CSS properties.

### 2.1 Every place it touches

The inventory was taken on 2026-10-23 from **tracked and untracked** files; the numbers are counts of `\.explain`. Several of these files are untracked today (`docs/GUIDE.md`, `plugins/`, `examples/tiny-lsm/`), and a plain `git grep` misses them (§2.2).

**Folders**

| From | To |
|---|---|
| `fixtures/sample-workspace/.explain/` (bit-reader, overview, retry-backoff) | `fixtures/sample-workspace/.sidestory/` |
| `examples/stream-dma/.explain/` (8: dma-overview, dma-ctrl, …) | `examples/stream-dma/.sidestory/` |
| `examples/tiny-lsm/.explain/` (7: lsm-overview, lsm-bloom, lsm-compaction, lsm-memtable, lsm-merge, lsm-sstable, lsm-wal; untracked) | `examples/tiny-lsm/.sidestory/` |

**Extension code**

| File | Change |
|---|---|
| `src/extension/explainers.ts` | `refFromDir`: the segment test becomes `'.sidestory'`. It also rejects a root that itself contains a `.sidestory` segment (§5.1). The `findExplainers` glob becomes `**/.sidestory/*/manifest.json`, and the doc comments change to match. |
| `src/extension/extension.ts` | Messages naming `.explain/<name>` (the "not a sidestory" warning, "none found", and the check-command fallback), plus comments. |
| `src/extension/session.ts`, `panel.ts` | Comments only. |
| `src/extension/widgets/host.ts` | The watcher `**/.explain/*/**` is replaced by the shared watcher (§6.4). The `onWorkspaceFile` regex `/^(.*\/\.explain\/[^/]+)(\/.*)$/` changes, and the comments at the symlink checks. |
| `src/core/manifest.ts` | Doc comments. |
| `src/widget-types/index.ts` | `TYPECHECK_COMMAND = 'npx -y -p typescript tsc -p .sidestory'`, plus the doc comments. |
| `src/cli/check-widgets.ts` | The header comment and the location check. The finding code **`not-in-explain` becomes `not-in-sidestory`**, with its message. The `--types` guard and its error message. |
| `scripts/pin.ts` | The usage text. |

**`package.json`**

- `activationEvents`: `workspaceContains:**/.sidestory/*/manifest.json`.
- The `explorer/context` `when`: `resourceDirname =~ /\\.sidestory$/`.
- Keep the `"explain"` keyword: it is a search term, not a path.

**Repository tools**

- `.gitignore`: `.explain/.local/` becomes `.sidestory/.local/`.
- `examples/stream-dma/tools/diagrams.py`: rename `EXPLAIN = ROOT / '.explain'` to `SIDESTORY` and update the docstring.
- `examples/tiny-lsm/tools/check_model.py` (1) and `examples/tiny-lsm/tools/model_trace.mjs` (2).

**Persistent state keyed by path** (no migration, by decision)

- **Widget consent** is keyed by workspace-relative path, so after the rename each sidestory with widgets asks once more. That is the safe side, and acceptable before release; old records age out under `MAX_CONSENT_FILES`.
- `widgetsDisabled`, `widgetStates` and `unpinnedNoticeShown` are keyed by folder URI. Their old entries simply go dead, and all three are bounded.
- `widgetQuotesConfirmed` is keyed by the anchor's root-relative `file`, which doesn't change, so it stays valid.
- A panel restored with a `.explain/…` dir fails `restoredTrail` and is disposed quietly.

**Docs**

- `README.md` (7), `docs/GUIDE.md` (7), `docs/WIDGETS.md` (3), `SECURITY.md` (3), `docs/DESIGN.md` (8), `docs/TEST-PLAN.md` (2), `docs/WIDGETS-PLAN.md` (2), `docs/mockup/Main.dc.html` (1).
- `docs/research/*.md` (architecture 14, claude-and-review 6, ux-design 1, anchors 1) are historical notes. They get a one-line note at the top ("written when the folder was `.explain/` and sidestories were called explainers") and are otherwise left alone.
- The other `docs/*-PLAN.md` files, including this one and `HIGHLIGHT-PLAN.md`, are excluded from the mechanical pass. Plans that are still active are updated by hand.
- `CHANGELOG.md`: one entry.
- **Marketplace media** (`media/marketplace/*`, `examples/*/screenshots/`): check each by eye and capture again any that show `.explain` or the word "Explainer" (the panel tab title does today). §3 makes most of them stale anyway.

**The skill**

- `plugins/sidestory/skills/sidestory/SKILL.md` (4) is written by hand: its frontmatter `description`, the layout and the checker command.
- `references/GUIDE.md` (7) and `references/WIDGETS.md` (3) are generated: run `npm run sync-skill`.
- `.claude-plugin/marketplace.json` names no folder, but it does use the word (§3).

**Tests**

| File | Count |
|---|---|
| `test/unit/check-cli.test.ts` (also asserts `not-in-explain`) | 30 |
| `test/unit/widgets-git.test.ts` | 13 |
| `test/unit/widgets-host.test.ts` | 7 |
| `test/unit/widgets-session.test.ts` | 4 |
| `test/unit/widgets-guide.test.ts` | 3 |
| `test/unit/css.test.ts` | 2 |
| `test/unit/widgets-compile.test.ts`, `session-lifecycle.test.ts`, `line-endings.test.ts` | 1 each |
| `test/webview/webview.pw.ts` | 8 |
| `test/webview/widgets.pw.ts` | 8 |
| `test/webview/perf.pw.ts` | 4 |
| `test/webview/widget-helpers.ts` | 2 |
| `test/webview/harness.html` | 2 |
| `test/webview/isolation.pw.ts` | 1 |
| `test/e2e/widgets.e2e.ts` | 5 |
| `test/e2e/explainer.e2e.ts` (its `tar … 'rtl', '.explain'`) | 2 |
| `test/e2e/zz-repro.e2e.ts` (untracked) | 1 |
| `test/desktop/suite/explainer.test.ts` | 2 |

`test/desktop/run.mjs` copies the whole workspace, so it needs no change. Build outputs (`dist*`, `test-results`, `.vscode-test`) are regenerated.

### 2.2 Procedure

Run it as one commit, before feature work, once the agents now editing `src/` have landed. Commit or stash their untracked work first, so it is in the diff, or make sure every grep below uses `--untracked`.

```bash
# 0. Baselines: the format names must not change.
git grep --untracked -c -I -E 'data-explain-|explain-widget|from .explainer.' -- . ':!package-lock.json' > /tmp/format-before.txt

# 1. Folders (git mv for tracked ones; mv for untracked ones).
git mv fixtures/sample-workspace/.explain fixtures/sample-workspace/.sidestory
git mv examples/stream-dma/.explain       examples/stream-dma/.sidestory
mv examples/tiny-lsm/.explain             examples/tiny-lsm/.sidestory   # git mv if tracked by then

# 2. The path segment. `\.explain(?![\w-])` never matches data-explain-*, explain-widget, .explainer or 'explainer',
#    and rewrites "\\.explain" (package.json) and "\.explain" (regex literals) correctly.
git grep --untracked -l -I -P '\.explain(?![\w-])' -- . \
    ':!docs/research' ':!docs/*-PLAN.md' ':!package-lock.json' ':!CHANGELOG.md' \
  | xargs perl -pi -e 's/\.explain(?![\w-])/.sidestory/g'

# 3. Targeted renames the pattern doesn't cover.
perl -pi -e 's/not-in-explain/not-in-sidestory/g' src/cli/check-widgets.ts test/unit/check-cli.test.ts
perl -pi -e 's/\bEXPLAIN\b/SIDESTORY/g' examples/stream-dma/tools/diagrams.py
#    By hand: the notes on docs/research/*, the CHANGELOG entry, the active plans.

# 4. Regenerate the skill's copies.
npm run sync-skill
```

Review these risky spots by hand:
- the regex in `host.ts`;
- the `when` clause in `package.json`;
- the checker messages, which `check-cli.test.ts` asserts word for word.

### 2.3 Verification

1. **No old paths.** These must print nothing:

   ```bash
   git grep --untracked -n -I -P '\.explain(?![\w-])' -- . ':!docs/research' ':!docs/*-PLAN.md' ':!package-lock.json' ':!CHANGELOG.md'
   git grep --untracked -n not-in-explain
   find . -name .explain -not -path './node_modules/*'
   ```

2. **No bare segment.** Review `git grep --untracked -n -E "['\"\`]explain['\"\`/]"` by hand. The expected hits are the `package.json` keyword and `docs/DESIGN.md`'s historical `"explain/1.0"`.
3. **The format names didn't change.** Run the baseline grep again and `diff` it against `/tmp/format-before.txt`.
4. **A regression test**, `test/unit/rename.test.ts`:
   - `refFromDir` accepts `.sidestory/x` and rejects `.explain/x` and `.sidestory/x/.sidestory/y`;
   - `package.json` contains no `.explain`;
   - the checker reports `not-in-sidestory`.
5. **The suites:**
   - `npm run check`, `test:webview`, `test:widgets`, `test:e2e`, `test:desktop`;
   - the checker on every sidestory in both examples;
   - `--types` writes `.sidestory/tsconfig.json`.
6. **By hand**, with F5 on the sample workspace:
   - the extension activates;
   - Explorer › right-click › Open Sidestory works;
   - the consent prompt appears once;
   - Copy Widget Check Command names `.sidestory/<name>`.

---

## 3. Rename the word: "explainer" → "sidestory"

**(decided)** In every piece of user-facing text, an explainer is now a **sidestory** (plural *sidestories*; capitalised only at the start of a sentence or in titles). That covers:
- commands, settings, colors and capabilities;
- panel text and accessible names;
- notifications;
- checker output;
- docs, README, the skill and marketplace text.

### 3.1 What changes

**`package.json`**

| Where | Now | New |
|---|---|---|
| `description` | "Rich explainers beside your code…" | "Rich sidestories beside your code…" |
| Command `sidestory.open` | Open Explainer | **Open Sidestory…** |
| New commands (§7–§10) | | **Go to Step…**, **Show Sidestories for This Code**, **Copy a Prompt for Your Agent**, **Show Sidestories** (§8.1) |
| Setting `dimUnfocused` | "…through the explainer." | "…through a sidestory." |
| Setting `widgets.enabled` | "…widgets in explainers…" | "…widgets in sidestories…" |
| Colors (`focusBackground`, `staleForeground`, `lostForeground`) | "explainer step / Explainer sections" | "sidestory step / Sidestory sections" |
| `capabilities.untrustedWorkspaces` / `virtualWorkspaces` | "Explainers …" | "Sidestories …" |

The other command titles ("Pin Anchors to the Current Code", "Re-anchor Section to Selection", the widget commands) don't contain the word. The category stays "Sidestory".

**Extension strings** (`extension.ts`, `session.ts`, `pin.ts`, `widgets/host.ts`, `widgets/*` messages):

- **Notifications:**
  - "The explainer “x” was open, but explainers aren't reopened automatically in Restricted Mode." → "The sidestory “x” was open, but sidestories aren't reopened automatically in Restricted Mode."
  - "Open Explainer(s)" → "Open Sidestory / Open Sidestories".
  - "Not an explainer…" → "Not a sidestory: expected a folder like .sidestory/<name> inside the workspace."
  - "No explainers found…" → "No sidestories found. A sidestory is a folder like .sidestory/<name>/ with a page and manifest.json."
  - "Widget consent revoked: explainers ask again…"
  - "There's no explainer called “x” next to this one."
  - "The explainer links to:".
- **The quick pick placeholder** "Open which explainer?" → "Open which sidestory?".
- **The panel tab title** `Explainer: <title>` → `<title>`, with the panel's `iconPath` set to the Sidestory icon. The icon marks the tab, so the prefix isn't needed.

**Webview strings** (`src/webview/main.ts`, `widgets.ts`): the accessible names "Explainer path" and "Explainer content", the region label "Explainer", "No explainer named “x”", the detail placeholder `<explainer>`, the widget gate and banner texts, and the shell's `<title>Explainer</title>` in `panel.ts`.

**Checker** (`src/cli/check-widgets.ts`, `css.ts`):
- every message that says "explainer" when it means the folder;
- the usage text;
- the `--json` key `explainer` (the folder path) becomes `sidestory`. It's a clean switch, since nothing is released.

**Docs**

- `README.md` (23 mentions), `docs/GUIDE.md` (28), `docs/WIDGETS.md` (38), `SECURITY.md` (19), `CHANGELOG.md` (7, reworded in place since nothing is released), `docs/TEST-PLAN.md` (9).
- `docs/DESIGN.md` gets a §12 decision entry ("explainer" → "sidestory", `.explain/` → `.sidestory/`). Its body stays as written, as a draft of record.
- The README headline becomes "Rich sidestories beside your code".

**Skill**

- `SKILL.md`: its name stays `sidestory`. Its description and body say "sidestory".
- `references/*`: regenerated by `sync-skill`.
- `.claude-plugin/marketplace.json`: "Write Sidestory explainers: …" → "Write sidestories: …".

### 3.2 What stays, and why

**Format names**, because files already written must keep working and agents already know them:
- `data-explain-*`;
- `<explain-widget>`;
- the widget module `'explainer'` (`import { useStepValue } from 'explainer'`).

The docs say so once, in WIDGETS.md: "Widgets import helpers from the module `explainer` (the format's name; a sidestory is the folder)".

**Internal identifiers:**
- `ExplainerRef`, `ExplainerSession`, `findExplainers`, `explainers.ts`;
- the webview view type `sidestory.explainer`, which VS Code persists for panel restore (changing it would only orphan saved panels, and nothing is released, but it buys nothing);
- command IDs and context keys;
- test file names.

What I'd do: leave all of these alone. Renaming them is churn with no reader benefit, and it collides with the `src/` work in flight. New modules in this plan use neutral names (`index.ts`, `detail-graph.ts`).

### 3.3 Procedure and verification

This rename can't be mechanical. "an explainer" becomes "a sidestory", plurals and capitals change, and the module name `'explainer'` and the file name `explainer.html` must not be touched. So:

1. **List the candidates:**
   ```bash
   git grep --untracked -n -I -i -P '\bexplainers?\b' -- src scripts test package.json README.md SECURITY.md CHANGELOG.md docs/GUIDE.md docs/WIDGETS.md docs/TEST-PLAN.md plugins .claude-plugin \
     | grep -v -E "from 'explainer'|'explainer'\)|explainer\.html|ExplainerRef|ExplainerSession|explainers\.ts|sidestory\.explainer"
   ```
   Use `-P` (Perl regex): with `-E`, `\b` matches nothing here, so the listing would come back empty and look finished. The same applies to every guard grep in this section.

   Tests and scripts are included on purpose, because several assert the old user-facing strings. `git grep -i -E "Explainer: |'Explainer|Open Explainer" -- test` finds 37 hits, among them:
   - `test/e2e/explainer.e2e.ts` and `test/webview/webview.pw.ts`, which check the accessible name `'Explainer path'`;
   - `test/e2e/widgets.e2e.ts`, which checks the tab text `'Explainer: Retry'` (the prefix goes away in §3.1);
   - `test/unit/check-cli.test.ts`, which checks checker messages word for word;
   - `scripts/pin.ts`, whose usage text changes.
2. **Edit by hand**, file by file. In `src/`, only string literals, template strings and `aria-*` / `title` values change; comments may keep the code name.
3. **Guard tests:**
   - `test/unit/wording.test.ts`: every `title`, `description` and `markdownDescription` in `package.json` contains no "explainer" (case-insensitive);
   - a webview Playwright check that the panel's accessible names and visible chrome text contain no "Explainer";
   - checker tests assert the new messages.
4. **e2e helpers** that type command titles (`command(page, 'Sidestory: Open Explainer')`) change to `'Sidestory: Open Sidestory'`.

If Q1 (renaming `explainer.html`) is accepted, it lands in the same commit.

---

## 4. Tops and details

### 4.1 The detail graph

The graph is built per package from the outline of each sidestory's HTML (§6.2):

- **Nodes** are sidestories, keyed by folder name.
- **Edges** A → B come from each `data-explain-detail="B"` in A. They are kept in document order and deduplicated. B must pass `explainerNameSchema` and exist in the same Sidestory folder.
- **Self-links** are dropped.
- **Missing targets** are kept as `brokenLinks` on A. They appear in A's tooltip and the checker reports them (§5.3).

### 4.2 Tops

A sidestory is a top when:

1. **its manifest sets `group`** (§5.2). An author who files a sidestory under a group has said it stands on its own, so a "see also" link from another sidestory's detail doesn't demote it. It is still shown nested under that parent as well; or
2. **nothing links to it** (in-degree 0 after self-links are dropped), as the fallback; or
3. **it represents a cycle with no way in.** Compute strongly connected components with an iterative Tarjan. A source component (one with no edges coming in from other components) that contains no top would otherwise be unreachable (A ↔ B with nothing above them). It gets one representative top, chosen in this order:
   1. the Start-here candidate (§8.2);
   2. the node with the most outgoing edges;
   3. the first by name.

Orphans, with no edges either way, are tops that have no details. After these rules every sidestory is reachable from at least one top.

Rule 1 answers the review finding that in big repositories cross-references are normal and shouldn't hide whole sidestories. Q3 asks whether authors also need an explicit `"top": true` for ungrouped sidestories.

### 4.3 Shared details, cycles and paths

- **Shared details** appear under every parent **(decided)**. They are rendered lazily, child by child, so the tree never enumerates paths.
- **Cycles inside a top** (A → B → C → B) stop where they repeat. A node already on the path is a leaf described "↩ back to *B*". Opening it cuts the trail back to B, as `dive` does.
- **Depth** is capped at `MAX_TRAIL` (16). Deeper nodes are leaves described "nested too deep".
- **The primary path** of a sidestory is a single shortest path from a top, found once per graph build with a multi-source BFS from all tops, which is O(V + E). Ties go to the top whose title sorts first, then to the parent that comes first in the HTML. The rest of the plan uses this path for:
  - labels ("Top › Detail");
  - the status bar;
  - trails when a sidestory is opened from a picker;
  - sidebar reveal and the filter (§8.3).

  It never enumerates all paths. With shared details the graph is a DAG, and the number of paths can grow exponentially.
- **"Also under"** lists a sidestory's direct parents (its in-edges), at most 5 then "and *N* more". These are parents, not paths.

### 4.4 Cost

The graph is O(V + E) per package (Tarjan, plus BFS for the primary paths). It is rebuilt only for packages whose outlines changed. A unit test bounds 5,000 nodes and 20,000 edges at under 50 ms.

The code lives in `src/core/detail-graph.ts`, a pure module with no vscode import.

---

## 5. Separation: packages and groups

### 5.1 Packages (monorepos)

**(decided)** `services/auth/.sidestory/` and `services/billing/.sidestory/` are separate packages. Anchors stay relative to each root, and detail links stay inside one folder.

- **Nested Sidestory folders** are rejected: `.sidestory/x/.sidestory/y` is not a sidestory (§2.1).
- **Labels:** a package is labelled with its root's path relative to its workspace folder, prefixed with the folder name in multi-root workspaces (`api › services/auth`). A root that is the workspace folder itself gets the folder's name.
- **A file's packages** (§7, §9) are:
  - the package whose root is the longest path prefix of the file (by `uriKey`);
  - plus every package that has an anchor in the file. A repo-root `.sidestory/` that anchors `services/auth/x.ts` counts for that file too.

### 5.2 The `group` field

**(decided)** An optional top-level manifest field:

```json
{ "version": 2, "title": "LSM compaction", "group": "Storage", "anchors": { … } }
```

- **Schema** (`src/core/manifest.ts`): a string, trimmed, 1–60 characters, with no control characters. Add it to the `Manifest` type.
- **Lenient parsing.** A bad `group` (wrong type, too long, empty) becomes the diagnostic "group: …; ignored", and the manifest still loads. Today `manifestSchema` would fail the whole manifest on a wrong type, so read `group` outside the zod top-level object, the way anchors are read.
- **Meaning:**
  - The sidestory is a top (§4.2, rule 1) and is listed under that group in the sidebar.
  - Details with no group appear wherever their parents do.
  - A group on a sidestory that is also linked as a detail is fine: it is listed under its group *and* nested under its parent.
- **Matching** is case-insensitive after collapsing whitespace. The displayed spelling is the most common one; ties go to the first by name.
- **Sorting:** groups sort by name (locale, numeric-aware). Ungrouped tops come after the groups, with no "Other" folder. When no top in a package has a group, the group level is skipped.
- **Docs:**
  - the manifest table in GUIDE gets the field;
  - a new subsection, "Finding your way in big repositories" (sidebar, groups, Start here, monorepos);
  - the skill gets it too, then `sync-skill`.

### 5.3 Checker additions

These checks go in `src/cli/check-widgets.ts`, and `check-cli.test.ts` asserts each one.

| Code | Severity | When |
|---|---|---|
| `group` | error | `group` is present but invalid. |
| `unknown-detail` | warning | `data-explain-detail="x"` names no sibling sidestory, or is an invalid name. |
| `detail-self` | warning | A sidestory names itself as a detail. |
| `not-in-sidestory` | warning | Renamed from `not-in-explain` (§2). |

The `--json` report gains `title`, `group`, `steps: {id, title}[]` and `details: string[]`, all taken from the shared outline. That lets agents check what they wrote, and lets tests compare the CLI with the index.

The checker moves to the new tokenizer (§6.2), which also fixes its quadratic behaviour on hostile input.

---

## 6. The workspace index

There is one `SidestoryIndex` per window, owned by `extension.ts` and disposed with it. Sections §7–§10 read from it.

### 6.1 Contents

```
Tier 1  Discovery    ExplainerRef per sidestory                                 (findFiles + watcher)
Tier 2  Metadata     manifest → title, summary, group, anchors {id, file id, range, pinned, color}
                     page     → outline: steps [{id, title, blurb}], anchor→step, detail links
        Derived      per package: detail graph, primary paths, groups (§4, §5)
                     per code file: an interval table of anchors
Tier 3  Resolution   only documents in visible editors (§7.2) and tree nodes on screen (§8.5)
```

**Per sidestory:**
- `ref` and `version`;
- stamps (`mtime`+`size`, or the document version when open and dirty);
- `title`, `summary` and `group`, cleaned by `displayText` (§11.4);
- `anchors` and `outline`;
- `errors`, for the tooltip.

**No quote text is kept.** A quote can be 64k characters, and quotes are fetched only for visible documents (§7.2).

**Compact storage:**
- File keys are interned in a `files: string[]` table (`uriKey` → id), so anchors store a number.
- Anchor ranges and file ids live in packed `Int32Array`s per sidestory.
- Each code file has an **interval table**: anchors sorted by start, with a running maximum of ends, so a lookup by line is a binary search plus a scan of the hits.

**Aggregate caps** (a hostile repository can otherwise reach millions; §11.1):

| What | Cap |
|---|---|
| Sidestories | 5,000 |
| Anchors indexed in total | 100,000 |
| Steps indexed in total | 100,000 |
| Anchors per code file | 2,000, with at most 200 from any one sidestory |
| Detail links (graph edges) in total | 50,000 |

Past a cap, indexing stops for the rest, and the UI says so (tree message, a summary lens).

**Per-file fairness.** The anchors kept for a file are chosen in a deterministic order: sidestories in use first (open panels, recently opened), then by package and name. No sidestory gets more than 200 of a file's slots, so one package or one junk sidestory can't use up a hot file and hide everyone else's lenses.

### 6.2 The outline scanner

The index needs step titles and detail links without a DOM. The host has no DOM, and loading jsdom or parse5 on untrusted files of up to 5 MB is the wrong trade.

**A new tokenizer, not the checker's.** The review measured `src/cli/html.ts` `scanHtml` as **quadratic**:
- `stack.some`/`CLOSES_P` walk the whole stack on every tag (40k nested `<div>`s take 2.4 s);
- the `TAG` regex rescans to the end of the file on unclosed quotes (20k `<a x="…` take 6.5 s on 0.32 MB);
- `</a ` and `<!x` without a closing `>` are quadratic too.

The index would run it without a click, in Restricted Mode, so it is replaced by `src/core/html-scan.ts`:

- **A state machine driven by `indexOf`.** No regex ever runs over an unbounded span. Each character is visited a bounded number of times: an unclosed quote or comment runs to the end of the file once and stops.
- **No stack scans.** It keeps an element stack capped at 512 (deeper nesting is counted but not tracked), plus counters for "inside an anchored element", "open `<p>`" and "inside raw text".
  - It also keeps **a count of open elements per tag name**. An end tag whose name has no open element is ignored in O(1), and an implied end (`li`, `p`, `option`, …) looks at the count first. The stack is walked only when the element is known to be open, and then only down to it.
- **Resumable:** `scanner.feed(budgetMs)` returns when its slice is used up, so the index runs it in 15 ms slices like everything else. It doesn't build `lineIndex`; only the checker computes lines, lazily, for findings.
- **A wall-clock backstop:** a page that hasn't finished after 500 ms of scanning in total is marked `truncated`. It keeps what it found and is shown with "page too complex to outline".
- **`outlineHtml(html)` returns:**
  - `steps: {id, title, blurb}[]`;
  - `anchorStep: Map<anchorId, stepId>`;
  - `details: {name, stepId?}[]`;
  - `truncated`.
- **Step titles** follow one rule, `data-explain-title`, else the first `h1`–`h4`'s text, else the id. An empty value falls through to the next. **The webview's `stepLabel` changes from `??` to the same fall-through**, so an empty `data-explain-title=""` no longer gives a blank tab. One shared function covers both rules.
- **Blurb:** the first `<p>` text, cut at a sentence end or 140 characters.
- **Skipped:** text inside `script`, `style`, `template`, comments and raw-text elements. Elements the panel's sanitizer removes (one list, exported from `src/webview/sanitize.ts`) are skipped too, so the outline matches what the panel shows.
- **Caps:** 500 steps, 200 detail links, 2 KB collected per title or blurb before cleaning, and pages over `MAX_HTML_BYTES` are skipped.
- **It never executes, evaluates or resolves URLs.** Its output is plain strings, cleaned by `displayText`.

**Parity:** a Playwright test (§12.2) compares the panel's steps with `outlineHtml` on every fixture and example.

### 6.3 Discovery

- **Glob:** `**/.sidestory/*/manifest.json`.
- **Excludes:** the current list (`node_modules`, `.git`, `dist`, `out`, `build`, `target`) **merged with the user's `files.exclude`**, read from configuration and joined into one glob. An explicit exclude replaces `files.exclude` (vscode.d.ts), so it has to be merged by hand.
  - Only entries set to `true` are merged. Entries set to `false`, or with a `when` clause, can't be expressed in one glob and are dropped.
  - A pattern that already contains braces is passed through as its own alternative, never nested inside another brace group. A unit test covers this.
  - See also §13, Q8.
- **A stable cut:** request up to 20,000 paths (strings only, cheap), sort them, then keep the first `MAX_SIDESTORIES = 5000`. Asking for 5,000 directly would return an arbitrary 5,000. Past 20,000, the cut is arbitrary and the message says "at least 20,000 found".
- **Messages:** "Showing the first 5,000 sidestories" in the tree and the pickers, and the log lists the packages included.

### 6.4 Watching

- **One shared `SidestoryWatcher` on `**/.sidestory/**`** replaces the widget host's watcher. It parses each path into `{ref, relPath}` (keys by `uriKey`) and dispatches to:
  - the widget host;
  - the index (manifest and page);
  - sessions, which keep their own per-sidestory watchers for now.
- **Deletions the watcher misses.** When a parent folder is deleted, VS Code reports only that folder. If the deleted folder is an *ancestor* of a Sidestory folder (`rm -r services/auth`, or a checkout that drops a package), its path doesn't match the glob. So the index:
  1. treats a delete event whose path is a Sidestory folder or a sidestory folder as removing everything under it;
  2. handles `workspace.onDidDeleteFiles` (deletes made inside VS Code) by prefix;
  3. reconciles on a git HEAD change (the git extension API, as `widgets/git.ts` already uses) and when the window regains focus, throttled to once per 30 s. Reconciling means `stat`-ing known manifests in batches of 50 and dropping the ones that are missing; for 5,000 sidestories that is under 200 ms off the main path;
  4. `stat`s before every read, and drops entries whose read fails because the file is missing.
- **Debounce:** dirty entries are re-read after 300 ms, extended up to 2 s while events keep arriving, so a checkout is one batch. Only the packages touched get a new graph, and one change event fires.
- **Open, dirty `manifest.json` or page:** `onDidChangeTextDocument` for those names (checked first with a cheap basename test, after `scheme === 'file'`) gets the same debounce, read through `readInside`.
- **Workspace folders added or removed:** that subtree is discovered again.
- **No watchers on code files.** Code changes reach the index through document events and `stat` checks (§8.5).

### 6.5 Reading budgets

- Reads go through `readInside` with the existing per-file caps and symlink checks. Four run at a time, and parsing is sliced at 15 ms.
- **Budgets per batch**, for the first build *and* every debounced rebuild:
  - **bytes:** 100 MB of manifests and 200 MB of pages;
  - **outline time:** 10 s of scanning in total (on top of the 500 ms backstop per page), so 5,000 hostile pages can't keep the shared extension host busy for minutes.
- Past a budget, the rest of the batch is listed by name, marked "not read (budget)" or "not outlined (budget)".
  - **Follow-up:** a follow-up batch is scheduled 30 s later for the skipped entries, and again with backoff (to at most every 10 minutes) while they keep hitting the budget. A Refresh or reconciliation also picks them up.
- **Order:** sidestories in use first (open panels, recently opened), then in sidebar order, so the visible part fills first.

---

## 7. Explained here: CodeLens, gutter and status bar

### 7.1 What the reader sees

These apply to code covered by anchors, in a `file:` document shown in an editor. Documents over `MAX_CODE_BYTES` are skipped.

**CodeLens** (`sidestory.codeLens.enabled`: default `true`, language-overridable; §13, Q4)

- One lens above the first line of each covered region:
  `$(book) Stream DMA engine › DMA controller · step 3: FSM states`
- Regions starting on the same line share one lens: "… and 2 more", which opens the quick pick.
- A file gets lenses for its first 30 covered lines, then one more lens on the 31st line: "+*N* more sidestory steps in this file", which opens the quick pick for the whole file. The count doesn't jump from 30 lenses to 1.
- No lens for lost anchors. Stale ones end with "(code changed a lot)".
- **Lenses are hidden for every anchor of any sidestory shown in a visible panel**, not just its current step. The set of hidden lenses then stays fixed while the reader steps through, and lines don't jump on <kbd>Alt</kbd>+<kbd>]</kbd>. The panel already highlights that sidestory's code.

**Gutter** (`sidestory.gutter.enabled`, default `false`)

- A book glyph on the first line of each covered region, plus a mark in the overview ruler (left lane, color `sidestory.explainedRuler`).
- It is off by default because the gutter is crowded.

**Status bar** (`sidestory.statusBar.enabled`, default `true`)

- One item: `StatusBarAlignment.Right`, next to Ln/Col (it is cursor-specific), with `name: "Sidestory"` so the built-in context menu can hide it.
- **It shows only sidestories that no visible panel shows.** The session's cursor sync (`onSelection` → `syncTo`) already moves the open panel to the cursor's step, so showing that sidestory would flash on and off.
- It also skips details that the visible panel already offers through `childHint` (a detail of the sidestory being shown).
- Text: `$(book) Stream DMA engine › DMA controller · step 3`, or `$(book) Also in: …` while a panel is open. Middle-truncated to 60 characters.
- Tooltip, plain text: the full path, the step title, "Also under *X*", "*N* more cover this line", "Click to open".
- Glyph: §13, Q6.

### 7.2 Resolving positions where they are seen

- **Which anchors cover a line:** the file's interval table (tier 2), O(log n + hits).
- **Where they are now:**
  - **Pinned anchors** (they have a `quote`) are resolved with `resolveAnchor` against the live document, with the session's hints, hysteresis and live tracking. A lens on the wrong lines is worse than a late one, so a manifest `range` never places a lens for a pinned anchor.
  - **Unpinned anchors** resolve to their `range` (`resolveRange`), so the approximation *is* the answer and needs no quote.
  - **When a cheap approximation is enough:** the manifest range is used only to decide which files to resolve and in what order.
- **Quotes:**
  - The tier-2 pass already parses every manifest. In that pass it also records, for each pinned anchor, **where its quote sits in `manifest.json`**: the offset and length of the `quote` object's source text, plus the manifest's stamp. A small position-recording JSON scan finds these, run alongside `JSON.parse`; it is linear and capped by the 1 MB manifest limit.
  - Resolving a document then reads **only those slices**, through a new `readSliceInside(uri, root, offset, length)`. It runs the same `realPathInside` and size checks as `readInside`, then does a positioned read (`fs.open` plus `read` at an offset) on the real path.
  - Offsets are **UTF-8 byte offsets**, not string indices, which differ once a manifest has non-ASCII text.
  - Each slice is **untrusted**. It is `JSON.parse`d as a quote object and its length is checked against the recorded length plus a short hash. On any mismatch, or if the stamp changed, the manifest is marked dirty and its tier-2 pass re-runs, counted against the batch budget. This catches a same-size edit within the stamp's mtime granularity.
  - An **open, dirty `manifest.json`** has no valid file offsets, so its quotes come from re-parsing the buffer.
  - **Details of the slice check:**
    - The position scanner keeps the *last* occurrence of a duplicate key (a repeated anchor id, or a repeated `quote`), as `JSON.parse` does.
    - The recorded hash is taken from the **parsed** quote (`exact`, `prefix`, `suffix`, `norm`), not from the slice's bytes, so a mismatch between the two parses is caught.
    - A parsed slice also goes through the same zod quote schema (`LIMITS.quoteChars`, `quoteLines`, `contextChars`).
    - On non-`file:` schemes, where no positioned read exists, the fallback is a whole-file read, counted against the shared budget.
  - Quote fetches share **one read budget across all documents**: 4 MB at once, refilling at 1 MB/s. What doesn't fit is resolved later as the budget refills. This is what bounds the case of one file anchored by 1,000 sidestories with 1 MB manifests: about 2,000 slices of a few KB each, not 1 GB of manifests.
  - Fetched quotes go into a **quote cache keyed by (sidestory, anchor id, stamp)**, at most 20 MB of quote text, evicting by document.
  - This replaces the per-manifest LRU of revision 1, which thrashed when more than 32 sidestories anchored one hot file, and revision 2's "re-parse the manifest once per stamp", which had no budget.
- **Scope:**
  - at most 8 documents resolving at a time (`visibleTextEditors`, including split and diff editors);
  - results (ranges and states, **never `PreparedText`**) are kept for 60 s after a document is hidden, in a 20-document LRU;
  - closing a document drops its results.
- **Work:**
  - one `PreparedText` per (document, version), **shared with sessions** through a small `PreparedTextCache` of 2 entries keyed by `uriKey` and version. An entry is dropped 5 s after its last use, and documents over 1 MB are never cached: a 10 MB file's `PreparedText` is 60 MB or more;
  - one `resolveAnchor` per anchor;
  - sliced at 15 ms and checked against the document's sequence number;
  - `WORK_BUDGET` bounds each anchor;
  - at most 2,000 anchors per file (§6.1).
- **Sharing with open panels:**
  - A session showing sidestory E already resolves E's anchors in this file, so the index uses the session's results for E.
  - New session surface: `onDidResolve(uri)`, `onDidSwitch()`, and `resolutionsFor(uri)`, which returns results only while the session's `ref` and generation match the ones the index recorded. `switchTo` clears `resolutions` before reloading, so the check happens when the results are read, not just on events.
  - The index drops the overlay on switch or dispose.

### 7.3 Live edits and the cursor

**`onDidChangeTextDocument`** (every keystroke, in every document):

1. If `scheme !== 'file'`, return. That cheap check skips output channels and the like.
2. Look up `uriKey` in the file map. If the file isn't anchored, return.
3. Otherwise move each trusted hint with `trackRange`, sharing `endTails` with the session. This is bounded by the 2,000-anchors-per-file cap.
4. Bump the document's sequence number.
5. Re-resolve 400 ms after the last edit, if the document is still visible.
6. Fire `onDidChangeCodeLenses` only when a start line or a state changed.

**`onDidChangeTextEditorSelection`** (debounced 100 ms):

- interval lookup, then the choice: tightest, not stale, not shown in a panel (§7.1);
- the status item is updated only when its text changes;
- no I/O. Until results exist, the item stays hidden.

**`provideCodeLenses(document, token)`:**

- returns `[]` at once for files that aren't anchored;
- returns cached results for the current version;
- otherwise starts a resolve, waits **at most 50 ms**, and then returns what it has (possibly `[]`). When the resolve finishes, it fires `onDidChangeCodeLenses`.

VS Code collects every provider's lenses before rendering them, so a slow resolve here would delay other extensions' lenses.

The trade-off: on a large file that was just opened, the lenses can arrive after the first render, and the code then shifts down a line where each lens appears. To make that rare, resolving starts on `onDidChangeVisibleTextEditors`, before VS Code asks for lenses. A file already resolved within the last 60 s has its lenses ready at once.

### 7.4 Opening from code

- **One covering anchor:** `sidestory.openAt({dir, anchor, trail: primary path})`.
- **Several:** a quick pick, tightest first.
  - label: the step title;
  - description: `Top › Sidestory · step N`;
  - detail: the state, when it isn't exact;
  - one item per (sidestory, anchor), with nested anchors folded into their step.
- **Command "Show Sidestories for This Code"** (`sidestory.showHere`) does the same from the palette or the editor context menu (`when: sidestory.coveredHere`).

### 7.5 `sidestory.openAt` and where things open

This is one entry point for CodeLens, the status bar, the tree, Go to Step and Open Sidestory:

```ts
sidestory.openAt({ dir: string, anchor?: string, trail?: string[] /* names, top first */, newPanel?: boolean })
```

**Validation.** Other extensions can call commands, so every argument is checked:
- `dir` through `refFromDir`;
- trail names through `explainerNameSchema`, as siblings, the same way `restoredTrail` checks them;
- `anchor` through `anchorIdSchema`;
- a trail longer than `MAX_TRAIL` is cut.

**Where it opens:**

1. A panel already showing `dir`: reveal it and `goTo(anchor)` in it, keeping its trail.
2. Else, if the **current panel's trail starts at the same top** as the target trail, switch that panel to the target trail. The reader stays within one top, so the trail's **Back** still leads to everything they saw.
3. Else, if there is a **preview panel**, switch it. A preview panel is the newest panel opened by `openAt` in which the reader hasn't navigated since it opened: no step change, dive or scroll that moved the active section. It works like the editor's preview tab: it holds nothing the reader would lose.
4. Else, **a new panel** beside the editor, which becomes the preview panel. `switchTo` replaces the trail and `positions` is reachable only through the new trail, so reusing a panel the reader has worked in, across tops, would lose their place.

**What counts as navigating:** any reader action in the panel ends its preview status. Only actions inside the panel count: a step change, a dive or Back, a widget input, or a scroll that moved the active section. A cursor sync from the code does not count, so a reader who clicks a lens and then reads the code keeps one panel being reused.

**Making the preview visible.** Webview tab titles can't be italic, so a preview panel:
- uses a distinct `iconPath`;
- shows "Preview: the next sidestory you open from code or a list replaces this one" in its trail bar, with a **Keep Open** button.

Opening the same tree item a second time within 500 ms also keeps the panel it opened. Trees have no double-click event, but a double-click arrives as two invocations of `TreeItem.command`. With `workbench.list.openMode: doubleClick`, every open from the tree keeps its panel.

So clicking lens after lens, or Go to Step result after result, reuses one panel until the reader actually reads in it. Tabs don't pile up.

`newPanel: true` forces case 4. `sidestory.open` from the palette or the Explorer keeps today's behaviour: reveal the panel showing it, else a new panel. See §13, Q5.

**New session method `goTo(anchorId)`:**
- sets `active`, posts `syncTo` and calls `requestReveal(anchorId, false)`;
- during a switch (`initGeneration !== generation`), it only sets the pending `active`, which `sendInit` carries.

**Recently opened:** every open, switch and dive records `dir` in `workspaceState` `sidestory.recent` (30 entries) for §10.

---

## 8. The Sidestory sidebar

### 8.1 Where, and when it shows

**Recommendation: its own view container in the activity bar** (icon `media/sidestory.svg`), holding one view, `sidestory.tree`, titled "Sidestories".

- A big repository's tree is too tall to share the Explorer, and the container leaves room for later views (threads).
- Users can still drag the view into the Explorer.

**Visibility:**

- Contributed containers are shown in every workspace, even before activation, so the view has `when: sidestory.available`.
- The key is set to true at activation, and it is also **remembered in `workspaceState`**, so it survives reloads. It is cleared when a rebuild finds no sidestories, unless "Show Sidestories" set it.
- Activation happens on `workspaceContains:**/.sidestory/*/manifest.json`, and when the command **"Sidestory: Show Sidestories"** runs. That command sets the key and focuses the view, which is how someone in a repository with no sidestories finds the welcome view.
- **First sidestory in a fresh repository.** `workspaceContains` is checked at startup and when workspace folders change, not when files are created. So when an agent writes the first `.sidestory/x/`, nothing would activate. To cover this, also activate on **`onStartupFinished`** with a minimal path:
  - read the remembered key;
  - create one `**/.sidestory/*/manifest.json` watcher (honouring the merged exclusions of §6.3, so files under `node_modules` don't wake it) whose create event, if `refFromDir` accepts the folder, sets the key and loads the rest. A stray `manifest.json` that isn't laid out as a sidestory loads nothing;
  - load everything else (index, tree, CodeLens, zod, the resolver, the widget host) only once a manifest exists or a command runs.

  **Two bundles.** The build makes a single CJS file today, where a dynamic `import()` doesn't split the bundle. So the bootstrap becomes its own esbuild entry point: `main` is a tiny `dist/extension.cjs` that `require`s `dist/full.cjs` on demand, and every command and view registered in `package.json` routes through it.

  - The first command or view that needs `full.cjs` waits for it to load. While it loads, the command shows `window.withProgress` (in the window's progress area) and the view shows its "loading" welcome state, so the first click never looks dead.

  The cost in unrelated workspaces is then one small module and one watcher. The activation test in §12.1 asserts both the time and the bootstrap's size, and that it requires nothing but `vscode` and `full.cjs` (lazily).
- So the icon never clutters unrelated workspaces. §13, Q2 covers the Explorer-view alternative.

### 8.2 Structure

Levels appear only when needed:

```
Sidestories
├─ services/auth                      ← package: only when there is more than one
│  ├─ $(home) Auth overview  Start here · 5 steps
│  ├─ Storage                          ← group: only when some top in the package has one
│  │  └─ LSM compaction   6 steps
│  │     ├─ Memtable      4 steps
│  │     └─ SSTables      5 steps · 2 out of date
│  └─ Retry loop          3 steps     ← ungrouped tops after the groups
└─ services/billing …
```

**Package node:**
- label: the package label (§5.1);
- description: "*N* sidestories";
- icon: `folder-library`;
- expanded when there are 3 packages or fewer.

**Group node:**
- label: the group name;
- description: "*N* sidestories";
- icon: `symbol-namespace`.

**Sidestory node:**
- **label:** the title, else the folder name;
- **description:** "*N* steps", plus drift when known ("· 2 out of date", "· 1 lost"). A grouped sidestory that is also a detail adds "· also under *X*" in both places, so it doesn't look like a duplicate;
- **tooltip:** plain text: title, summary, `.sidestory/<name>`, "Also under: …" (parents, §4.3), broken detail links, parse errors;
- **icon:** `book` for a top and `file-text` for a detail, or `warning` tinted `sidestory.staleForeground` / `lostForeground` when drift is known;
- **`id`:** stable, made from the path, so VS Code keeps expansion across refreshes;
- **`contextValue`:** `top`, `detail`, `cycle` or `broken`.

**Start here** is the first match of:
1. a sidestory named `overview`;
2. the only one named `*-overview` (stream-dma's `dma-overview`, tiny-lsm's `lsm-overview`);
3. the package's only top that has details.

It is pinned first in the package with the `home` icon and "Start here", and isn't repeated in the sorted list. If it is also a detail somewhere, it still shows there. §13, Q7 asks about a manifest flag instead.

**Order:** packages by path. Within a package: Start here, then groups, then ungrouped tops, each sorted by title (locale, numeric-aware). Details follow the parent's HTML order, which is the author's reading order.

**"*N* steps"** is the outline's step count (§6.2). The panel's peek "+*N* steps" (`session.describe`, which counts `m.anchors.size` today) switches to the same count, from the index when available. Readers then never see two different numbers.

### 8.3 Interaction

- **Click:** `sidestory.openAt` with the node's path as the trail, so the panel's **Back** retraces the tree.
- **Inline action:** "Open in New Panel".
- **Context menu:** Open, Open in New Panel, Go to Step… (in this sidestory), Pin Anchors, Check Widgets (`when: isWorkspaceTrusted`), Copy Widget Check Command, Reveal in Explorer, Copy Path.
- **Title bar:** Go to Step…, Filter…, Clear Filter (`when: sidestory.treeFiltered`), Refresh (rediscover everything), Collapse All (`showCollapseAll`).
- **Filter**, set in an `InputBox` and remembered per workspace:
  - matches case-insensitively on title, name, summary and group;
  - **each match is shown once, under its primary path** (§4.3), with the path expanded and the match highlighted (`TreeItemLabel.highlights`). It never shows every path to a shared detail;
  - at most 2,000 nodes are rendered. Past that, the message reads "Showing 2,000 of *N* matches; refine the filter";
  - `treeView.message` reads `Filtered by "dma": 7 sidestories`. When nothing matches, only the message shows; the welcome view stays hidden;
  - matching runs over the index's flat list, never by walking the tree.
- **Follow the panel** (`sidestory.sidebar.followPanel`, default `true`):
  - when a panel's sidestory changes and the view is visible, call `reveal(node, {select: true, focus: false})`;
  - the provider implements **`getParent`**, which `reveal` needs, through a map from node id to node. The map is filled as nodes are created and cleared on refresh. Ids encode each part (`encodeURIComponent`) so they stay unique, but the code never parses them back: package paths and group names can contain `/`;
  - a trail that doesn't start at a top (opened from the Explorer, say) maps to the primary path.

### 8.4 Welcome views

All three are static text from `package.json`, so their command links are ours, never repository text.

- **`workbenchState == empty`** (no folder open):
  > Open a folder to see its sidestories.
  >
  > [Open Folder](command:workbench.action.files.openFolder)
- **`sidestory.indexState == empty`:**
  > No sidestories in this workspace yet. A sidestory is a folder in `.sidestory/` with a page and a `manifest.json`, shown beside the code and linked to it.
  >
  > [Read the Guide](…) · [Copy a Prompt for Your Agent](command:sidestory.copyAgentPrompt)
  >
  > Or, in Claude Code, `/plugin install sidestory@sidestory`, then ask: *"Explain how … works, with Sidestory."*
- **`sidestory.indexState == loading`:** "Looking for sidestories…".

**`sidestory.copyAgentPrompt`** copies the same fixed text as the README's "Ask your agent".

### 8.5 Drift badges

Drift is the number of anchors that are changed, stale or lost. Working it out means resolving every anchor of a sidestory, which is the expensive part.

**When:**
- only for nodes being shown: `getChildren` queues them (newest first, at most 200 queued);
- one sidestory at a time, sliced at 15 ms;
- paused while the reader typed in the last second.

**Budgets:**
- `stat` before every read;
- files over **1 MB** are skipped and counted as "unchecked", not "lost";
- at most **20 MB read per sidestory**;
- at most **200 MB per rolling 10 minutes** overall, after which the queue waits.

These limits apply in every mode, including Restricted Mode, where drift still runs because it only reads.

**Computation:**
- the manifest (quotes taken in the same pass);
- each anchored file once, through `readInside`;
- one `PreparedText` per file, dropped right after;
- `resolveAnchor` without hints, which is the "fresh open" state a badge should report.

**Cache:**
- keyed by the manifest stamp plus each file's stamp;
- reused while `stat` still matches;
- 2,000 entries, a few numbers each.

**Invalidation:**
- a change to or save of an anchored file (found through the file map);
- a manifest change;
- a git HEAD change, which marks everything dirty;
- Refresh.

Dirty entries are recomputed only when they are shown again.

**Display:** while drift is unknown, the description says just "*N* steps", never "checking…". For a sidestory open in a panel, its live states are used.

---

## 9. Go to Step

**"Sidestory: Go to Step…"** (`sidestory.goToStep`), in the palette, the view title and the tree's context menu. There is no default keybinding (§13, Q9).

**Items:** one per step.
- label: the step title;
- description: `Top › Sidestory · step N`;
- detail: the step's blurb, else the sidestory's summary;
- `matchOnDescription` and `matchOnDetail` are on.
- Sidestories not outlined yet contribute their anchor ids as provisional items, replaced when the outline arrives (`busy` set meanwhile).

**Scope:**
- **This package** means the file's packages (§5.1): the longest-prefix package plus every package that anchors the file. When no editor is active, the current panel's package is used.
- **All packages** means everything.
- A toggle button (`$(filter)` / `$(filter-filled)`) switches scope, and the title names the scope.
- The default is This package when there is more than one package and a current one exists. The last choice is remembered.
- Opened from the tree with `{dir}`, the scope is that one sidestory.

**Order before typing:**
1. steps of the sidestory in the current panel;
2. steps of recent sidestories;
3. the rest, in package, top, sidestory and step order.

Once the reader types, the quick pick ranks by match.

**Cap:**
- at most **20,000 items**;
- past that, This package is forced when a package is known;
- otherwise the first 20,000 in the order above are shown, and the placeholder says "Showing 20,000 of *N* steps; narrow with This package";
- items are built once per invocation, from memory.

**Accept:** `openAt({dir, anchor: stepId, trail: primary path})`.

---

## 10. Open Sidestory

The new `pickExplainer` behind "Sidestory: Open Sidestory…":

**Items:**
- label: the title, or the folder name when there is none. A detail's label is `Top › Detail` (its primary path);
- description: `<package>/.sidestory/<name>`, plus "also under *N* others" for shared details. The description is searched too;
- detail: the summary.

**Order:**
1. a "Recently opened" separator and the recent list, newest first;
2. an "All sidestories" separator and the rest in tree order: package, then Start here, then groups, tops and details.

Each sidestory appears once.

**No 200 cap.** The list follows `MAX_SIDESTORIES` (5,000), and the placeholder says when discovery was cut.

**Before the index is ready**, names from discovery show at once with `busy` set, and titles replace them as metadata arrives, keeping the active item.

**Opening:**
- `openAt({dir, trail: primary path})`, so a detail opens with its top on the trail and Back leads to the top (§13, Q5);
- the Explorer's context menu (`sidestory.open` with a `dir`) keeps today's behaviour: just that sidestory;
- with one sidestory, it opens directly; with none, the message points to "Show Sidestories" and the guide.

---

## 11. Performance, memory, lifecycle and security

### 11.1 Budgets and caps

The targets are for a large workload: 1,000 sidestories, 50,000 anchors, 50,000 steps and 5,000 anchored files. The caps bound what a hostile repository can force. The tests in §12 measure both.

| What | Target or cap |
|---|---|
| Synchronous work added to activation | < 20 ms |
| Discovery, cold | < 500 ms (the tree shows names) |
| Metadata and graphs, cold | < 3 s in the background, sliced |
| Keystroke in a file that isn't anchored | A scheme check and a `Map` lookup |
| Keystroke in an anchored file | `trackRange` per anchor, ≤ 2,000 anchors, < 2 ms, no I/O |
| Cursor move | Debounced 100 ms; interval lookup; no I/O |
| Outline of one page | ≤ 500 ms total (backstop), sliced at 15 ms; linear on hostile input |
| Sidestories / anchors / steps / anchors per file | 5,000 / 100,000 / 100,000 / 2,000 |
| Bytes read per batch | Manifests 100 MB, pages 200 MB |
| Drift reads | 1 MB per file, 20 MB per sidestory, 200 MB per 10 min |
| Index memory | About 120 B per anchor (interned file ids, packed ranges, id string) and about 450 B per step (title ≤ 120 + blurb ≤ 140 characters, as UTF-16). The large workload is about 30 MB; the caps bound it at about 60 MB. |
| Quote cache | 20 MB |
| Resolved documents | 8 active, 20 kept (results only) |
| Drift cache / queue | 2,000 / 200 |
| CodeLens per file | 30, plus one "+*N* more" |
| Quick pick items / filtered tree nodes | 20,000 / 2,000 |

The review measured revision 1's "40 B per anchor" at about 350 B, because file keys weren't interned and each entry was an object. Interning and packed arrays fix that, and a test asserts the new numbers (§12.1).

### 11.2 Lifecycle and the generation counters

**Ownership.** `extension.ts` creates the watcher, the index, the tree provider, `ExplainedHere` (CodeLens, gutter and status) and the commands, and pushes all of them onto `context.subscriptions`. Each `dispose()`:
- clears its timers;
- bumps its counters, which cancels work in flight;
- disposes its watchers, emitters, decoration types and status item.

A test checks that no timers or watchers remain after `deactivate`; the stub counts watchers.

**Counters** (the session's pattern):

| Counter | Bumped | Check |
|---|---|---|
| `index.epoch` | on a full rebuild | Async work drops its results when the epoch has changed. |
| `entry.version` | per sidestory, on each event for its files | A read applies only if the version is unchanged. |
| `doc.seq` | per document, on each edit and resolve | Checked at every slice. |
| Session generation | — | The index never reads session state directly. Overlays are tagged with `(session, dir, generation)` and checked when read (§7.2). |

**Startup:** discovery, then metadata in sidebar order, then graphs, then a tree refresh. The CodeLens provider and status bar exist from activation and answer `[]` (or stay hidden) until the file map is ready.

**Events:** one `onDidChangeTreeData` per batch, scoped to the package node when only one package changed.

**Settings** take effect immediately; turning a feature off disposes it.

### 11.3 Restricted Mode and untrusted repositories

The index only *reads* repository text and shows it as text, as the panel already does in Restricted Mode. So §7–§10 work there too, with these rules:

- **Nothing opens by itself.** Panels open on a click or Enter only. Restore is unchanged: no restore in Restricted Mode.
- **Nothing executes.** Nothing from the index reaches the widget compiler, and "Check Widgets" is hidden in untrusted workspaces.
- **Work is bounded.** Every cap in §11.1 applies in every mode, and the outline scanner is linear with a backstop (§6.2). A hostile repository can at most make the index stop early, and the UI then says why.
- **Paths:** `isSafeRelativePath` and `readInside` (symlinks followed and checked) cover every read. Discovery results still go through `refFromDir`.
- **`openAt` arguments are validated** (§7.5).

### 11.4 Repository text in native UI

Titles, summaries, step titles, blurbs, group names and **folder names** come from the repository. They are untrusted and may be crafted to mislead.

**1. Clean once, when stored**, with `displayText(s, max)` in `src/core/display-text.ts`. It removes:
- C0 and C1 controls, and U+2028/U+2029;
- bidirectional marks, overrides and isolates (U+061C, U+200E/F, U+202A–E, U+2066–9);
- invisible characters (U+00AD, U+200B–D, U+2060–4, U+FEFF);
- tag characters (U+E0000–E007F);
- lone surrogates.

Then it collapses whitespace and cuts at `max` with "…", without splitting a surrogate pair. Folder names need it too: on Linux they can contain newlines and still pass `refFromDir`.

**2. Escape for each surface**, at the moment the text is shown:

| Surface | Renders | Treatment |
|---|---|---|
| Quick pick `label`, `description` **and `detail`**, and quick pick `title` / `placeholder` when they name a package or sidestory | `$(icon)` | `escapeIcons`: `$(` → `\$(` |
| Webview panel tab title (`panel.title`, the repository title) | plain text | `displayText` (no escaping needed) |
| Status bar text | `$(icon)` | `escapeIcons` |
| CodeLens title | `$(icon)` | `escapeIcons` |
| Tree label and description | nothing | **No escaping.** It would show a literal backslash. |
| Tooltips (tree, status bar) | plain `string` only | **Never `MarkdownString`**, so no links, `command:` URIs, images or HTML. A rich tooltip, if ever wanted, must use `MarkdownString` with `isTrusted: false`, `supportHtml: false` and `supportThemeIcons: false`, filled only through `appendText`. |
| **Notifications** (`show*Message`) | `[text](link)`, including `command:` links | `plainForMessage()`: `displayText`, then break link syntax by turning `](` into `] (`. **This includes the existing unpinned notice in `session.ts`**, which already puts the repository title in a notification. That is a pre-existing gap the plan fixes. |
| Webview | (sanitized as today) | Unchanged |

**3. Command arguments are ours:** `{dir, anchor, trail}`, built from validated refs, never strings from the HTML.

**4. `SECURITY.md`** gets a new row: "Spoofing in native UI (sidebar, CodeLens, status bar, pickers, notifications): repository text is plain text. Control, bidirectional and invisible characters are removed, icon and link syntax is escaped, and there is no markdown or command in tooltips."

---

## 12. Tests

### 12.1 Unit (vitest)

**`detail-graph.test.ts`**
- a top with nested details, in HTML order;
- a shared detail appears under both parents;
- `group` makes a top even when the sidestory is linked;
- a cycle with no way in, testing each tie-break;
- a cycle inside a top gives a back-link leaf;
- self-links are dropped;
- broken links and invalid names;
- orphans;
- the depth cap;
- every node is reachable (property test, 500 random graphs);
- the primary path is the shortest and deterministic;
- **a layered DAG (16 layers × 8)**: primary paths and "also under" stay O(V + E) (< 20 ms);
- 5,000 nodes and 20,000 edges in < 50 ms.

**`packages.test.ts`**
- no package level when there is one package;
- labels in single- and multi-root workspaces;
- a file's packages are the longest prefix plus those anchoring it (case-insensitive on macOS and Windows);
- nested `.sidestory` is rejected;
- group merging, spelling and order;
- Start-here rules: `overview`, a single `*-overview`, the single top with details, and none.

**`html-scan.test.ts`**
- title rules, including empty values falling through;
- entities, nested anchors, details in comments, scripts and templates;
- sanitizer-removed elements;
- caps and `truncated`;
- resumable feeding gives the same result as one call;
- **hostile shapes, each at 5 MB, each under 1 s total and under 20 ms per slice:**
  - 1M nested `<div>`s;
  - repeated `<a "` with no closing quote;
  - unclosed `<a x="…`;
  - `</a ` with no `>`;
  - `<!x` with no `>`;
  - an unclosed comment;
  - an attribute 1 MB long;
  - stray end tags (`</x>`) under 512 open elements;
- the checker's `scanHtml` passes the same shapes.

**`display-text.test.ts`**
- every character class in §11.4;
- surrogate pairs aren't split;
- `escapeIcons`;
- `plainForMessage`.

**`index.test.ts`** (the vscode stub gains `findFiles`, `CodeLens`, `StatusBarItem`, `TreeItem` and `onDidDeleteFiles`):
- the stable cut at 5,000 (from shuffled `findFiles` results);
- the merged `files.exclude`;
- watcher dispatch;
- **a Sidestory folder delete, an ancestor delete (reconciled through HEAD change and focus), and `onDidDeleteFiles`**;
- a 300-event burst gives one batch;
- a dirty open manifest;
- **byte budgets per batch, in the first build and in rebuilds**;
- version and epoch races;
- the file map after anchors move;
- `trackRange` on edits, and work abandoned at the next slice;
- the debounce;
- `onDidChangeCodeLenses` fires only on a real change;
- the session overlay is dropped on switch, on dispose, and on a generation mismatch at read time;
- **one file anchored by 1,000 sidestories with 1 MB manifests**: opening it reads only quote slices (a few MB), within the per-document budget, never whole manifests; stale stamps trigger a tier-2 re-read;
- quote slices: a manifest edited to the same size (the length and hash check catches it), a non-ASCII manifest (byte offsets), a dirty open manifest (re-parsed buffer), and the shared refill budget across many visible documents;
- `PreparedTextCache` expires entries after 5 s and never holds documents over 1 MB;
- per-file fairness: one sidestory with 2,000 anchors on a file takes at most 200 slots, in a deterministic order;
- the total edge cap, the per-batch scan-time budget, and the follow-up batch for skipped entries;
- reconciliation on focus is throttled to once per 30 s;
- `files.exclude` merging drops `false` and `when` entries and handles brace patterns;
- tree ids with `/` in package paths and group names, with `getParent` through the id map;
- `onStartupFinished` activation in a workspace without sidestories stays under 5 ms and creates one watcher, and creating the first manifest shows the view;
- the aggregate caps and the per-file cap;
- dispose leaves nothing behind.

**`explained-here.test.ts`**
- lens titles, merging, 30 lenses plus "+*N* more";
- nothing for lost anchors, a suffix for stale ones;
- **every anchor of a sidestory in a visible panel is hidden, and stepping doesn't change the set**;
- status bar: on the right, `name`, skips sidestories shown in panels and `childHint` details, truncation;
- non-`file` schemes are ignored;
- `provideCodeLenses` returns within 50 ms on a slow resolve, then fires a change;
- the setting toggles.

**`drift.test.ts`**
- only shown nodes are queued;
- the 1 MB skip ("unchecked"), the per-sidestory and rolling budgets;
- stamp reuse;
- invalidation sources.

**`open-at.test.ts`**
- argument validation;
- reveal plus `goTo` while a switch is pending;
- reuse when the top is the same, then the preview panel, then a new panel, which becomes the preview; navigating in a panel ends its preview status;
- `sidestory.open` behaviour is unchanged;
- the recent list.

**`pickers.test.ts`**
- Open Sidestory order, `Top › Detail` labels, no 200 cap;
- Go to Step scope (including root packages that anchor the file), the 20,000 cap, provisional items.

**`wording.test.ts`** and **`rename.test.ts`** (§2.3, §3.3).

**Memory:** `memory.test.ts` runs in its own vitest pool (`--pool=forks --execArgv=--expose-gc`). It builds an index over 50,000 synthetic anchors and 50,000 steps, calls `gc()` and asserts the per-item sizes in §11.1, within 1.5×.

**Per-push microbenchmarks**, with loose thresholds (3× the targets) so they flag regressions without flaking:
- keystroke fan-in with 2,000 anchors in one file;
- outlines of the 5 MB hostile pages;
- the layered-DAG filter.

**Additions to existing tests:**
- `core.test.ts`: `group` parsing, where an invalid value gives a diagnostic and the manifest still loads;
- `check-cli.test.ts`: the new codes, the `--json` outline and the `sidestory` key.

### 12.2 Playwright, webview harness

The tree and CodeLens are native, so the harness covers only the panel's side.

- `init` with `active` set to a nested anchor lands on its step;
- `syncTo` while hidden or switching is applied when shown;
- **outline parity:** for every fixture and both examples, the panel's step ids and labels equal `outlineHtml`'s (whitespace collapsed on both sides);
- `stepLabel` falls through on an empty title;
- no "Explainer" in the accessible names or the chrome (§3.3).

### 12.3 End to end (browser VS Code in Docker)

The workspace gains a second package, `services/auth/.sidestory/` (two sidestories, one with `group`, and one detail that the other package's tree also cross-links), next to stream-dma. Tests run in **Restricted Mode**, as the suite does today.

**`sidebar.e2e.ts`**
- the activity bar icon and the "Sidestories" view;
- two packages; stream-dma shows `dma-overview` as Start here, with seven details in HTML order;
- expansion is kept across a refresh;
- clicking a detail opens a panel with a two-step trail, and Back returns to the top;
- the filter "fifo" shows one path, and Clear restores everything;
- a filter that matches nothing shows a message, not the welcome;
- tooltips are plain text;
- a drift badge appears after a heavy edit to an anchored line;
- the welcome view in a workspace with no sidestories (opened through "Show Sidestories"), and in an empty window;
- "Check Widgets" is missing from the context menu;
- a title containing `$(alert)` shows literally in quick picks and has no backslash in the tree.

**`explained-here.e2e.ts`**
- `rtl/dma_ctrl.sv` shows `Stream DMA engine › DMA controller · step N`;
- clicking it opens at that step, and every lens for that sidestory disappears while it is open;
- stepping with <kbd>Alt</kbd>+<kbd>]</kbd> doesn't change the lens set;
- overlap gives a quick pick;
- the status item, on the right, appears only for sidestories that aren't open;
- typing above moves the lens;
- turning the setting off removes lenses.

**`go-to-step.e2e.ts`**
- "backpressure" finds the step;
- the scope toggle;
- Enter opens at the step.

**`explainer.e2e.ts`**
- the helper picks by title through "Open Sidestory";
- recent sidestories come first.

### 12.4 Desktop VS Code (Electron, LF and CRLF)

- `vscode.executeCodeLensProvider` on `rtl/bit_reader.sv`: titles and arguments; lenses follow a `WorkspaceEdit`; different path case on macOS and Windows.
- `sidestory.openAt` with a trail opens the tab and puts the editor on the step.
- The rename: only `.sidestory/` activates, and a stray `.explain/` is ignored.
- **Perf smoke** (`CX_PERF=1`; weekly in CI, and run locally before each phase merges):
  - a generated workspace with 1,000 sidestories, 50 anchors each, over 5,000 files;
  - the index is ready in < 5 s;
  - a keystroke averages < 2 ms;
  - both measured through the hidden `sidestory._indexStats`, which is registered only in `ExtensionMode.Test`.

---

## 13. Open questions

**Decided 2026-10-23:** the user accepted every recommendation below, including `"top": true` (Q3).

Each question has a recommendation.

1. **Rename `explainer.html`?** The options are keeping it, `index.html`, or `sidestory.html`.
   - **Recommend `sidestory.html`**, in the same commit as the folder rename. With the folder and the product both called sidestory, "explainer.html" is the one leftover of the old word that every author and agent types.
   - `sidestory.html` says what it is, is easy to grep, and can't be mistaken for a web root. `index.html` invites dev servers, linters and site generators to treat `.sidestory/` as a site.
   - Cost: 34 files today (`git grep --untracked -l 'explainer\.html'`). They include:
     - `htmlUri`, the session's own-file checks, and the watchers;
     - the checker, including its `explainer\.html$` argument test;
     - tests and docs;
     - the skill's frontmatter `description`, which uses "explainer.html" as a trigger phrase;
     - every example page, including the ones the tiny-lsm agent is writing now.

     - **the page files themselves**, one per sidestory folder (18 or more across the fixture and both examples). Content greps don't find these. In §2.2 they move with `find . -path '*/.sidestory/*/explainer.html' -not -path './node_modules/*' -exec sh -c 'git mv "$1" "$(dirname "$1")/sidestory.html"' _ {} ;` (with plain `mv` for any file git doesn't track yet, as in §2.2 step 1), and §2.3 adds `find . -name explainer.html -path '*/.sidestory/*'` to the checks that must print nothing.

     Do it after tiny-lsm lands, in the §2 commit, and add `explainer\.html` to the §2.3 "no old paths" check (excluding `docs/research` and the plans). Nothing is released, so there is no compatibility cost.
   - The `data-explain-*` attributes stay either way.
2. **A container in the activity bar or a view in the Explorer?**
   - **Recommend the container**, shown only when `sidestory.available` (§8.1).
   - The Explorer alternative is less discoverable for big trees, and its welcome view would show in the Explorer itself.
3. **An explicit `"top": true` for ungrouped sidestories** that are cross-linked but should stay at the top level?
   - **Recommend adding it** (one boolean, lenient parsing), since `group` alone forces authors to invent a group.
   - The decision so far adds only `group`, so this needs the user's yes.
4. **CodeLens on by default?**
   - **Recommend on**, with the limits in §7.1: at most 30 per file and hidden while their sidestory is open.
   - The alternative is off, with the status bar alone, which is quieter but much harder to discover.
5. **Opening from pickers and the tree:** reuse the panel showing the same top, else a preview panel (one the reader hasn't navigated in), else a new panel (§7.5)? And should Open Sidestory put a detail's top on the trail?
   - **Recommend yes to both.** The alternatives are always a new panel (tabs pile up) or always reusing one (the reader loses their place).
6. **Status bar glyph:** `$(book)` or the brief's ◧?
   - **Recommend `$(book)`**: it follows the theme and matches the sidebar icon.
7. **Start here:** keep the name rules (`overview`, `*-overview`, the single top with details) or add `"start": true`?
   - **Recommend the name rules now, and add `start` only if the rules turn out to mispick.**
   - The examples (`dma-overview`, `lsm-overview`) work without renaming.
8. **Exclusions:** `files.exclude` is merged in. Should `search.exclude` count too, or should there be a `sidestory.exclude` setting?
   - **Recommend just `files.exclude` for now.**
9. **A keybinding for Go to Step?**
   - **Recommend none by default.** Free chords are scarce, and the palette entry is enough.
10. **Persist the index across reloads** (in `context.storageUri`) for a faster warm start?
    - **Recommend not in the first version.** Measure the cold start first.
11. **Steps as tree children** (a "Show Steps" toggle)?
    - **Recommend not now.** Go to Step covers it, and it keeps the tree short.
12. **Rewrite `docs/research/*` for the new names, or add a one-line note?**
    - **Recommend the note.**

---

## 14. Phasing

Each phase ships with its tests green.

1. **Rename the folder and the word** (§2, §3, and Q1 if accepted). One commit, after the `src/` work in flight has landed.
2. **Pure core:**
   - `html-scan.ts` (the linear, resumable tokenizer), with the checker moved onto it;
   - `outlineHtml`, `detail-graph.ts`, `display-text.ts`;
   - `group` (and `top` if Q3 is accepted) in the manifest, and the checker additions;
   - the `stepLabel` fall-through.
3. **The index:**
   - discovery with the stable cut and merged excludes;
   - the shared watcher (the widget host moves onto it) and reconciliation;
   - metadata, interning and caps;
   - `openAt`, `goTo` and the recent list;
   - Open Sidestory;
   - `plainForMessage` applied to existing notifications.
4. **The sidebar:** container, tree, Start here, groups, filter, follow, welcome views.
5. **Explained here:**
   - the quote cache, the shared `PreparedTextCache` and the session overlay API;
   - CodeLens, status bar, gutter and settings.
6. **Go to Step.**
7. **Drift badges.**
8. **Docs:**
   - README: commands and settings;
   - GUIDE: `group`, monorepos, "Finding your way";
   - SECURITY: the new row and the tooltip and notification rules;
   - DESIGN: §12 decisions;
   - the skill, `sync-skill` and the CHANGELOG.

**New `package.json` contributions:**
- `viewsContainers.activitybar.sidestory`;
- `views.sidestory: [sidestory.tree]` (`when: sidestory.available`);
- `viewsWelcome` (3 states);
- commands:
  - `goToStep`, `showHere`, `showSidestories`, `copyAgentPrompt`;
  - hidden from the palette: `openAt`, `tree.filter`, `tree.clearFilter`, `tree.refresh`, `tree.openInNewPanel`;
- menus: `view/title`, `view/item/context`, `editor/context`;
- settings: `codeLens.enabled`, `gutter.enabled`, `statusBar.enabled`, `sidebar.followPanel`;
- color: `sidestory.explainedRuler`.

---

## 15. Review log

**Round 1** had two independent reviewers: big-repo and monorepo UX, and performance, memory and security. Both found blockers. Revision 2 addresses every blocker, major and minor:

**Blockers**
- The rename would have missed untracked files, and tiny-lsm wasn't empty. Now: `--untracked`, the plans are excluded, and the tiny-lsm tools are listed (§2).
- The tokenizer was quadratic, and the index would run it in Restricted Mode without a click. Now: a new linear, resumable tokenizer with a backstop and hostile-shape tests (§6.2, §12.1).

**Majors**
- One cross-link could demote a whole top. Now `group` makes a top, and `group-on-detail` is dropped (§4.2).
- "Start here" missed both examples. Now name rules (§8.2).
- Lenses made code jump while stepping. Now every anchor of an open sidestory is hidden (§7.1).
- The status bar fought cursor sync. Now it shows only other sidestories (§7.1).
- Reusing a panel lost the reader's place. Now a panel is reused only within the same top (§7.5).
- The activity bar icon would show in every workspace. Now `when: sidestory.available` plus a Show command (§8.1).
- DAG path explosion in the filter and reveal. Now primary paths, a node cap and `getParent` (§4.3, §8.3).
- The memory estimate was 9× too low and there were no aggregate caps. Now interning, packed arrays, caps and a measured test (§6.1, §11.1).
- Anchors per file were unbounded. Now 2,000 per file and an interval table (§6.1, §7.3).
- The manifest LRU thrashed. Now a quote cache filled once per stamp (§7.2).
- Drift had no byte budget. Now 1 MB, 20 MB and 200 MB per 10 minutes (§8.5).
- `provideCodeLenses` could block. Now a 50 ms cap (§7.3).
- Notifications were a missing surface. Now `plainForMessage`, including the existing notice (§11.4).
- Ancestor-folder deletes left ghosts. Now `onDidDeleteFiles` plus reconciliation (§6.4).

**Minors and nits**
- `QuickPickItem.detail` escaping; no escaping in the tree.
- More characters in `displayText`; folder names cleaned.
- The stable discovery cut and the merged excludes.
- Budgets per batch.
- The overlay checked at read time; `onDidSwitch`; results-only LRU; a shared `PreparedText`.
- Resumable scanning without `lineIndex`.
- The status bar on the right with a `name`.
- "This package" includes packages that anchor the file.
- One step count in the tree and the peek.
- The `stepLabel` empty-title parity.
- The `explain/1.0` hit in the verification grep.
- The 30 + "+*N* more" lenses.
- Welcome views for an empty window and a filter with no matches.
- `getParent` and trail mapping for reveal.
- The scheme check before `uriKey`.
- `memory.test.ts` with `--expose-gc`, and per-push microbenchmarks.
- One reviewer flagged a debug `appendFileSync` (marked `DEBUGSEL`) in `session.ts`. It belongs to the in-flight `src/` work and was gone by the time of this revision. It is noted here in case it comes back.

The user's later decision ("explainer" → "sidestory" in all user-facing text) is in §3, and the vocabulary in §1 retires "story".

**Round 2** (revision 2) found 3 majors and some minors, folded into revision 3:
- **UX reviewer:** 2 majors, 3 minors, 2 nits.
  - Majors: the word-rename grep used `-E`, so `\b` matched nothing; tests and scripts were missing from the rename.
  - Minors and nits: activation for the first sidestory in a fresh repo; panels piling up, now preview-panel reuse; the `explainer.html` cost list; "also under" on grouped details; late lenses on newly opened files.
- **Performance and security reviewer:** 1 major, 6 minors, 4 nits.
  - Major: quote fetches had no budget, now quote slices with a per-document budget.
  - Minors and nits: `PreparedTextCache` expiry; per-tag-name open counts; a total edge cap; a per-batch scan-time budget; per-file fairness; a follow-up batch trigger; focus throttling; `files.exclude` merging; a `getParent` id map; the tab title and quick pick title and placeholder surfaces.

**Round 3** (revision 3):
- **Performance and security reviewer:** no blockers or majors; 2 minors, 2 nits, all folded into revision 4:
  - quote slices by UTF-8 byte offset, with a validated positioned read and dirty-manifest handling;
  - a separate bootstrap bundle for `onStartupFinished`;
  - `refFromDir` checked in the bootstrap watcher;
  - one shared quote budget.
- **UX reviewer:** no blockers or majors; 3 minors, 2 nits, all folded into revision 4:
  - a separate bootstrap bundle (the same finding as above);
  - moving the page files themselves under Q1;
  - marking the preview panel, Keep Open, and defining what counts as navigating;
  - resetting the remembered key;
  - exclusions on the startup watcher.

**Round 4** (revision 4): **both reviewers report only nits.** All of them are folded into the final revision:
- **Performance and security:** duplicate keys in the quote-position scanner; the hash taken from the parsed quote; the zod schema applied to slices; a whole-file fallback for non-`file:` schemes; progress during the first load of `full.cjs`.
- **UX:** the `find` terminator (already fixed); `mv` for untracked page files; double-click detected as two invocations; cursor sync no longer ends preview status.
