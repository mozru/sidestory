// The coverage layer's words and marks (docs/CHANGES-PLAN.md §9.6): a file's decoration (a badge of at most two
// characters, as VS Code requires, a colour and a tooltip), shown on the real files wherever VS Code decorates them
// (the Explorer, Source Control, Git Tree Compare); change labels and icons for This File; the "This branch" rows of
// the Sidestories view; and the totals. Pure: no vscode import.
import type { ChangeCoverage, ChangeState, FileCoverage, Totals } from '../../core/coverage.ts';
import type { ChangeBlock } from '../../core/hunks.ts';
import type { LineRange } from '../../core/manifest.ts';

const span = (r: LineRange) => (r.start === r.end ? `${r.start}` : `${r.start}–${r.end}`);

/** Done means explained or trivial (§6.3). */
export const isDone = (s: ChangeState) => s === 'explained' || s === 'trivial';

/** The two theme colours the decorations use (contributed in package.json). */
export const COVERAGE_COLORS = { done: 'sidestory.coverageDoneForeground', left: 'sidestory.coverageLeftForeground' } as const;

export interface CoverageMark {
  /** `✓` all explained (some may be trivial), `–` all marked trivial, `◐` partly, `○` none yet, `!` needs a look. */
  badge: string;
  color: keyof typeof COVERAGE_COLORS;
  tooltip: string;
}

/**
 * A changed file's decoration (§9.6). `steps` names the steps that explain its changes ("Step 3 of Retry with
 * jitter"). Undefined for a file with nothing to count (only line endings changed).
 */
export function fileDecoration(f: FileCoverage, steps: readonly string[] = []): CoverageMark | undefined {
  const n = f.changes.length;
  if (!n) return undefined;
  let badge: string;
  let color: CoverageMark['color'] = 'left';
  if (f.needsLook) badge = '!';
  else if (f.left === 0) {
    badge = f.explained ? '✓' : '–';
    color = 'done';
  } else badge = f.explained + f.trivial ? '◐' : '○';
  const allTrivial = f.trivial === n;
  const parts = [allTrivial ? `${n} of ${n} ${n === 1 ? 'change' : 'changes'} marked trivial` : `${f.explained} of ${n} ${n === 1 ? 'change' : 'changes'} explained`];
  if (f.trivial && !allTrivial) parts.push(`${f.trivial} marked trivial`);
  if (f.needsLook) parts.push(`${f.needsLook} changed since ${f.needsLook === 1 ? 'its step was' : 'their steps were'} written`);
  if (steps.length) parts.push(steps.length > 2 ? `${steps.slice(0, 2).join(', ')} and ${steps.length - 2} more` : steps.join(', '));
  parts.push('Details in This File');
  return { badge, color, tooltip: parts.join(' · ') };
}

/** A change's place: `L40–44` on the new side, `L39–62 (removed)` for a pure deletion (old lines). */
export function changeLabel(b: ChangeBlock): string {
  if (b.new) return `L${span(b.new)}`;
  return b.old ? `L${span(b.old)} (removed)` : `L${b.newAt}`;
}

export function changeCounts(b: ChangeBlock): string {
  return [b.added ? `+${b.added}` : '', b.removed ? `−${b.removed}` : ''].filter(Boolean).join(' ');
}

/** The kind the "Explain This Change" prompt names. */
export const changeKind = (b: ChangeBlock): 'added' | 'removed' | 'replaced' => (b.added && b.removed ? 'replaced' : b.added ? 'added' : 'removed');

/** The words for a change's state, as the file tooltip lists them. */
export function stateWords(c: ChangeCoverage): string {
  switch (c.state) {
    case 'explained':
      return c.stale ? 'explained, may be out of date' : c.broad ? 'explained by a broad step' : 'explained';
    case 'trivial':
      return c.why?.length ? `marked trivial: ${c.why[0]}` : 'marked trivial';
    case 'needsLook':
      return 'changed since the step was written';
    case 'partly': {
      const left = c.uncovered.map((u) => `${span(u.range)}${u.side === 'base' ? ' removed' : ''}`).join(', ');
      return `partly (${left} left)`;
    }
    default:
      return 'not explained';
  }
}


/** The codicon for a change item (§9.6), and whether it takes the unexplained colour. */
export function changeIcon(c: ChangeCoverage): { id: string; colored?: boolean } {
  switch (c.state) {
    case 'explained':
      return { id: c.stale || c.broad ? 'warning' : 'check' };
    case 'trivial':
      return { id: 'dash' };
    case 'needsLook':
      return { id: 'diff-modified' };
    case 'partly':
      return { id: 'circle-large-filled', colored: true };
    default:
      return { id: 'circle-large-outline' };
  }
}

/** `9 explained · 3 trivial · 0 left`. */
export function totalsLabel(t: Totals): string {
  return `${t.explained} explained · ${t.trivial} trivial · ${t.left} left`;
}

// ---- the "This branch" group of the Sidestories view ----

export interface BranchRow {
  id: string;
  label: string;
  description?: string;
  tooltip: string;
  icon: string;
  command: { command: string; title: string; arguments?: unknown[] };
  contextValue: string;
}

export interface BranchInputs {
  /** The sidestories that belong to the branch's comparison, with what each explains or marks. */
  belonging: { folder: string; title: string; base: string; dir: string; totals: Totals }[];
  /** The branch's totals over every belonging sidestory. */
  totals: Totals | undefined;
  /** The branch has changes against its base (a comparison, or the probe's answer). */
  hasChanges: boolean;
  /** "Copy Prompt: Explain This Branch" is wanted: the setting is on and it wasn't dismissed for this branch. */
  suggest: boolean;
  /** A sidestory added on the branch that compares with another base than the one in use. */
  otherBase?: { title: string; base: string };
  /** Coverage stopped at a limit (a page too large to scan, the byte budget, git unsure): the totals are a floor. */
  incomplete?: boolean;
  /** Why there is no comparison (a base not found, no common commit, git's error): said, with a way out. */
  problem?: BranchProblem;
}

/** Why the branch has no comparison, as the comparison's state says it (display-safe strings). */
export type BranchProblem =
  | { kind: 'baseNotFound'; spec: string }
  | { kind: 'noMergeBase'; base: string }
  | { kind: 'noBase' }
  | { kind: 'error'; message: string };

/** The row that says a problem, opening Set Base… (pure, for the tests). */
export function problemRow(p: BranchProblem): BranchRow {
  const setBase = { command: 'sidestory.changes.setBase', title: 'Set Base…' };
  switch (p.kind) {
    case 'baseNotFound':
      return { id: 'b:problem', label: `Base ${p.spec} not found · Set Base…`, tooltip: `The base set for this branch, “${p.spec}”, isn't a branch, tag or commit here (deleted, or not fetched). Click to choose another.`, icon: 'warning', command: setBase, contextValue: 'branchProblem' };
    case 'noMergeBase':
      return { id: 'b:problem', label: `No common commit with ${p.base} · Set Base…`, tooltip: `This branch and ${p.base} share no history (or a shallow clone hides it). Click to choose another base.`, icon: 'warning', command: setBase, contextValue: 'branchProblem' };
    case 'noBase':
      return { id: 'b:problem', label: 'No base to compare with · Set Base…', tooltip: 'No main or master branch here, and no base set. Click to choose the branch this one is compared with.', icon: 'warning', command: setBase, contextValue: 'branchProblem' };
    case 'error':
      return { id: 'b:problem', label: `Couldn't compare: ${p.message}`, tooltip: `Git couldn't compute this branch's changes: ${p.message}\nClick to choose another base.`, icon: 'error', command: setBase, contextValue: 'branchProblem' };
  }
}

/**
 * The rows under "This branch" (§9.6): each belonging sidestory ("vs main · 3 explained · 1 trivial · 1 left"), then
 * the update prompt while something is left; with none belonging and changes on the branch, the explain prompt.
 * Empty: no group.
 */
export function branchRows(i: BranchInputs): BranchRow[] {
  const rows: BranchRow[] = [];
  if (i.problem) rows.push(problemRow(i.problem));
  const t = i.totals;
  const partial = i.incomplete ? ' · incomplete' : '';
  const partialLine = i.incomplete ? '\nIncomplete: a page too large to scan, or files too large or unreadable, weren’t counted' : '';
  // "left" is branch-wide (a change no one explains has no sidestory): said so when several sidestories share it.
  const leftWords = i.belonging.length > 1 ? ' on the branch' : '';
  for (const b of i.belonging) {
    rows.push({
      id: `b:${b.folder}`,
      label: b.title || b.folder,
      description: `vs ${b.base} · ${totalsLabel({ ...b.totals, left: t?.left ?? 0 })}${leftWords}${partial}`,
      tooltip: `${b.title}\n${b.folder} · vs ${b.base}\n${b.totals.explained} explained and ${b.totals.trivial} marked trivial by it; ${t?.left ?? 0} left on the branch${partialLine}\nClick to open`,
      icon: 'book',
      command: { command: 'sidestory.openAt', title: 'Open Sidestory', arguments: [{ dir: b.dir, source: 'tree' }] },
      contextValue: 'branchSidestory',
    });
  }
  if (i.belonging.length && t && t.left > 0) {
    const look = t.needsLook ? ` (${t.needsLook} changed since ${t.needsLook === 1 ? 'its step was' : 'their steps were'} written)` : '';
    rows.push({
      id: 'b:update',
      label: 'Copy Prompt: Update the Sidestory for New Changes',
      tooltip: `${t.left} ${t.left === 1 ? 'change' : 'changes'} left${look}. Copies a prompt for Claude Code (or your agent) to extend the sidestory.`,
      icon: 'sparkle',
      command: { command: 'sidestory.changes.copyUpdatePrompt', title: 'Copy Prompt: Update the Sidestory for New Changes' },
      contextValue: 'updatePrompt',
    });
  }
  if (!i.belonging.length && i.hasChanges && i.suggest) {
    rows.push({
      id: 'b:explain',
      label: 'Copy Prompt: Explain This Branch',
      tooltip: 'Copies a prompt for Claude Code (or your agent) to write a sidestory that explains this branch’s changes, step by step',
      icon: 'sparkle',
      command: { command: 'sidestory.changes.copyExplainPrompt', title: 'Copy Prompt: Explain This Branch' },
      contextValue: 'explainPrompt',
    });
  }
  if (i.otherBase) {
    const o = i.otherBase;
    rows.push({
      id: 'b:base',
      label: `${o.title} compares with ${o.base} · Use ${o.base}`,
      tooltip: `This branch is compared with another base now. Set Base… to ${o.base}, as that sidestory's manifest says.`,
      icon: 'git-compare',
      command: { command: 'sidestory.changes.setBase', title: 'Set Base…', arguments: [o.base] },
      contextValue: 'otherBase',
    });
  }
  return rows;
}
