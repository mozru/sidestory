// Coverage: which changes of a branch the sidestories that belong to it explain (docs/CHANGES-PLAN.md §6.2–6.3).
// Pure, shared by the extension's coverage service and the checker, so both count the same way.
//
// A change is a ChangeBlock of src/core/hunks.ts; a target is a resolved, used anchor of a belonging sidestory on
// one side of the diff. Only changed lines need cover: an unchanged line merged into a change never does.
import type { ChangeBlock } from './hunks.ts';
import { HtmlTokenizer, TreeBuilder, type Frame } from './html-scan.ts';
import type { LineRange } from './manifest.ts';
import type { AnchorState } from './resolve.ts';
import { normalizeLine } from './text.ts';
import { DROPPED_ELEMENTS } from '../shared/sanitize-lists.ts';

export type ChangeState = 'explained' | 'partly' | 'unexplained' | 'trivial' | 'needsLook';

export interface Target {
  /** A label for reports: the sidestory's folder, repo-relative (".sidestory/retry-jitter"). */
  sidestory: string;
  /** The anchor id (later: its partKey). */
  anchor: string;
  /** Repo-relative path on its side: the new path for head, the merge-base path for base. */
  path: string;
  side: 'head' | 'base';
  /** Where it resolved; null (lost) covers nothing. */
  range: LineRange | null;
  state: AnchorState | 'pending';
  /** A trivial mark, with its `why`. A trivial anchor without one never becomes a Target. */
  trivial?: boolean;
  why?: string;
  /** The pinned quote's lines, normalized with `normLine` (for "needs a look"); undefined when not pinned. */
  pinned?: ReadonlySet<string>;
}

export interface FileInput {
  /** The new path (the old one for a deleted file). */
  path: string;
  /** The merge-base path, when it differs (a rename). */
  oldPath?: string;
  changes: readonly ChangeBlock[];
  /** The new side's text of a line (1-based), for "needs a look" and blank lines. */
  newLine(line: number): string;
  /** The old side's text of a line, for blank removed lines; without it, every removed line needs cover. */
  oldLine?(line: number): string;
  /** Matched by a belonging sidestory's `trivialFiles`. */
  trivialFile: boolean;
  /**
   * The new side's line count (FileDiff.newLines), so a pure deletion at the end of the file is judged by the one
   * line before it. Without it, both lines around a deletion must be covered.
   */
  newLines?: number;
}

export interface ChangeCoverage {
  key: string;
  state: ChangeState;
  /** Every target covering some changed line of it, in target order. */
  by: { sidestory: string; anchor: string }[];
  /** Changed lines nothing covers (for partly and unexplained changes). */
  uncovered: { side: 'head' | 'base'; range: LineRange }[];
  /** "partly explained (4 of 9 lines)": changed lines that need cover (blank ones don't, unless all are blank). */
  coveredLines: number;
  changedLines: number;
  /** Added lines inside a pinned target that aren't in its pinned quote: written after the step was. */
  needsLook?: { sidestory: string; anchor: string; lines: number[] }[];
  /** Covered by a target whose code changed a lot since it was pinned: "explained, may be out of date". */
  stale?: boolean;
  /** Covered by a broad target (`anchor-broad`). */
  broad?: boolean;
  /** The `why` of the trivial marks that cover it. */
  why?: string[];
}

export interface FileCoverage {
  path: string;
  changes: ChangeCoverage[];
  explained: number;
  trivial: number;
  /** Not done: unexplained, partly explained, or needs a look. */
  left: number;
  needsLook: number;
}

export interface Totals {
  changes: number;
  explained: number;
  trivial: number;
  left: number;
  needsLook: number;
  files: number;
}

/** What each target did, for the checker's `anchor-broad` warning. */
export interface TargetUse {
  sidestory: string;
  anchor: string;
  path: string;
  side: 'head' | 'base';
  /** Lines the target spans (0 when lost). */
  lines: number;
  /** Changed lines it covers, over the whole comparison. */
  explains: number;
  broad: boolean;
}

export const COVERAGE_LIMITS = {
  /** A pure deletion of at most this many lines is explained by a head-side target over both lines around it. */
  pureDeletionContext: 20,
  /** `anchor-broad`: a target spanning more than this many lines … */
  broadLines: 40,
  /** … and more than this many times the changed lines it covers. */
  broadFactor: 5,
} as const;

/** A line as pinned quotes compare it: whitespace collapsed and trimmed (the `ws` norm). */
export function normLine(s: string): string {
  return normalizeLine(s, 'ws');
}

interface Cover {
  explaining: boolean;
  trivial: boolean;
}

export function coverage(files: readonly FileInput[], targets: readonly Target[]): { files: FileCoverage[]; totals: Totals; targets: TargetUse[] } {
  // Targets by (path, side); lost ones cover nothing and are left out.
  const bySide = new Map<string, number[]>();
  targets.forEach((t, i) => {
    if (!t.range || t.state === 'lost') return;
    const k = `${t.side}\u0000${t.path}`;
    const list = bySide.get(k);
    if (list) list.push(i);
    else bySide.set(k, [i]);
  });
  const explains = new Array<number>(targets.length).fill(0);
  const perChange: { file: number; change: number; users: Set<number>; cov: ChangeCoverage }[] = [];

  const out: FileCoverage[] = files.map((f, fi) => {
    const head = bySide.get(`head\u0000${f.path}`) ?? [];
    const base = bySide.get(`base\u0000${f.oldPath ?? f.path}`) ?? [];
    const changes = f.changes.map((c, ci) => {
      const cov = f.trivialFile ? trivialFileChange(c) : coverChange(f, c, head, base, targets, explains);
      perChange.push({ file: fi, change: ci, users: cov.users, cov: cov.cov });
      return cov.cov;
    });
    return { path: f.path, changes, explained: 0, trivial: 0, left: 0, needsLook: 0 };
  });

  const uses: TargetUse[] = targets.map((t, i) => {
    const lines = t.range && t.state !== 'lost' ? t.range.end - t.range.start + 1 : 0;
    return { sidestory: t.sidestory, anchor: t.anchor, path: t.path, side: t.side, lines, explains: explains[i]!, broad: isBroad(lines, explains[i]!) };
  });
  for (const p of perChange) if ([...p.users].some((i) => uses[i]!.broad)) p.cov.broad = true;

  const totals: Totals = { changes: 0, explained: 0, trivial: 0, left: 0, needsLook: 0, files: files.length };
  for (const f of out) {
    for (const c of f.changes) {
      if (c.state === 'explained') f.explained++;
      else if (c.state === 'trivial') f.trivial++;
      else f.left++;
      if (c.state === 'needsLook') f.needsLook++;
    }
    totals.changes += f.changes.length;
    totals.explained += f.explained;
    totals.trivial += f.trivial;
    totals.left += f.left;
    totals.needsLook += f.needsLook;
  }
  return { files: out, totals, targets: uses };
}

/** `anchor-broad`: more than 40 lines and more than 5 times the changed lines it covers (§6.3). */
function isBroad(lines: number, explains: number): boolean {
  return explains > 0 && lines > COVERAGE_LIMITS.broadLines && lines > COVERAGE_LIMITS.broadFactor * explains;
}

function trivialFileChange(c: ChangeBlock): { cov: ChangeCoverage; users: Set<number> } {
  const changed = c.added + c.removed;
  return { cov: { key: c.key, state: 'trivial', by: [], uncovered: [], coveredLines: changed, changedLines: changed }, users: new Set() };
}

const inside = (r: LineRange, line: number) => line >= r.start && line <= r.end;
const overlaps = (r: LineRange, a: number, b: number) => r.start <= b && r.end >= a;

function coverChange(f: FileInput, c: ChangeBlock, head: number[], base: number[], targets: readonly Target[], explains: number[]): { cov: ChangeCoverage; users: Set<number> } {
  const users = new Set<number>();
  const mark = (i: number, cover: Cover) => {
    users.add(i);
    explains[i]!++;
    if (targets[i]!.trivial) cover.trivial = true;
    else cover.explaining = true;
  };
  // Only targets near the change are tested line by line.
  const headNear = c.new ? head.filter((i) => overlaps(targets[i]!.range!, c.new!.start, c.new!.end)) : [];
  const baseNear = c.old ? base.filter((i) => overlaps(targets[i]!.range!, c.old!.start, c.old!.end)) : [];

  // Head-side cover for the removed lines (§6.3): a target over the whole new range of a replacement, or over both
  // lines around a pure deletion of at most 20 lines.
  let removedByHead: number[] = [];
  if (c.removed > 0) {
    if (c.new) {
      removedByHead = headNear.filter((i) => targets[i]!.range!.start <= c.new!.start && targets[i]!.range!.end >= c.new!.end);
    } else if (c.removed <= COVERAGE_LIMITS.pureDeletionContext) {
      const around = [c.newAt - 1, c.newAt].filter((l) => l >= 1 && l <= (f.newLines ?? Infinity));
      if (around.length) removedByHead = head.filter((i) => around.every((l) => inside(targets[i]!.range!, l)));
    }
  }

  const uncovered: { side: 'head' | 'base'; range: LineRange }[] = [];
  const pushUncovered = (side: 'head' | 'base', line: number) => {
    const last = uncovered.at(-1);
    if (last && last.side === side && last.range.end === line - 1) last.range.end = line;
    else uncovered.push({ side, range: { start: line, end: line } });
  };
  let covered = 0;
  let allExplaining = true;
  const needsLook = new Map<number, number[]>();
  let stale = false;
  const whys = new Set<string>();

  // Blank (whitespace-only) lines need no cover, unless the change is nothing but blank lines: pinning trims them
  // from an anchor's edges, so a blank line added next to a function could never be covered.
  const blankNew = (l: number) => f.newLine(l).trim() === '';
  const blankOld = (l: number) => (f.oldLine ? f.oldLine(l).trim() === '' : false);
  let allBlank = true;
  for (const r of c.addedRuns) for (let l = r.start; l <= r.end && allBlank; l++) if (!blankNew(l)) allBlank = false;
  for (const r of c.removedRuns) for (let l = r.start; l <= r.end && allBlank; l++) if (!blankOld(l)) allBlank = false;
  let changed = 0;

  for (const run of c.addedRuns) {
    for (let line = run.start; line <= run.end; line++) {
      if (!allBlank && blankNew(line)) continue;
      changed++;
      const cover: Cover = { explaining: false, trivial: false };
      let text: string | undefined;
      for (const i of headNear) {
        const t = targets[i]!;
        if (!inside(t.range!, line)) continue;
        mark(i, cover);
        if (t.pinned) {
          text ??= normLine(f.newLine(line));
          // A blank line says nothing the prose could have missed.
          if (text !== '' && !t.pinned.has(text)) {
            const list = needsLook.get(i);
            if (list) list.push(line);
            else needsLook.set(i, [line]);
          }
        }
      }
      if (cover.explaining || cover.trivial) {
        covered++;
        if (!cover.explaining) allExplaining = false;
      } else pushUncovered('head', line);
    }
  }
  for (const run of c.removedRuns) {
    for (let line = run.start; line <= run.end; line++) {
      if (!allBlank && blankOld(line)) continue;
      changed++;
      const cover: Cover = { explaining: false, trivial: false };
      for (const i of baseNear) if (inside(targets[i]!.range!, line)) mark(i, cover);
      for (const i of removedByHead) mark(i, cover);
      if (cover.explaining || cover.trivial) {
        covered++;
        if (!cover.explaining) allExplaining = false;
      } else pushUncovered('base', line);
    }
  }

  for (const i of users) {
    const t = targets[i]!;
    if (t.state === 'stale') stale = true;
    if (t.trivial && t.why) whys.add(t.why);
  }
  let state: ChangeState = covered === 0 ? 'unexplained' : covered < changed ? 'partly' : allExplaining ? 'explained' : 'trivial';
  if ((state === 'explained' || state === 'trivial') && needsLook.size) state = 'needsLook';
  const cov: ChangeCoverage = {
    key: c.key,
    state,
    by: [...users].sort((a, b) => a - b).map((i) => ({ sidestory: targets[i]!.sidestory, anchor: targets[i]!.anchor })),
    uncovered,
    coveredLines: covered,
    changedLines: changed,
  };
  if (needsLook.size) cov.needsLook = [...needsLook].map(([i, lines]) => ({ sidestory: targets[i]!.sidestory, anchor: targets[i]!.anchor, lines }));
  if (stale) cov.stale = true;
  if (whys.size) cov.why = [...whys];
  return { cov, users };
}

// ---- which anchors a page uses (§6.2) ----

/** Deterministic limits of the page scan: tokens read and ids kept. Past either, coverage is "incomplete". */
export const USED_LIMITS = { tokens: 2_000_000, ids: 5000 } as const;

const DROPPED = new Set<string>(DROPPED_ELEMENTS.map((n) => n.toLowerCase()));

interface UFrame extends Frame {
  dropped: boolean;
}

/**
 * The anchor ids a page refers to: sections (`data-explain-anchor`), inline `data-explain-ref`s and
 * `data-explain-on`s, outside elements the panel's sanitizer drops (as the outline reads them). Code links
 * (`data-explain-code`) name files, not anchors. Bounded by token and id counts only, never by time, so a slow
 * machine can't change the result; `incomplete` when a limit stopped it.
 */
export function usedAnchorIds(html: string): { ids: Set<string>; incomplete: boolean } {
  const ids = new Set<string>();
  let incomplete = false;
  let droppedOpen = 0;
  const add = (id: string) => {
    const v = id.trim();
    if (!v) return;
    if (ids.size >= USED_LIMITS.ids && !ids.has(v)) incomplete = true;
    else ids.add(v);
  };
  const visit = (f: UFrame, tracked: boolean) => {
    if (f.dropped) {
      if (tracked) droppedOpen++;
      return;
    }
    if (droppedOpen > 0) return;
    const anchor = f.attrs.get('data-explain-anchor');
    if (anchor !== undefined) add(anchor);
    const ref = f.attrs.get('data-explain-ref');
    if (ref !== undefined) add(ref);
    const on = f.attrs.get('data-explain-on');
    if (on !== undefined) for (const id of on.split(/\s+/)) add(id);
  };
  const tree = new TreeBuilder<UFrame>((t) => ({ name: t.name, attrs: t.attrs, offset: t.offset, dropped: DROPPED.has(t.name) }), {
    open: (f) => visit(f, true),
    leaf: (f) => visit(f, false),
    close: (f) => {
      if (f.dropped) droppedOpen--;
    },
  });
  const tokens = new HtmlTokenizer(html);
  let n = 0;
  for (let t = tokens.next(); t; t = tokens.next()) {
    if (++n > USED_LIMITS.tokens) {
      incomplete = true;
      break;
    }
    tree.token(t);
  }
  tree.finish();
  return { ids, incomplete };
}
