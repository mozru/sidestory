// Widgets, extension side (docs/WIDGETS-PLAN.md §3–§5): whether a panel may run its explainer's widgets
// (trust, the `sidestory.widgets.enabled` setting, the reader's consent in a native modal), compiled code
// and library texts for the panel, what widgets may read (`useAnchorCode`), highlights and reveals, the
// watchdogs, and diagnostics for authors. Everything a panel asks for is checked here again: the panel
// renders untrusted content, so its requests are only requests.
import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import * as vscode from 'vscode';
import type { Anchor, LineRange, Manifest, Quote } from '../../core/manifest.ts';
import { parseManifest } from '../../core/manifest.ts';
import type { Resolution } from '../../core/resolve.ts';
import { splitLines } from '../../core/text.ts';
import type { FromWebview, ToWebview, WidgetBuild, WidgetGate } from '../../shared/protocol.ts';
import { WIDGET_LIBRARIES } from '../../shared/widget-imports.ts';
import type { WidgetCode } from '../../shared/widget-protocol.ts';
import type { ExplainerRef } from '../explainers.ts';
import { htmlUri, MAX_CODE_BYTES, MAX_HTML_BYTES, readBytesInside, readInside, refFromDir } from '../explainers.ts';
import { log } from '../log.ts';
import { WidgetStates } from '../../shared/widget-state.ts';
import { decideCodeAccess, languageOf, type GitFacts } from './code-access.ts';
import { compileWidget, type CompileResult } from './compile.ts';
import { acknowledge, contentHash, decideConsent, EMPTY_CONSENT, linesCovered, type ConsentRecord, type FileGit, type WidgetFile } from './consent.ts';
import { Git } from './git.ts';
import { anchorsRead, scanWidgets, widgetSources } from './html.ts';
import { isSecretPath } from './secret-files.ts';
import { Escalations, HeartbeatWatchdog, ourModal, QUIET, TICK_MS } from './watchdog.ts';

const CONSENT_KEY = 'sidestory.widgetConsent';
const CONFIRMED_KEY = 'sidestory.widgetQuotesConfirmed';
const DISABLED_KEY = 'sidestory.widgetsDisabled';
const STATES_KEY = 'sidestory.widgetStates';
/** Explainers whose widget state is kept; the least recently saved are dropped past this. */
const MAX_STATE_EXPLAINERS = 16;
const MAX_CONFIRMED = 2000;
const MAX_HEIGHTS = 200;
const MAX_FILE_BYTES = 5_000_000;
const CODE_DELAY = 200;
const MAX_LOGS_PER_MINUTE = 100;
const REMOUNT_DELAY = 1000;
/** Reports of unresponsive widgets from every panel within this long are one incident (one shared process). */
const UNRESPONSIVE_DEBOUNCE = 500;
const MAX_DISABLED = 200;
const COLD_COMPILE_MS = 10_000;
/** Compile failures that aren't the code's fault for certain. */
const TRANSIENT = new Set(['timeout', 'crashed', 'internal']);
/** Text from the explainer (its title) in a native modal: one line, no control characters, quoted. */
export function modalText(s: string, max = 80): string {
  // eslint-disable-next-line no-control-regex
  const one = s.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g, ' ').replace(/\s+/g, ' ').trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/** What the widget host needs from an explainer session. */
export interface WidgetSessionPort {
  readonly panel: vscode.WebviewPanel;
  /** A recreated panel (watchdog recovery): it gets no second recovery. */
  readonly recovered: boolean;
  ref(): ExplainerRef;
  /** Bumped whenever the panel shows another explainer. */
  generation(): number;
  post(m: ToWebview): boolean;
  manifest(): Manifest | undefined;
  html(): string;
  title(): string;
  resolution(id: string): Resolution | undefined;
  /** The id of the latest focus question (answers to older ones are ignored). */
  focusQuery?(): number;
  /** The panel recovered from a hang works again: a later hang may be recovered from too. */
  healthy?(): void;
  /** A widget's reveal(): show the anchor's code and put the cursor there, as an inline reference does. */
  reveal(anchor: string, lines?: [number, number], identifiers?: string[]): void;
  /** Lines (absolute, inside the anchor) and identifiers to highlight; undefined clears. */
  highlight(h: { anchor: string; range: LineRange; identifiers: string[] } | undefined): void;
}

/** Pin's questions about widgets (docs/WIDGETS-PLAN.md §5.2 "Pin and widgets"). */
export interface PinWidgetHooks {
  /** Anchors this explainer's widgets read with useAnchorCode (`all` when an id is computed); undefined: none or unknown. */
  readAnchors(): Promise<Set<string> | 'all' | undefined>;
  /** Lists what widgets could then read and asks; true when the user agrees. */
  confirm(entries: { id: string; file: string; range: LineRange }[]): Promise<boolean>;
  /** Records quotes Pin wrote after that confirmation. */
  record(entries: { file: string; quote: Quote; range: LineRange }[]): void;
  /** Already confirmed in this workspace (the same quote at the same range). */
  isConfirmed(file: string, quote: Quote, range: LineRange): boolean;
  /** The anchor's current quote is in the manifest committed at HEAD (widgets may read it anyway). */
  isCommitted(a: Anchor): Promise<boolean>;
}

/** Anchors widgets would read, for a modal: exact line ranges per file. */
function readingList(entries: readonly { id: string; file: string; range: LineRange }[]): string {
  const byFile = new Map<string, string[]>();
  for (const e of entries) byFile.set(e.file, [...(byFile.get(e.file) ?? []), `lines ${e.range.start}–${e.range.end} (${e.id})`]);
  return [...byFile].map(([f, r]) => `${f}: ${r.join(', ')}`).join('\n');
}

const quoteKey = (file: string, quote: Quote, range: LineRange) => `${file}\n${createHash('sha256').update(quote.exact).digest('hex')}\n${range.start}-${range.end}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toBuild(r: CompileResult): WidgetBuild {
  return { entry: r.entry, modules: r.modules, libraries: r.libraries, icons: r.icons, errors: r.errors.map((e) => ({ file: e.file, line: e.line, column: e.column, message: e.message })), hash: r.hash };
}

export class WidgetHost implements vscode.Disposable {
  private readonly context: vscode.ExtensionContext;
  readonly git = new Git();
  private readonly panels = new Set<PanelWidgets>();
  private readonly libTexts = new Map<string, Promise<string | undefined>>();
  private readonly compiles = new Map<string, Promise<CompileResult>>();
  private readonly heights = new Map<string, Record<string, number>>();
  private readonly headManifests = new Map<string, Promise<Map<string, Quote | undefined> | null>>();
  private readonly escalations = new Escalations();
  private warm = false;
  /** Explainers whose widgets the watchdog gave up on (until Enable Widgets), by folder URI. */
  private readonly stoppedExplainers = new Set<string>();
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('sidestory-widgets');
  private readonly diagnosed = new Map<string, vscode.Uri[]>();
  private readonly checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  /** Unresponsive reports gathered across panels for one incident. */
  private incident: { reports: { p: PanelWidgets; crumbs: Crumbs }[]; timer: ReturnType<typeof setTimeout> } | undefined;
  /** Recreates a panel in the same column at the same place (watchdog recovery); set by the extension. */
  recreate: (port: WidgetSessionPort) => void = () => {};

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    // Widget files are observed in every explainer, not only while a panel is open, so edits are recorded
    // as the user's own (and diagnostics stay current).
    const watcher = vscode.workspace.createFileSystemWatcher('**/.sidestory/*/**');
    const changed = (uri: vscode.Uri) => this.onWorkspaceFile(uri);
    this.subscriptions.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('sidestory.widgets.enabled')) this.refreshAll();
      }),
      // Widgets mount when trust is granted, without reopening the panel.
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshAll()),
      this.diagnostics,
    );
  }

  enabled(): boolean {
    return vscode.workspace.getConfiguration('sidestory').get<boolean>('widgets.enabled', true);
  }

  attach(port: WidgetSessionPort): PanelWidgets {
    const p = new PanelWidgets(this, port);
    this.panels.add(p);
    this.tickTimer ??= setInterval(() => {
      const at = Date.now();
      const quiet = QUIET.active(at);
      for (const x of this.panels) if (x.watchdog.tick(at, true, quiet) === 'trip') void this.trip(x);
    }, TICK_MS);
    return p;
  }

  detach(p: PanelWidgets): void {
    this.panels.delete(p);
    if (this.panels.size === 0 && this.tickTimer) {
      clearInterval(this.tickTimer);
      this.tickTimer = undefined;
    }
  }

  refreshAll(): void {
    for (const p of this.panels) void p.refreshGate();
  }

  // ---- stores (workspace state) ----

  consent(): ConsentRecord {
    return this.context.workspaceState.get<ConsentRecord>(CONSENT_KEY, EMPTY_CONSENT);
  }

  async acknowledge(files: readonly WidgetFile[], grant: boolean): Promise<void> {
    await this.context.workspaceState.update(CONSENT_KEY, acknowledge(this.consent(), files, grant));
  }

  async revokeConsent(): Promise<void> {
    await this.context.workspaceState.update(CONSENT_KEY, undefined);
    await this.context.workspaceState.update(CONFIRMED_KEY, undefined);
    this.refreshAll();
  }

  confirmed(file: string, quote: Quote, range: LineRange): boolean {
    return this.context.workspaceState.get<string[]>(CONFIRMED_KEY, []).includes(quoteKey(file, quote, range));
  }

  async confirm(entries: { file: string; quote: Quote; range: LineRange }[]): Promise<void> {
    const keys = entries.map((e) => quoteKey(e.file, e.quote, e.range));
    const list = this.context.workspaceState.get<string[]>(CONFIRMED_KEY, []).filter((k) => !keys.includes(k));
    await this.context.workspaceState.update(CONFIRMED_KEY, [...list, ...keys].slice(-MAX_CONFIRMED));
  }

  private disabledMap(): Record<string, string> {
    return this.context.workspaceState.get<Record<string, string>>(DISABLED_KEY, {});
  }

  /** Disabled by the watchdog until its source changes (a different hash enables it again). */
  isDisabled(ref: ExplainerRef, src: string, hash: string | undefined): boolean {
    const h = this.disabledMap()[`${ref.dir.toString()}\n${src}`];
    return h !== undefined && (hash === undefined || h === hash);
  }

  async disable(ref: ExplainerRef, srcs: { src: string; hash: string }[]): Promise<void> {
    const map = { ...this.disabledMap() };
    for (const s of srcs) {
      delete map[`${ref.dir.toString()}\n${s.src}`];
      map[`${ref.dir.toString()}\n${s.src}`] = s.hash;
    }
    const keys = Object.keys(map);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_DISABLED))) delete map[k];
    await this.context.workspaceState.update(DISABLED_KEY, map);
  }

  /** Entries whose code changed since (enabled again by that) are forgotten. */
  async pruneDisabled(ref: ExplainerRef, hashes: ReadonlyMap<string, string>): Promise<void> {
    const next = { ...this.disabledMap() };
    let changed = false;
    for (const [src, hash] of hashes) {
      const k = `${ref.dir.toString()}\n${src}`;
      if (next[k] !== undefined && next[k] !== hash) {
        delete next[k];
        changed = true;
      }
    }
    if (changed) await this.context.workspaceState.update(DISABLED_KEY, next);
  }

  /** The watchdog gave up on this explainer's widgets. */
  isStopped(ref: ExplainerRef): boolean {
    return this.stoppedExplainers.has(ref.dir.toString());
  }

  async enableAll(): Promise<void> {
    this.stoppedExplainers.clear();
    await this.context.workspaceState.update(DISABLED_KEY, undefined);
    this.refreshAll();
  }

  /**
   * The reader's "Try again" in a widget's box: that widget (or, when the watchdog stopped the explainer, its
   * widgets) runs again. The trip still counts: another within 5 minutes escalates.
   */
  async retry(ref: ExplainerRef, src: string): Promise<void> {
    const map = { ...this.disabledMap() };
    delete map[`${ref.dir.toString()}\n${src}`];
    await this.context.workspaceState.update(DISABLED_KEY, map);
    this.stoppedExplainers.delete(ref.dir.toString());
    log.info(`${ref.name}: ${src} was turned on again from its box (Try again).`);
    this.refreshAll();
  }

  /** What readers set in an explainer's widgets (useWidgetState), kept across window reloads and closing the panel. */
  statesFor(ref: ExplainerRef): [string, string][] {
    return this.context.workspaceState.get<Record<string, [string, string][]>>(STATES_KEY, {})[ref.dir.toString()] ?? [];
  }

  private stateWrites: Promise<void> = Promise.resolve();

  /** Keeps widget state (by widget key) for an explainer, with the panel's caps: 64 KB per widget, 256 KB per explainer. */
  saveStates(dir: string, entries: readonly [string, string][]): Promise<void> {
    // One write at a time: each reads what the last one wrote.
    this.stateWrites = this.stateWrites.then(async () => {
      const all = { ...this.context.workspaceState.get<Record<string, [string, string][]>>(STATES_KEY, {}) };
      const states = new WidgetStates(all[dir] ?? []);
      for (const [key, json] of entries) states.set(key, json);
      delete all[dir]; // re-inserted last: the most recently used explainers are kept longest
      all[dir] = states.save();
      const dirs = Object.keys(all);
      for (const d of dirs.slice(0, Math.max(0, dirs.length - MAX_STATE_EXPLAINERS))) delete all[d];
      await this.context.workspaceState.update(STATES_KEY, all);
    }).catch((e: Error) => log.warn(`Couldn't keep widget state: ${e.message}`));
    return this.stateWrites;
  }

  heightsFor(ref: ExplainerRef): Record<string, number> {
    return this.heights.get(ref.dir.toString()) ?? {};
  }

  setHeights(ref: ExplainerRef, heights: Record<string, number>): void {
    const all = { ...this.heightsFor(ref), ...heights };
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - MAX_HEIGHTS))) delete all[k];
    this.heights.set(ref.dir.toString(), all);
  }

  // ---- compiling, libraries ----

  compile(ref: ExplainerRef, src: string): Promise<CompileResult> {
    const key = `${ref.dir.toString()}\n${src}`;
    let p = this.compiles.get(key);
    if (!p) {
      // The first compile also starts the worker and loads the compiler: give it longer.
      const timeoutMs = this.warm ? undefined : COLD_COMPILE_MS;
      this.warm = true;
      const q = compileWidget(ref.dir.fsPath, src, timeoutMs ? { timeoutMs } : undefined);
      p = q;
      this.compiles.set(key, q);
      // A timeout or a crash says nothing about the code for certain (a busy machine): not kept.
      void q.then((r) => {
        if (r.errors.some((e) => TRANSIENT.has(e.code ?? '')) && this.compiles.get(key) === q) this.compiles.delete(key);
      });
    }
    return p;
  }

  /** Something in the explainer folder changed: compile its widgets afresh (the worker still caches unchanged modules). */
  invalidate(ref: ExplainerRef): void {
    const prefix = `${ref.dir.toString()}\n`;
    for (const k of [...this.compiles.keys()]) if (k.startsWith(prefix)) this.compiles.delete(k);
  }

  /** A library's text, read once from the extension's own dist/widget-libs and shared by every panel. */
  library(id: string): Promise<string | undefined> {
    if (!WIDGET_LIBRARIES.some((l) => l.id === id)) return Promise.resolve(undefined);
    let p = this.libTexts.get(id);
    if (!p) {
      p = readFile(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'widget-libs', `${id}.js`).fsPath, 'utf8').catch((e: Error) => {
        log.error(`Widget library ${id} is missing from this build: ${e.message}`);
        this.libTexts.delete(id);
        return undefined;
      });
      this.libTexts.set(id, p);
    }
    return p;
  }

  // ---- consent ----

  /**
   * Git's view of a widget file for consent, after the repository settled following an event at `since`. A
   * symlink, or a repository that doesn't settle (a long rebase), is `unknown`: changed code asks.
   */
  async fileGit(uri: vscode.Uri, since = Date.now(), base?: vscode.Uri): Promise<FileGit> {
    if (await throughLink(uri, base)) return { kind: 'unknown' };
    const l = await this.git.lookup(uri);
    if (l.kind !== 'repo') return l;
    if (await throughLink(uri, l.repo.rootUri)) return { kind: 'unknown' };
    if (!(await this.git.settle(l.repo, since))) return { kind: 'unknown' };
    const [headBlob, text] = await Promise.all([this.git.headBlob(l.repo, uri), this.git.headText(l.repo, uri)]);
    return { kind: 'repo', headBlob, headHash: text === null ? null : contentHash(text) };
  }

  /**
   * One widget file for consent: its bytes and git's view, consistent with each other. Git is settled only
   * when the bytes differ from the record (unchanged code never waits on a paused rebase); then the bytes
   * are read again after settling, and if git moved or the bytes changed while it was asked, the answer is
   * `unknown` (asks).
   */
  async widgetFile(uri: vscode.Uri, dir: vscode.Uri, since: number, root: vscode.Uri = dir): Promise<WidgetFile> {
    const path = this.consentPath(uri);
    const read = async () => {
      const bytes = await readBytesInside(uri, dir, MAX_FILE_BYTES);
      return bytes ? contentHash(bytes) : 'missing';
    };
    let hash = await read();
    const unknown = (): WidgetFile => ({ path, hash, git: { kind: 'unknown' } });
    // Any link from the repository root down (the explainer folder itself, `.sidestory`, a folder in it): git
    // knows the file by another path, or not at all.
    if (await throughLink(uri, root)) return unknown();
    const l = await this.git.lookup(uri);
    if (l.kind !== 'repo') return { path, hash, git: l };
    // And from the repository's own root: a link above the folder holding `.sidestory` (b -> a, opened as
    // b/.sidestory/x) makes git know the file by another path, or not at all.
    if (await throughLink(uri, l.repo.rootUri)) return unknown();
    const known = this.consent().files[path];
    const settle = known?.hash !== hash;
    if (settle) {
      if (!(await this.git.settle(l.repo, since))) return unknown();
      hash = await read();
    }
    const head = this.git.head(l.repo);
    const [headBlob, text] = await Promise.all([this.git.headBlob(l.repo, uri), this.git.headText(l.repo, uri)]);
    if (settle && (this.git.head(l.repo) !== head || (await this.git.busy(l.repo)) || (await read()) !== hash)) return unknown();
    return { path, hash, git: { kind: 'repo', headBlob, headHash: text === null ? null : contentHash(text) } };
  }

  /** How consent names a file: workspace-relative (the record survives moving the workspace). */
  consentPath(uri: vscode.Uri): string {
    return vscode.workspace.asRelativePath(uri, true);
  }

  /** The files of these widgets' import closures, hashed from their bytes now, with git's view of each. */
  async widgetFiles(ref: ExplainerRef, results: readonly CompileResult[], since = Date.now()): Promise<WidgetFile[]> {
    const paths = [...new Set(results.flatMap((r) => r.files))];
    const out: WidgetFile[] = [];
    for (const rel of paths) out.push(await this.widgetFile(vscode.Uri.joinPath(ref.dir, rel), ref.dir, since, ref.root));
    return out;
  }

  /**
   * The workspace watcher: record edits of acknowledged widget files as the user's own (unless they arrived
   * through git), re-check diagnostics. Files consent never saw are judged when an explainer uses them.
   */
  private onWorkspaceFile(uri: vscode.Uri): void {
    const at = Date.now();
    const m = /^(.*\/\.sidestory\/[^/]+)(\/.*)$/.exec(uri.path);
    if (!m) return;
    const ref = refFromDir(uri.with({ path: m[1]! }));
    if (!ref) return;
    this.invalidate(ref);
    const key = ref.dir.toString();
    clearTimeout(this.checkTimers.get(key));
    this.checkTimers.set(key, setTimeout(() => {
      this.checkTimers.delete(key);
      void this.check(ref);
    }, 300));
    if (!vscode.workspace.isTrusted || !this.consent().granted || /\/(manifest\.json|sidestory\.html)$/.test(uri.path)) return;
    const path = this.consentPath(uri);
    if (!Object.hasOwn(this.consent().files, path)) return;
    void (async () => {
      const file = await this.widgetFile(uri, ref.dir, at, ref.root);
      if (file.hash === 'missing') return;
      const d = decideConsent(this.consent(), [file]);
      if (d.observed.length) await this.acknowledge(d.observed, false);
    })();
  }

  /** Diagnostics for an explainer's widgets (compiling runs nothing, so it needs no consent; not in Restricted Mode). */
  async check(ref: ExplainerRef, html?: string): Promise<CompileResult[]> {
    html ??= (await readInside(htmlUri(ref), ref.root, MAX_HTML_BYTES)) ?? '';
    if (!vscode.workspace.isTrusted) return [];
    const srcs = widgetSources(html);
    const results = await Promise.all(srcs.map((s) => this.compile(ref, s)));
    const byUri = new Map<string, { uri: vscode.Uri; list: vscode.Diagnostic[] }>();
    const add = (uri: vscode.Uri, d: vscode.Diagnostic) => {
      const k = uri.toString();
      if (!byUri.has(k)) byUri.set(k, { uri, list: [] });
      const list = byUri.get(k)!.list;
      if (!list.some((x) => x.message === d.message && x.range.isEqual(d.range))) list.push(d);
    };
    for (const p of scanWidgets(html).problems) {
      const d = new vscode.Diagnostic(new vscode.Range(p.line - 1, 0, p.line - 1, 1000), p.message, p.severity === 'error' ? vscode.DiagnosticSeverity.Error : vscode.DiagnosticSeverity.Warning);
      d.source = 'Sidestory';
      add(htmlUri(ref), d);
    }
    for (const r of results) {
      for (const [list, severity] of [[r.errors, vscode.DiagnosticSeverity.Error], [r.warnings, vscode.DiagnosticSeverity.Warning]] as const) {
        for (const e of list) {
          const line = Math.max(0, (e.line ?? 1) - 1);
          const col = Math.max(0, (e.column ?? 1) - 1);
          const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1000), e.message, severity);
          d.source = 'Sidestory';
          d.code = e.code;
          add(vscode.Uri.joinPath(ref.dir, e.file), d);
        }
      }
    }
    const key = ref.dir.toString();
    for (const old of this.diagnosed.get(key) ?? []) if (!byUri.has(old.toString())) this.diagnostics.delete(old);
    for (const { uri, list } of byUri.values()) this.diagnostics.set(uri, list);
    this.diagnosed.set(key, [...byUri.values()].map((v) => v.uri));
    return results;
  }

  // ---- code access ----

  /** Quotes in the manifest committed at HEAD, by anchor id (null: no repository, or not committed). */
  private async headQuotes(ref: ExplainerRef): Promise<Map<string, Quote | undefined> | null> {
    const uri = vscode.Uri.joinPath(ref.dir, 'manifest.json');
    const l = await this.git.lookup(uri);
    if (l.kind !== 'repo') return null;
    const key = `${this.git.head(l.repo)}\n${uri.toString()}`;
    let p = this.headManifests.get(key);
    if (!p) {
      p = this.git.headText(l.repo, uri).then((text) => {
        const parsed = text === null ? undefined : parseManifest(text);
        return parsed?.ok ? new Map([...parsed.manifest.anchors].map(([id, a]) => [id, a.quote])) : null;
      });
      this.headManifests.set(key, p);
      if (this.headManifests.size > 50) this.headManifests.delete(this.headManifests.keys().next().value!);
    }
    return p;
  }

  async quoteAtHead(ref: ExplainerRef, a: Anchor): Promise<boolean> {
    const q = (await this.headQuotes(ref))?.get(a.id);
    return !!q && !!a.quote && q.exact === a.quote.exact && q.norm === a.quote.norm;
  }

  async codeFor(port: WidgetSessionPort, id: string): Promise<WidgetCode> {
    const ref = port.ref();
    const a = port.manifest()?.anchors.get(id);
    if (!a) return { anchor: id, status: 'unavailable', reason: 'lost' };
    const uri = vscode.Uri.joinPath(ref.root, a.file);
    const text = isSecretPath(a.file) ? undefined : await readInside(uri, ref.root, MAX_CODE_BYTES);
    const real = uri.scheme === 'file' ? await realpath(uri.fsPath).catch(() => undefined) : undefined;
    // Git is asked about the file the text is read from: through a symlink, `git show` would give the link's
    // target path and the ignore check would judge the link, not the file behind it.
    const target = real ? vscode.Uri.file(real) : uri;
    let git: GitFacts = { kind: 'none' };
    const l = await this.git.lookup(target);
    if (l.kind === 'unknown') git = { kind: 'unknown' };
    else if (l.kind === 'repo') {
      const [tracked, ignored, headText] = await Promise.all([this.git.tracked(l.repo, target), this.git.ignored(l.repo, target), this.git.headText(l.repo, target)]);
      git = { kind: 'repo', tracked, ignored, headText };
    }
    return decideCodeAccess({
      anchor: a,
      resolution: port.resolution(id),
      lines: text === undefined ? undefined : splitLines(text),
      realName: real ? basename(real) : undefined,
      quoteAtHead: await this.quoteAtHead(ref, a),
      confirmed: !!a.quote && this.confirmed(a.file, a.quote, a.range),
      git,
      language: languageOf(a.file),
    });
  }

  /** Anchors that widgets read whose quotes nobody confirmed (not committed at HEAD, not confirmed here). */
  async unconfirmed(port: WidgetSessionPort, results: readonly CompileResult[]): Promise<Anchor[]> {
    const m = port.manifest();
    if (!m) return [];
    const read = new Set<string>();
    for (const r of results) {
      const ids = anchorsRead(r.modules);
      if (ids === 'all') for (const id of m.anchors.keys()) read.add(id);
      else for (const id of ids) read.add(id);
    }
    const out: Anchor[] = [];
    for (const id of read) {
      const a = m.anchors.get(id);
      if (!a?.quote || a.quote.norm !== 'ws' || isSecretPath(a.file)) continue;
      if (this.confirmed(a.file, a.quote, a.range) || (await this.quoteAtHead(port.ref(), a))) continue;
      out.push(a);
    }
    return out;
  }

  /** The native modal for anchors widgets would read: exact line ranges per file. */
  async confirmReading(title: string, entries: { id: string; file: string; range: LineRange }[]): Promise<boolean> {
    if (entries.length === 0) return false;
    const ok = 'Let Widgets Read';
    const choice = await ourModal(() => vscode.window.showWarningMessage(
      `Let the widgets in “${modalText(title)}” read this code?`,
      { modal: true, detail: `${readingList(entries)}\n\nWidgets would see these lines as they are in the editor, including unsaved edits.` },
      ok,
    ));
    return choice === ok;
  }

  pinHooks(ref: ExplainerRef): PinWidgetHooks {
    return {
      readAnchors: async () => {
        if (!vscode.workspace.isTrusted) return undefined;
        const results = await this.check(ref);
        let read: Set<string> | 'all' = new Set();
        for (const r of results) {
          const ids = anchorsRead(r.modules);
          if (ids === 'all') read = 'all';
          else if (read !== 'all') for (const id of ids) read.add(id);
        }
        return read === 'all' || read.size ? read : undefined;
      },
      confirm: (entries) => this.confirmReading(ref.name, entries),
      record: (entries) => void this.confirm(entries).then(() => this.refreshAll()),
      isConfirmed: (file, quote, range) => this.confirmed(file, quote, range),
      isCommitted: (a) => this.quoteAtHead(ref, a),
    };
  }

  // ---- watchdogs (docs/WIDGETS-PLAN.md §4) ----

  private notifyDisabled(port: WidgetSessionPort, what: string): void {
    const enable = 'Enable Widgets';
    void vscode.window.showWarningMessage(`${what} in “${modalText(port.title() || port.ref().name)}” stopped responding, so ${what === 'A widget' ? 'it is' : 'they are'} turned off until the code changes. "Try again" in ${what === 'A widget' ? 'its box' : 'their boxes'} turns ${what === 'A widget' ? 'it' : 'them'} on again.`, enable).then((c) => {
      if (c === enable) void vscode.commands.executeCommand('sidestory.enableWidgets');
    });
  }

  /** Disables the suspect (first trip) or all of an explainer's widgets (second within 5 minutes); `false` past that. */
  private async escalate(p: PanelWidgets, suspect: string | undefined): Promise<boolean> {
    const ref = p.port.ref();
    const step = this.escalations.record(ref.dir.toString(), Date.now());
    if (step === 'stop') {
      // None of this explainer's widgets run any more (each box says so) until Enable Widgets.
      this.stoppedExplainers.add(ref.dir.toString());
      log.error(`${ref.name}: widgets keep freezing the panel, so none of them run now. Run "Sidestory: Enable Widgets" to try again.`);
      void vscode.window.showErrorMessage(`Widgets in “${modalText(p.port.title() || ref.name)}” keep freezing the panel, so they were stopped.`, 'Enable Widgets').then((c) => {
        if (c) void vscode.commands.executeCommand('sidestory.enableWidgets');
      });
      return false;
    }
    // Without evidence against one widget (none mounting, none doing work, several mounted), a first trip
    // blames none: the panel is just reloaded. A second within 5 minutes turns them all off.
    const srcs = step === 'suspect' ? (suspect ? [suspect] : []) : p.sources();
    if (srcs.length === 0) {
      log.warn(`${ref.name}: the panel stopped responding, with no widget to suspect; it was reloaded.`);
      return true;
    }
    await this.disable(ref, await Promise.all(srcs.map(async (src) => ({ src, hash: (await this.compile(ref, src)).hash }))));
    log.warn(`${ref.name}: the watchdog turned off ${srcs.join(', ')} until ${srcs.length === 1 ? 'its' : 'their'} code changes.`);
    this.notifyDisabled(p.port, srcs.length === 1 ? 'A widget' : 'Widgets');
    return true;
  }

  /**
   * Panel-side watchdog: one panel's widgets stopped answering. All panels likely share one widget process,
   * so every panel unmounts all its frames (with none left, Chromium replaces the process), the suspect is
   * disabled, and the rest mount again.
   */
  unresponsive(p: PanelWidgets, crumbs: Crumbs): void {
    // A dialog of ours was open (or a gate just mounted widgets): their silence says nothing. The panel starts counting again.
    if (QUIET.active(Date.now()) && !this.incident) {
      log.info(`${p.port.ref().name}: widgets were slow to answer while a dialog was open or widgets were mounting; not held against them.`);
      p.port.post({ type: 'widgetsReset', phase: 'remount' });
      return;
    }
    // Every panel whose widgets share the hung process reports it: one incident, one suspect, one escalation.
    if (!this.incident) {
      for (const x of this.panels) x.port.post({ type: 'widgetsReset', phase: 'unmount' });
      this.incident = { reports: [], timer: setTimeout(() => void this.settleIncident(), UNRESPONSIVE_DEBOUNCE) };
    }
    this.incident.reports.push({ p, crumbs });
  }

  private async settleIncident(): Promise<void> {
    const reports = this.incident?.reports ?? [];
    // The suspect: a widget that was mounting when it happened (in any panel), else one a report names as
    // the latest to do work. Without either, no explainer is blamed (it could be any panel's).
    const pick = reports.find((r) => r.crumbs.mounting) ?? reports.find((r) => r.crumbs.recent);
    if (pick) {
      const { p, crumbs } = pick;
      const suspect = crumbs.mounting ?? crumbs.recent ?? undefined;
      log.warn(`${p.port.ref().name}: widgets stopped responding (mounted: ${crumbs.mounted.join(', ') || 'none'}; mounting: ${crumbs.mounting ?? 'none'}; ${reports.length} panel${reports.length === 1 ? '' : 's'} reported it).`);
      // On "stop" the explainer's gate turns every widget off: the remount below mounts none of them.
      await this.escalate(p, suspect);
    } else {
      log.warn(`Widgets stopped responding (${reports.length} panel${reports.length === 1 ? '' : 's'} reported it), with no widget to suspect; they were reloaded.`);
    }
    await new Promise((r) => setTimeout(r, REMOUNT_DELAY));
    this.incident = undefined;
    // Each panel learns what is turned off before it mounts anything again.
    await Promise.all([...this.panels].map(async (x) => {
      await x.refreshGate();
      x.port.post({ type: 'widgetsReset', phase: 'remount' });
    }));
  }

  /**
   * Extension-side watchdog: the panel itself stopped beating (widgets on its thread). Setting `webview.html`
   * would queue behind the hung renderer, so the panel is disposed and recreated in the same column.
   */
  async trip(p: PanelWidgets): Promise<void> {
    if (p.stopped) return;
    const ref = p.port.ref();
    log.warn(`${ref.name}: the panel stopped responding while widgets ran (last mounted: ${p.watchdog.last?.mounted.join(', ') || 'none'}).`);
    // No reset loop: a recreated panel that still misses beats is left alone.
    if (p.port.recovered) {
      p.stopped = true;
      void vscode.window.showErrorMessage(`The sidestory panel “${modalText(p.port.title() || ref.name)}” is still not responding. Close it to recover.`);
      return;
    }
    if (!(await this.escalate(p, p.watchdog.suspect()))) {
      p.stopped = true;
      return;
    }
    this.recreate(p.port);
  }

  dispose(): void {
    clearInterval(this.tickTimer);
    clearTimeout(this.incident?.timer);
    for (const t of this.checkTimers.values()) clearTimeout(t);
    for (const d of this.subscriptions) d.dispose();
  }
}

/**
 * Whether the file is reached through a symlink (itself, or a linked folder) below `base` (default: its own
 * folder): git knows such a file by another path, so its view of it can't be trusted.
 */
async function throughLink(uri: vscode.Uri, base?: vscode.Uri): Promise<boolean> {
  if (uri.scheme !== 'file') return false;
  const root = base?.fsPath ?? dirname(uri.fsPath);
  const [realRoot, real] = await Promise.all([realpath(root).catch(() => undefined), realpath(uri.fsPath).catch(() => undefined)]);
  if (!realRoot || !real) return (await lstat(uri.fsPath).then((s) => s.isSymbolicLink(), () => false));
  const expected = join(realRoot, relative(root, uri.fsPath));
  const fold = process.platform === 'win32' || process.platform === 'darwin';
  return fold ? expected.toLowerCase() !== real.toLowerCase() : expected !== real;
}

type Crumbs = { mounted: string[]; mounting: string | null; recent: string | null };

/** One panel's widgets: its gate, the builds it was sent, the code it subscribed to, its watchdog. */
export class PanelWidgets {
  readonly host: WidgetHost;
  readonly port: WidgetSessionPort;
  readonly watchdog = new HeartbeatWatchdog();
  stopped = false;
  private srcs: string[] = [];
  private results = new Map<string, CompileResult>();
  private gate: WidgetGate | undefined;
  private changed: string[] = [];
  private added: string[] = [];
  /** This explainer's widgets never ran here. */
  private first = false;
  /** Anchors the widgets read whose quotes nobody confirmed (offered in the consent modal too). */
  private unconfirmedAnchors: Anchor[] = [];
  private gateSeq = 0;
  /** The gate being computed, for requests that arrive before it is done. */
  private pending: Promise<void> | undefined;
  /** When beats from a recovered panel first came back on time. */
  private healthySince: number | undefined;
  /** What the panel was sent, by src (hash), so live edits push new builds. */
  private readonly served = new Map<string, string>();
  /** Explainers this panel showed (widget state for them is accepted). */
  private readonly dirs = new Set<string>();
  /** `${src}\n${anchor}` pairs widgets subscribed to. */
  private readonly codeAnchors = new Set<string>();
  private readonly loggedReasons = new Set<string>();
  private codeTimer: ReturnType<typeof setTimeout> | undefined;
  private logTimes: number[] = [];
  private asking = false;
  private disposed = false;

  constructor(host: WidgetHost, port: WidgetSessionPort) {
    this.host = host;
    this.port = port;
  }

  sources(): string[] {
    return [...this.srcs];
  }

  /** The explainer shown is another one now: forget everything about the last. */
  onSwitch(): void {
    this.gateSeq++;
    this.srcs = [];
    this.results.clear();
    this.gate = undefined;
    this.served.clear();
    this.codeAnchors.clear();
    this.loggedReasons.clear();
    clearTimeout(this.codeTimer);
    this.watchdog.disarm();
    this.port.highlight(undefined);
  }

  /** After `init` (a new or rebuilt page): it needs the widget state the extension keeps, and the gate again. */
  onInit(): void {
    this.served.clear();
    this.codeAnchors.clear();
    const ref = this.port.ref();
    this.dirs.add(ref.dir.toString());
    // Before anything mounts (widgets wait for the gate): the panel fills in what its own state lacks.
    const states = this.host.statesFor(ref);
    if (states.length) this.port.post({ type: 'widgetStates', states });
    if (this.gate) this.port.post({ type: 'widgets', gate: this.gate });
    void this.refreshGate();
  }

  /** The HTML changed, or something the gate depends on did. */
  refreshGate(): Promise<void> {
    const p = this.computeGate();
    this.pending = p;
    void p.finally(() => {
      if (this.pending === p) this.pending = undefined;
    });
    return p;
  }

  /** The gate is current: no computation running (one that started later is waited for too). */
  private async gateSettled(): Promise<void> {
    for (let i = 0; i < 10 && this.pending; i++) await this.pending.catch(() => undefined);
  }

  private async computeGate(): Promise<void> {
    if (this.disposed) return;
    const at = Date.now();
    const seq = ++this.gateSeq;
    const generation = this.port.generation();
    const ref = this.port.ref();
    const html = this.port.html();
    const stale = () => this.disposed || seq !== this.gateSeq || generation !== this.port.generation();
    this.srcs = widgetSources(html);
    let status: WidgetGate['status'] = 'on';
    let results: CompileResult[] = [];
    if (!this.host.enabled()) status = 'off';
    else if (!vscode.workspace.isTrusted) status = 'untrusted';
    else if (this.srcs.length) {
      results = await this.host.check(ref, html);
      if (stale()) return;
      this.results = new Map(this.srcs.map((s, i) => [s, results[i]!]));
      const files = await this.host.widgetFiles(ref, results, at);
      if (stale()) return;
      const record = this.host.consent();
      const d = decideConsent(record, files);
      if (record.granted && d.observed.length) await this.host.acknowledge(d.observed, false);
      this.changed = record.granted ? d.changed : [];
      this.added = record.granted ? d.added : [];
      this.first = d.first;
      status = d.ask ? 'ask' : 'on';
      await this.host.pruneDisabled(ref, new Map([...this.results].map(([src, r]) => [src, r.hash])));
    }
    const stopped = this.host.isStopped(ref);
    const disabled = this.srcs.filter((s) => stopped || this.host.isDisabled(ref, s, this.results.get(s)?.hash));
    let unconfirmed: WidgetGate['unconfirmed'] = null;
    this.unconfirmedAnchors = [];
    // Also while consent is pending: the consent modal then offers both at once.
    if ((status === 'on' || status === 'ask') && results.length) {
      const list = await this.host.unconfirmed(this.port, results);
      if (stale()) return;
      this.unconfirmedAnchors = list;
      if (list.length) {
        const byFile = new Map<string, LineRange[]>();
        for (const a of list) byFile.set(a.file, [...(byFile.get(a.file) ?? []), a.range]);
        unconfirmed = { anchors: list.length, summary: [...byFile].map(([f, r]) => `${f}, ${plural(linesCovered(r), 'line')}`).join('; ').slice(0, 200) };
      }
    }
    const gate: WidgetGate = { status, unconfirmed, disabled, heights: this.host.heightsFor(ref), ...(stopped ? { stopped } : {}) };
    // What may run changed (consent given, a widget turned on again): mounting a burst of widgets is no hang.
    if (status === 'on' && (this.gate?.status !== 'on' || this.gate.disabled.join('\n') !== disabled.join('\n'))) QUIET.hold(Date.now());
    this.gate = gate;
    this.port.post({ type: 'widgets', gate });
    // Live edits: builds the panel already runs are sent again when their code changed.
    if (status === 'on') {
      for (const [src, hash] of this.served) {
        const r = this.results.get(src);
        if (r && r.hash !== hash && !disabled.includes(src)) {
          this.served.set(src, r.hash);
          this.port.post({ type: 'widget', src, build: toBuild(r) });
        }
      }
    }
  }

  /** A file in the explainer folder changed. */
  onFileChanged(): void {
    this.host.invalidate(this.port.ref());
    void this.refreshGate();
  }

  /** Anchors in a file resolved again: widgets that read them get the new code. */
  onResolved(fileUri: string): void {
    const m = this.port.manifest();
    const ref = this.port.ref();
    if (!m || this.codeAnchors.size === 0) return;
    const inFile = (key: string) => {
      const a = m.anchors.get(key.slice(key.indexOf('\n') + 1));
      return a && vscode.Uri.joinPath(ref.root, a.file).toString() === fileUri;
    };
    if (![...this.codeAnchors].some(inFile)) return;
    clearTimeout(this.codeTimer);
    this.codeTimer = setTimeout(() => this.sendAllCode(), CODE_DELAY);
  }

  private sendAllCode(): void {
    for (const key of this.codeAnchors) {
      const i = key.indexOf('\n');
      void this.sendCode(key.slice(0, i), key.slice(i + 1));
    }
  }

  /**
   * Whether this widget reads the anchor, as its compiled code says (literal useAnchorCode ids, or any anchor
   * when an id is computed): a widget is served nothing else, however it asks.
   */
  private reads(src: string, id: string): boolean {
    const r = this.results.get(src);
    if (!r) return false;
    const ids = anchorsRead(r.modules);
    return ids === 'all' || ids.has(id);
  }

  /** Allowed to run widgets now (checked on every request, not only when the gate was computed). */
  private allowed(): boolean {
    return this.gate?.status === 'on' && this.host.enabled() && vscode.workspace.isTrusted;
  }

  private async sendCode(src: string, id: string): Promise<void> {
    const generation = this.port.generation();
    if (!this.reads(src, id)) {
      if (!this.loggedReasons.has(`${src}:${id}:not-read`)) {
        this.loggedReasons.add(`${src}:${id}:not-read`);
        log.warn(`${this.port.ref().name}: ${src} asked for the code of anchor '${id}', which it doesn't read with useAnchorCode('${id}'); it gets none.`);
      }
      this.port.post({ type: 'widgetCode', src, code: { anchor: id, status: 'unavailable', reason: 'not-requested' } });
      return;
    }
    const code = await this.host.codeFor(this.port, id);
    if (this.disposed || generation !== this.port.generation() || !this.allowed()) return;
    if (code.status === 'unavailable' && !this.loggedReasons.has(`${id}:${code.reason}`)) {
      this.loggedReasons.add(`${id}:${code.reason}`);
      log.info(`${this.port.ref().name}: useAnchorCode('${id}') is unavailable to widgets: ${code.reason}. ${REASON_FIX[code.reason!] ?? ''}`);
    }
    this.port.post({ type: 'widgetCode', src, code });
  }

  /** Handles the widget messages from the panel; false for anything else. */
  handle(m: FromWebview): boolean {
    const ref = this.port.ref();
    switch (m.type) {
      case 'widgetConsent':
        void this.askConsent();
        return true;
      case 'widgetTrust':
        void vscode.commands.executeCommand('workbench.trust.manage');
        return true;
      case 'widgetConfirmAnchors':
        void this.confirmAnchors();
        return true;
      case 'widgetCompile':
        void this.answerCompile(m.src);
        return true;
      case 'widgetLibs':
        if (!this.allowed()) return true;
        void Promise.all(m.ids.map(async (id) => [id, await this.host.library(id)] as const)).then((entries) => {
          if (!this.allowed()) return;
          this.port.post({ type: 'widgetLibs', libs: Object.fromEntries(entries.filter((e): e is [string, string] => e[1] !== undefined)) });
        });
        return true;
      case 'widgetCode':
        if (!this.allowed() || !this.srcs.includes(m.src) || !this.port.manifest()?.anchors.has(m.anchor)) return true;
        this.codeAnchors.add(`${m.src}\n${m.anchor}`);
        void this.sendCode(m.src, m.anchor);
        return true;
      case 'widgetHighlight': {
        if (!m.anchor) {
          this.port.highlight(undefined);
          return true;
        }
        const r = this.port.resolution(m.anchor)?.range;
        if (!this.allowed() || !r) return true;
        // Lines are relative to the anchor's current first line, clamped to the anchor.
        const [a, b] = m.lines ?? [1, r.end - r.start + 1];
        const start = Math.min(r.end, r.start + a - 1);
        const end = Math.min(r.end, Math.max(start, r.start + b - 1));
        this.port.highlight({ anchor: m.anchor, range: { start, end }, identifiers: m.identifiers ?? [] });
        return true;
      }
      case 'widgetReveal':
        if (this.allowed() && this.port.manifest()?.anchors.has(m.anchor)) this.port.reveal(m.anchor, m.lines, m.highlight);
        return true;
      case 'widgetLog': {
        const t = Date.now();
        this.logTimes = this.logTimes.filter((x) => t - x < 60_000);
        if (this.logTimes.push(t) > MAX_LOGS_PER_MINUTE) return true;
        const text = `${ref.name}: ${m.message}`;
        if (m.level === 'error') log.error(text);
        else if (m.level === 'warn') log.warn(text);
        else log.info(text);
        return true;
      }
      case 'widgetHeights':
        this.host.setHeights(ref, m.heights);
        return true;
      case 'widgetStates':
        // Only for explainers this panel showed (a widget still saving as the panel moves on is filed under its own).
        if (this.dirs.has(m.dir)) void this.host.saveStates(m.dir, m.states);
        return true;
      case 'widgetRetry':
        if (this.srcs.includes(m.src)) void this.host.retry(ref, m.src);
        return true;
      case 'heartbeat': {
        const at = Date.now();
        if (this.watchdog.beat({ delay: m.delay, visible: m.visible, mounted: m.mounted, mounting: m.mounting, recent: m.recent }, at, QUIET.active(at)) === 'trip') void this.host.trip(this);
        else if (this.port.recovered && m.visible && m.delay < 1000) {
          // A recovered panel that has beaten on time for a minute works again: a later hang gets recovered too.
          this.healthySince ??= at;
          if (at - this.healthySince > 60_000) this.port.healthy?.();
        } else this.healthySince = undefined;
        return true;
      }
      case 'widgetsUnresponsive':
        if (!this.stopped) this.host.unresponsive(this, m);
        return true;
      case 'focusAnswer':
        // Only the answer to the latest question counts (a late answer to an older one says nothing now).
        if (!m.legit && (this.port.focusQuery?.() ?? m.id) === m.id) void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        return true;
      case 'focusTheft':
        void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        return true;
      default:
        return false;
    }
  }

  /** A build for the panel, or null; a src the gate being computed will know about is answered after it. */
  private async answerCompile(src: string): Promise<void> {
    const generation = this.port.generation();
    if (!this.results.has(src) && this.pending) await this.gateSettled();
    if (this.disposed || generation !== this.port.generation()) return;
    const ref = this.port.ref();
    const r = this.results.get(src);
    const ok = this.allowed() && r && !this.gate!.disabled.includes(src) && !this.host.isDisabled(ref, src, r.hash);
    if (ok) this.served.set(src, r.hash);
    this.port.post({ type: 'widget', src, build: ok ? toBuild(r) : null });
  }

  private async askConsent(): Promise<void> {
    if (this.asking || this.gate?.status !== 'ask') return;
    this.asking = true;
    try {
      const ref = this.port.ref();
      const generation = this.port.generation();
      const results = [...this.results.values()];
      const files = await this.host.widgetFiles(ref, results);
      const run = 'Run Widgets';
      // Anchors they'd read that nobody confirmed: offered here too, so an author who just pinned isn't asked twice.
      const reads = this.unconfirmedAnchors.map((a) => ({ id: a.id, file: a.file, range: a.range, quote: a.quote! }));
      const runAndRead = 'Run Widgets and Let Them Read';
      const list = (xs: string[]) => xs.slice(0, 10).join(', ') + (xs.length > 10 ? `, and ${xs.length - 10} more` : '');
      const detail = [
        `Sidestory: “${modalText(this.port.title() || ref.name)}” (${plural(this.srcs.length, 'widget')}: ${list(this.srcs)})`,
        this.first && !this.changed.length && !this.added.length ? "This sidestory's widgets haven't run in this workspace before." : '',
        this.changed.length ? `Changed through git since you last agreed: ${list(this.changed)}` : '',
        this.added.length ? `New from git (not agreed to before): ${list(this.added)}` : '',
        'Your answer covers this code. Your own edits to it keep running; code that arrives through git (a pull, a checkout) asks again.',
        reads.length ? `\nThey also want to read this code (as it is in the editor, including unsaved edits):\n${readingList(reads)}` : '',
        'Widgets run in a sandbox that blocks the usual network calls (fetch fails), but the sandbox is best effort: treat what they can see as something they could send.',
      ].filter(Boolean).join('\n');
      const choice = await ourModal(() => vscode.window.showWarningMessage(
        "Widgets are code from this repository. They can read the code this sidestory points at (including unsaved edits) and may be able to reach the network. Run this sidestory's widgets?",
        { modal: true, detail },
        ...(reads.length ? [runAndRead, run] : [run]),
      ));
      if ((choice !== run && choice !== runAndRead) || generation !== this.port.generation()) return;
      await this.host.acknowledge(files, true);
      if (choice === runAndRead) await this.host.confirm(reads.map((r) => ({ file: r.file, quote: r.quote, range: r.range })));
      this.host.refreshAll();
    } finally {
      this.asking = false;
    }
  }

  private async confirmAnchors(): Promise<void> {
    const results = [...this.results.values()];
    const list = await this.host.unconfirmed(this.port, results);
    const ok = await this.host.confirmReading(this.port.title() || this.port.ref().name, list.map((a) => ({ id: a.id, file: a.file, range: a.range })));
    if (!ok) return;
    await this.host.confirm(list.map((a) => ({ file: a.file, quote: a.quote!, range: a.range })));
    await this.refreshGate();
    this.sendAllCode();
  }

  dispose(): void {
    this.disposed = true;
    clearTimeout(this.codeTimer);
    this.port.highlight(undefined);
    this.host.detach(this);
  }
}

/** For authors (Output only, never the reader's box): what to do about each reason. */
const REASON_FIX: Record<string, string> = {
  'not-pinned': 'Pin this anchor (Sidestory: Pin Anchors) so it has a v2 quote.',
  unconfirmed: 'Confirm it in VS Code (the panel offers it), or commit the manifest.',
  ignored: 'The file is ignored by git.',
  'secret-file': 'Widgets never read files that look like they hold secrets.',
  lost: "The anchor's code can't be found.",
  'changed-untracked': 'The code changed and the file is not tracked by git: pin again.',
  'changed-since-commit': 'The code changed since the quote was committed: pin again.',
  'too-large': 'The anchor is longer than 2,000 lines.',
  'not-requested': "The widget doesn't name this anchor in a direct useAnchorCode('id') call.",
};
