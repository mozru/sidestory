// Open Sidestory (docs/NAVIGATION-PLAN.md §10) and Go to Step (§9): quick picks built from the index, in memory.
// Every label, description and detail is repository text: cleaned when indexed, icon syntax escaped here.
import * as vscode from 'vscode';
import { displayText, escapeIcons } from '../../core/display-text.ts';
import { uriKey } from '../explainers.ts';
import type { IndexEntry, SidestoryIndex } from './index.ts';

export const PICK_LIMITS = { steps: 20_000 } as const;
export const GUIDE_URL = 'https://github.com/mozru/sidestory/blob/main/docs/GUIDE.md';
export const SCOPE_KEY = 'sidestory.goToStepScope';

/** Every sidestory once, in tree order: package, then Start here, groups, tops, each top followed by its details. */
export function treeOrder(index: SidestoryIndex): IndexEntry[] {
  const out: IndexEntry[] = [];
  const seen = new Set<string>();
  const coll = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  for (const pkg of index.packages()) {
    const g = pkg.graph;
    const visit = (name: string) => {
      // Depth-first through details in HTML order, each sidestory once (no path enumeration).
      const stack = [name];
      while (stack.length) {
        const n = stack.pop()!;
        const e = pkg.byName.get(n);
        if (!e || seen.has(e.key)) continue;
        seen.add(e.key);
        out.push(e);
        const kids = g.children(n);
        for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
      }
    };
    if (g.startHere) visit(g.startHere);
    const byTitle = (names: readonly string[]) =>
      names
        .map((n) => pkg.byName.get(n))
        .filter((e): e is IndexEntry => !!e)
        .sort((a, b) => coll.compare(index.name(a), index.name(b)) || a.ref.name.localeCompare(b.ref.name))
        .map((e) => e.ref.name);
    const grouped = new Set<string>();
    for (const grp of pkg.groups) {
      const tops = grp.members.filter((m) => g.isTop(m));
      for (const t of tops) grouped.add(t);
      for (const t of byTitle(tops)) visit(t);
    }
    for (const t of byTitle(g.tops.filter((t) => !grouped.has(t)))) visit(t);
    for (const e of [...pkg.entries.values()].sort((a, b) => a.ref.name.localeCompare(b.ref.name))) if (!seen.has(e.key)) visit(e.ref.name);
  }
  return out;
}

interface SidestoryItem extends vscode.QuickPickItem {
  entry?: IndexEntry;
}

/** "Sidestory: Open Sidestory…": recent first, then everything in tree order; each sidestory once. */
export async function pickSidestory(index: SidestoryIndex, recent: readonly string[]): Promise<IndexEntry | undefined> {
  if (index.state !== 'loading' && index.size === 0) {
    const show = 'Show Sidestories';
    const guide = 'Read the Guide';
    const choice = await vscode.window.showInformationMessage('No sidestories found. A sidestory is a folder like .sidestory/<name>/ with a page and a manifest.json.', show, guide);
    if (choice === show) void vscode.commands.executeCommand('sidestory.showSidestories');
    if (choice === guide) void vscode.env.openExternal(vscode.Uri.parse(GUIDE_URL));
    return undefined;
  }
  if (index.state !== 'loading' && index.size === 1) return index.all().next().value;
  const qp = vscode.window.createQuickPick<SidestoryItem>();
  qp.placeholder = 'Open which sidestory?';
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const build = () => {
    const active = qp.activeItems[0]?.entry?.key;
    const all = treeOrder(index);
    const recentKeys = recent.map((d) => uriKey(vscode.Uri.parse(d)));
    const byKey = new Map(all.map((e) => [e.key, e]));
    const items: SidestoryItem[] = [];
    const recentEntries = recentKeys.map((k) => byKey.get(k)).filter((e): e is IndexEntry => !!e);
    if (recentEntries.length) items.push({ label: 'Recently opened', kind: vscode.QuickPickItemKind.Separator });
    for (const e of recentEntries) items.push(sidestoryItem(index, e));
    const rest = all.filter((e) => !recentEntries.includes(e));
    if (rest.length) items.push({ label: recentEntries.length ? 'All sidestories' : 'Sidestories', kind: vscode.QuickPickItemKind.Separator });
    for (const e of rest) items.push(sidestoryItem(index, e));
    qp.items = items;
    if (active) {
      const again = items.find((i) => i.entry?.key === active);
      if (again) qp.activeItems = [again];
    }
    qp.busy = index.state === 'loading';
    const cut = index.discoveryCut;
    if (cut) qp.placeholder = `Open which sidestory? (showing the first ${index.size.toLocaleString('en-US')} of ${cut.atLeast ? 'at least ' : ''}${cut.found.toLocaleString('en-US')})`;
  };
  build();
  const sub = index.onDidChange(() => build());
  const subState = index.onDidChangeState(() => build());
  try {
    return await new Promise<IndexEntry | undefined>((resolve) => {
      qp.onDidAccept(() => {
        resolve(qp.selectedItems[0]?.entry);
        qp.hide();
      });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
  } finally {
    sub.dispose();
    subState.dispose();
    qp.dispose();
  }
}

function sidestoryItem(index: SidestoryIndex, e: IndexEntry): SidestoryItem {
  const pkg = index.packageOf(e);
  const parents = pkg?.graph.parents(e.ref.name).length ?? 0;
  // Places other than its primary path: every parent when it is listed at the top level, else the others.
  const others = index.primaryPath(e).length === 1 ? parents : parents - 1;
  // Folder names are repository text too (on Linux they can hold newlines and bidi controls).
  const where = displayText(`${vscode.workspace.asRelativePath(pkg?.folder ?? e.ref.dir, (vscode.workspace.workspaceFolders?.length ?? 0) > 1)}/${e.ref.name}`, 200);
  return {
    label: escapeIcons(index.pathLabel(e)),
    description: escapeIcons(`${where}${others > 0 ? ` · also under ${others} other${others === 1 ? '' : 's'}` : ''}`),
    detail: e.summary ? escapeIcons(e.summary) : undefined,
    entry: e,
  };
}

interface StepItem extends vscode.QuickPickItem {
  entry?: IndexEntry;
  step?: string;
}

export interface GoToStepContext {
  /** The sidestory of the current panel, if any. */
  current?: IndexEntry;
  /** The file in the active editor. */
  fileKey?: string;
  /** Recently opened (folder URI strings), newest first. */
  recent: readonly string[];
  memento: vscode.Memento;
  /** Opened from the tree: just this sidestory. */
  only?: IndexEntry;
}

/** "Sidestory: Go to Step…": one item per step, scoped to this package or all (§9). */
export async function goToStep(index: SidestoryIndex, ctx: GoToStepContext): Promise<{ entry: IndexEntry; step: string } | undefined> {
  const qp = vscode.window.createQuickPick<StepItem>();
  qp.matchOnDescription = true;
  qp.matchOnDetail = true;
  const thisPackage = (): Set<string> => {
    if (ctx.fileKey) {
      const p = index.packagesForFile(ctx.fileKey);
      if (p.size) return p;
    }
    return ctx.current ? new Set([ctx.current.pkg]) : new Set();
  };
  const multi = index.packageCount > 1;
  const remembered = ctx.memento.get<string>(SCOPE_KEY);
  let scope: 'package' | 'all' = remembered === 'all' || remembered === 'package' ? remembered : multi && thisPackage().size ? 'package' : 'all';
  const build = () => {
    const active = qp.activeItems[0];
    const pkgs = thisPackage();
    let effective = ctx.only ? 'one' : scope === 'package' && pkgs.size && multi ? 'package' : 'all';
    let entries = ctx.only ? [ctx.only] : treeOrder(index).filter((e) => effective !== 'package' || pkgs.has(e.pkg));
    let total = entries.reduce((n, e) => n + (e.outlined ? e.steps.length : e.ids.length), 0);
    // Past the cap, This package is forced when a package is known (and the toggle can't undo it).
    let forced = false;
    if (total > PICK_LIMITS.steps && effective === 'all' && pkgs.size && multi) {
      effective = 'package';
      forced = true; // the reader's own choice (scope) is kept for next time
      entries = treeOrder(index).filter((e) => pkgs.has(e.pkg));
      total = entries.reduce((n, e) => n + (e.outlined ? e.steps.length : e.ids.length), 0);
    }
    // The current panel's sidestory first, then recent ones, then the rest.
    const recentKeys = ctx.recent.map((d) => uriKey(vscode.Uri.parse(d)));
    const rank = (e: IndexEntry) => (e === ctx.current ? -1 : recentKeys.indexOf(e.key) >= 0 ? recentKeys.indexOf(e.key) : Number.MAX_SAFE_INTEGER);
    const ordered = entries.map((e, i) => ({ e, i })).sort((a, b) => rank(a.e) - rank(b.e) || a.i - b.i).map((x) => x.e);
    const items: StepItem[] = [];
    let busy = false;
    for (const e of ordered) {
      const label = index.pathLabel(e);
      if (e.outlined) {
        e.steps.forEach((s, i) => {
          if (items.length < PICK_LIMITS.steps) {
            items.push({ label: escapeIcons(s.title), description: escapeIcons(`${label} · step ${i + 1}`), detail: escapeIcons(s.blurb || e.summary) || undefined, entry: e, step: s.id });
          }
        });
      } else {
        // Not outlined yet: anchor ids stand in, replaced when the outline arrives.
        busy = true;
        for (const id of e.ids) if (items.length < PICK_LIMITS.steps) items.push({ label: id, description: escapeIcons(label), entry: e, step: id });
      }
    }
    qp.items = items;
    if (active) {
      const again = items.find((i) => i.entry === active.entry && i.step === active.step);
      if (again) qp.activeItems = [again];
    }
    qp.busy = busy || index.state === 'loading';
    const scopeName = effective === 'one' && ctx.only ? escapeIcons(index.name(ctx.only)) : effective === 'package' ? [...pkgs].map((k) => index.packageByKey(k)?.label ?? '').filter(Boolean).map(escapeIcons).join(', ') || 'This package' : 'All packages';
    // One package: the scope needs no name.
    qp.title = !multi && !ctx.only ? 'Go to Step' : `Go to Step: ${scopeName}`;
    qp.placeholder = forced
      ? `All packages have more than ${PICK_LIMITS.steps.toLocaleString('en-US')} steps: showing this package`
      : total > items.length
        ? `Showing ${items.length.toLocaleString('en-US')} of ${total.toLocaleString('en-US')} steps; narrow with This package`
        : 'Type to find a step';
    // The toggle only when it can change something: several packages, one of them current, and no forced scope.
    qp.buttons = ctx.only || !multi || !pkgs.size || forced ? [] : [effective === 'package' ? { iconPath: new vscode.ThemeIcon('filter-filled'), tooltip: 'Show all packages' } : { iconPath: new vscode.ThemeIcon('filter'), tooltip: 'Show this package only' }];
  };
  build();
  const subs = [
    index.onDidChange(() => build()),
    qp.onDidTriggerButton(() => {
      scope = scope === 'package' ? 'all' : 'package';
      void ctx.memento.update(SCOPE_KEY, scope);
      build();
    }),
  ];
  try {
    return await new Promise<{ entry: IndexEntry; step: string } | undefined>((resolve) => {
      qp.onDidAccept(() => {
        const it = qp.selectedItems[0];
        resolve(it?.entry && it.step ? { entry: it.entry, step: it.step } : undefined);
        qp.hide();
      });
      qp.onDidHide(() => resolve(undefined));
      qp.show();
    });
  } finally {
    for (const d of subs) d.dispose();
    qp.dispose();
  }
}
