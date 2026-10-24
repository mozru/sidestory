// `sidestory.openAt` (docs/NAVIGATION-PLAN.md §7.5): one entry point for CodeLens, the status bar, the tree,
// Go to Step and Open Sidestory, deciding which panel shows the sidestory so tabs don't pile up and the reader
// never loses their place. Also the recently-opened list (§10).
import * as vscode from 'vscode';
import { anchorIdSchema, explainerNameSchema } from '../../core/manifest.ts';
import { MAX_TRAIL } from '../../shared/protocol.ts';
import type { ExplainerRef } from '../explainers.ts';
import { refFromDir, uriKey } from '../explainers.ts';
import type { ExplainerSession } from '../session.ts';

export interface OpenAtArgs {
  dir: string;
  anchor?: string;
  /** Sidestory names, top first; the last is `dir`'s. */
  trail?: string[];
  newPanel?: boolean;
  /** Where the request came from: a second open of the same tree item within 500 ms keeps the panel. */
  source?: 'tree' | 'lens' | 'status' | 'step' | 'pick' | 'here';
}

/** What the navigator needs from the extension. */
export interface NavigatorHost {
  sessions(): readonly ExplainerSession[];
  /** The panel used last. */
  current(): ExplainerSession | undefined;
  /** Opens a new panel beside the editor showing `trail`, at `active`. */
  start(trail: readonly [ExplainerRef, ...ExplainerRef[]], active?: string): Promise<ExplainerSession>;
  memento: vscode.Memento;
  /** A panel became, or stopped being, the preview (its tab icon changes). */
  previewChanged?(s: ExplainerSession): void;
}

export const RECENT_KEY = 'sidestory.recent';
const MAX_RECENT = 30;
const DOUBLE_OPEN_MS = 500;
/** Longest trail argument looked at (4 × MAX_TRAIL); a longer one falls back to the sidestory alone. */
const MAX_TRAIL_IN = 64;

/** Checks arguments that other extensions may pass (§7.5); undefined when they aren't a sidestory. */
export function validateOpenAt(raw: unknown): { ref: ExplainerRef; trail: [ExplainerRef, ...ExplainerRef[]]; anchor?: string; newPanel: boolean; source?: OpenAtArgs['source'] } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const a = raw as Record<string, unknown>;
  if (typeof a.dir !== 'string' || a.dir.length > 4096) return undefined;
  let dir: vscode.Uri;
  try {
    dir = vscode.Uri.parse(a.dir, true);
  } catch {
    return undefined;
  }
  const ref = refFromDir(dir);
  if (!ref) return undefined;
  const anchor = typeof a.anchor === 'string' && anchorIdSchema.safeParse(a.anchor).success ? a.anchor : undefined;
  // A trail longer than any the extension makes isn't parsed name by name: just the sidestory.
  const trailIn = Array.isArray(a.trail) && a.trail.length <= MAX_TRAIL_IN ? a.trail : [];
  let names = trailIn.filter((n): n is string => typeof n === 'string' && explainerNameSchema.safeParse(n).success);
  if (names.length !== trailIn.length) names = []; // any bad name: just the sidestory
  // Each name once, ending at the sidestory shown.
  const seen = new Set<string>();
  names = names.filter((n) => n !== ref.name && !seen.has(n) && seen.add(n));
  names.push(ref.name);
  if (names.length > MAX_TRAIL) names = names.slice(names.length - MAX_TRAIL);
  const refs = names.map((n) => (n === ref.name ? ref : refFromDir(vscode.Uri.joinPath(ref.dir, '..', n))));
  const trail = refs.every((r) => r) ? (refs as [ExplainerRef, ...ExplainerRef[]]) : ([ref] as [ExplainerRef]);
  const sources = ['tree', 'lens', 'status', 'step', 'pick', 'here'];
  return { ref, trail, anchor, newPanel: a.newPanel === true, source: typeof a.source === 'string' && sources.includes(a.source) ? (a.source as OpenAtArgs['source']) : undefined };
}

export class Navigator {
  private readonly host: NavigatorHost;
  /** The newest panel `openAt` opened in which the reader hasn't navigated since. */
  private previewPanel: ExplainerSession | undefined;
  private lastTreeOpen: { key: string; at: number; pending: Promise<ExplainerSession | undefined> } | undefined;

  constructor(host: NavigatorHost) {
    this.host = host;
  }

  /** Recently opened sidestories (folder URI strings), newest first. */
  recent(): string[] {
    const r = this.host.memento.get<unknown>(RECENT_KEY, []);
    return Array.isArray(r) ? r.filter((x): x is string => typeof x === 'string').slice(0, MAX_RECENT) : [];
  }

  private recentRanks: Map<string, number> | undefined;

  /** Rank (1 = newest) of a recently opened sidestory by `uriKey`, else undefined; cached until the list changes. */
  recentRank(key: string): number | undefined {
    if (!this.recentRanks) {
      this.recentRanks = new Map();
      this.recent().forEach((d, i) => {
        try {
          const k = uriKey(vscode.Uri.parse(d));
          if (!this.recentRanks!.has(k)) this.recentRanks!.set(k, i + 1);
        } catch {
          // not a URI: skip it
        }
      });
    }
    return this.recentRanks.get(key);
  }

  /** Every open, switch and dive records the sidestory. */
  noteOpened(ref: ExplainerRef): void {
    const dir = ref.dir.toString();
    const next = [dir, ...this.recent().filter((d) => d !== dir)].slice(0, MAX_RECENT);
    this.recentRanks = undefined;
    void this.host.memento.update(RECENT_KEY, next);
  }

  /** A panel was created (by anyone): track whether it is the preview. */
  attach(s: ExplainerSession): void {
    s.onDidNavigate(() => {
      if (this.previewPanel === s) this.previewPanel = undefined;
    });
    s.onDidDispose(() => {
      if (this.previewPanel === s) this.previewPanel = undefined;
      this.lastTreeOpen = undefined; // its pending open may resolve to this closed panel
    });
  }

  get preview(): ExplainerSession | undefined {
    return this.previewPanel;
  }

  async openAt(raw: unknown): Promise<ExplainerSession | undefined> {
    const args = validateOpenAt(raw);
    if (!args) {
      void vscode.window.showWarningMessage('Not a sidestory: expected a folder like .sidestory/<name> inside the workspace.');
      return undefined;
    }
    const { ref, trail, anchor, newPanel, source } = args;
    const key = uriKey(ref.dir);

    // A second open of the same tree item within 500 ms is a double-click: keep the panel it opened. VS Code sends
    // both invocations at once, so the first is recorded (with its pending result) before anything is awaited.
    // With workbench.list.openMode "doubleClick", every open from the tree is one, so every tree open keeps its panel.
    const doubleMode = source === 'tree' && vscode.workspace.getConfiguration('workbench.list').get<string>('openMode') === 'doubleClick';
    if (source === 'tree') {
      const last = this.lastTreeOpen;
      if (last && last.key === key && Date.now() - last.at < DOUBLE_OPEN_MS) {
        const s = await last.pending;
        if (s && this.previewPanel === s) this.keep(s);
        return s;
      }
    }
    const pending = this.place(trail, anchor, newPanel, key);
    // A second click waits on this; a failed open must not reject it a second time.
    if (source === 'tree') this.lastTreeOpen = { key, at: Date.now(), pending: pending.catch(() => undefined) };
    const session = await pending;
    if (session && doubleMode && this.previewPanel === session) this.keep(session);
    return session;
  }

  /** Decides where the sidestory opens (§7.5) and opens it there. */
  private async place(trail: [ExplainerRef, ...ExplainerRef[]], anchor: string | undefined, newPanel: boolean, key: string): Promise<ExplainerSession | undefined> {
    const same = (s: ExplainerSession) => uriKey(s.ref.dir) === key;
    let session: ExplainerSession | undefined;
    if (newPanel) {
      session = await this.host.start(trail, anchor);
    } else {
      const sessions = this.host.sessions();
      const current = this.host.current();
      // 1. A panel already showing it: reveal it there, keeping its trail.
      const showing = current && same(current) ? current : sessions.find(same);
      if (showing) {
        showing.panel.reveal(undefined, true);
        session = showing;
      } else if (current && sessions.includes(current) && uriKey(current.trailRefs[0]!.dir) === uriKey(trail[0].dir)) {
        // 2. The current panel's trail starts at the same top: the trail's Back still leads to all they saw.
        current.panel.reveal(undefined, true);
        await current.show(trail, anchor);
        session = current;
      } else if (this.previewPanel && sessions.includes(this.previewPanel)) {
        // 3. The preview panel holds nothing the reader would lose.
        const p = this.previewPanel;
        p.panel.reveal(undefined, true);
        await p.show(trail, anchor);
        session = p;
      } else {
        // 4. A new panel beside the editor, which becomes the preview.
        session = await this.host.start(trail, anchor);
        this.previewPanel = session;
        session.preview = true;
        this.host.previewChanged?.(session);
      }
    }
    // Another open may have taken this panel meanwhile (two lenses clicked quickly): its section isn't ours to set.
    if (anchor && session && same(session)) session.goTo(anchor);
    return session;
  }

  /** Keep Open, or a double-click: the panel stops being the preview. */
  keep(s: ExplainerSession): void {
    s.preview = false;
    if (this.previewPanel === s) this.previewPanel = undefined;
    this.host.previewChanged?.(s);
  }
}
