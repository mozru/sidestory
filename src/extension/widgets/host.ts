// Widgets, extension side (docs/WIDGETS-PLAN.md §3–§5): whether a panel may run its explainer's widgets
// (trust, the `codeExplainer.widgets.enabled` setting, the reader's consent in a native modal), compiled code
// and library texts for the panel, what widgets may read (`useAnchorCode`), highlights and reveals, the
// watchdogs, and diagnostics for authors. Everything a panel asks for is checked here again: the panel
// renders untrusted content, so its requests are only requests.
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { basename } from 'node:path';
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
import { decideCodeAccess, languageOf, type GitFacts } from './code-access.ts';
import { compileWidget, type CompileResult } from './compile.ts';
import { acknowledge, contentHash, decideConsent, EMPTY_CONSENT, type ConsentRecord, type FileGit, type WidgetFile } from './consent.ts';
import { Git } from './git.ts';
import { anchorsRead, scanWidgets, widgetSources } from './html.ts';
import { isSecretPath } from './secret-files.ts';
import { Escalations, HeartbeatWatchdog, TICK_MS } from './watchdog.ts';

const CONSENT_KEY = 'codeExplainer.widgetConsent';
const CONFIRMED_KEY = 'codeExplainer.widgetQuotesConfirmed';
const DISABLED_KEY = 'codeExplainer.widgetsDisabled';
const MAX_CONFIRMED = 2000;
const MAX_HEIGHTS = 200;
const MAX_FILE_BYTES = 5_000_000;
const CODE_DELAY = 200;
const MAX_LOGS_PER_MINUTE = 100;
const REMOUNT_DELAY = 1000;

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
}

const quoteKey = (file: string, quote: Quote, range: LineRange) => `${file}\n${createHash('sha256').update(quote.exact).digest('hex')}\n${range.start}-${range.end}`;
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

function toBuild(r: CompileResult): WidgetBuild {
  return { entry: r.entry, modules: r.modules, libraries: r.libraries, icons: r.icons, errors: r.errors.map((e) => ({ file: e.file, line: e.line, message: e.message })), hash: r.hash };
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
  private readonly diagnostics = vscode.languages.createDiagnosticCollection('code-explainer-widgets');
  private readonly diagnosed = new Map<string, vscode.Uri[]>();
  private readonly checkTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly subscriptions: vscode.Disposable[] = [];
  private tickTimer: ReturnType<typeof setInterval> | undefined;
  /** Recreates a panel in the same column at the same place (watchdog recovery); set by the extension. */
  recreate: (port: WidgetSessionPort) => void = () => {};

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    // Widget files are observed in every explainer, not only while a panel is open, so edits are recorded
    // as the user's own (and diagnostics stay current).
    const watcher = vscode.workspace.createFileSystemWatcher('**/.explain/*/**');
    const changed = (uri: vscode.Uri) => this.onWorkspaceFile(uri);
    this.subscriptions.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('codeExplainer.widgets.enabled')) this.refreshAll();
      }),
      // Widgets mount when trust is granted, without reopening the panel.
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.refreshAll()),
      this.diagnostics,
    );
  }

  enabled(): boolean {
    return vscode.workspace.getConfiguration('codeExplainer').get<boolean>('widgets.enabled', true);
  }

  attach(port: WidgetSessionPort): PanelWidgets {
    const p = new PanelWidgets(this, port);
    this.panels.add(p);
    this.tickTimer ??= setInterval(() => {
      const at = Date.now();
      for (const x of this.panels) if (x.watchdog.tick(at) === 'trip') void this.trip(x);
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
    for (const s of srcs) map[`${ref.dir.toString()}\n${s.src}`] = s.hash;
    await this.context.workspaceState.update(DISABLED_KEY, map);
  }

  async enableAll(): Promise<void> {
    await this.context.workspaceState.update(DISABLED_KEY, undefined);
    this.refreshAll();
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
      p = compileWidget(ref.dir.fsPath, src);
      this.compiles.set(key, p);
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

  async fileGit(uri: vscode.Uri): Promise<FileGit> {
    const l = await this.git.lookup(uri);
    if (l.kind !== 'repo') return l;
    const text = await this.git.headText(l.repo, uri);
    return { kind: 'repo', head: this.git.head(l.repo), headHash: text === null ? null : contentHash(text) };
  }

  /** The files of these widgets' import closures, hashed from their bytes now, with git's view of each. */
  async widgetFiles(ref: ExplainerRef, results: readonly CompileResult[]): Promise<WidgetFile[]> {
    const paths = [...new Set(results.flatMap((r) => r.files))];
    const out: WidgetFile[] = [];
    for (const rel of paths) {
      const uri = vscode.Uri.joinPath(ref.dir, rel);
      const bytes = await readBytesInside(uri, ref.dir, MAX_FILE_BYTES);
      out.push({ path: uri.toString(), hash: bytes ? contentHash(bytes) : 'missing', git: await this.fileGit(uri) });
    }
    return out;
  }

  /** The workspace watcher: record edits as the user's own (unless they arrived through git), re-check diagnostics. */
  private onWorkspaceFile(uri: vscode.Uri): void {
    const m = /^(.*\/\.explain\/[^/]+)(\/.*)$/.exec(uri.path);
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
    if (!vscode.workspace.isTrusted || !this.consent().granted || /\/(manifest\.json|explainer\.html)$/.test(uri.path)) return;
    void (async () => {
      const bytes = await readBytesInside(uri, ref.dir, MAX_FILE_BYTES);
      if (!bytes) return;
      const file: WidgetFile = { path: uri.toString(), hash: contentHash(bytes), git: await this.fileGit(uri) };
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
      d.source = 'Code Explainer';
      add(htmlUri(ref), d);
    }
    for (const r of results) {
      for (const [list, severity] of [[r.errors, vscode.DiagnosticSeverity.Error], [r.warnings, vscode.DiagnosticSeverity.Warning]] as const) {
        for (const e of list) {
          const line = Math.max(0, (e.line ?? 1) - 1);
          const col = Math.max(0, (e.column ?? 1) - 1);
          const d = new vscode.Diagnostic(new vscode.Range(line, col, line, col + 1000), e.message, severity);
          d.source = 'Code Explainer';
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
    let git: GitFacts = { kind: 'none' };
    const l = await this.git.lookup(uri);
    if (l.kind === 'unknown') git = { kind: 'unknown' };
    else if (l.kind === 'repo') {
      git = { kind: 'repo', tracked: await this.git.tracked(l.repo, uri), ignored: await this.git.ignored(l.repo, uri), headText: await this.git.headText(l.repo, uri) };
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
    const byFile = new Map<string, string[]>();
    for (const e of entries) byFile.set(e.file, [...(byFile.get(e.file) ?? []), `lines ${e.range.start}–${e.range.end} (${e.id})`]);
    const lines = [...byFile].map(([f, r]) => `${f}: ${r.join(', ')}`);
    const ok = 'Let Widgets Read';
    const choice = await vscode.window.showWarningMessage(
      `Let the widgets in “${title}” read this code?`,
      { modal: true, detail: `${lines.join('\n')}\n\nWidgets would see these lines as they are in the editor, including unsaved edits.` },
      ok,
    );
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
    };
  }

  // ---- watchdogs (docs/WIDGETS-PLAN.md §4) ----

  private notifyDisabled(port: WidgetSessionPort, what: string): void {
    const enable = 'Enable Widgets';
    void vscode.window.showWarningMessage(`${what} in “${port.title() || port.ref().name}” stopped responding, so ${what === 'A widget' ? 'it is' : 'they are'} turned off until the code changes.`, enable).then((c) => {
      if (c === enable) void vscode.commands.executeCommand('codeExplainer.enableWidgets');
    });
  }

  /** Disables the suspect (first trip) or all of an explainer's widgets (second within 5 minutes); `false` past that. */
  private async escalate(p: PanelWidgets, suspect: string | undefined): Promise<boolean> {
    const ref = p.port.ref();
    const step = this.escalations.record(ref.dir.toString(), Date.now());
    if (step === 'stop') {
      log.error(`${ref.name}: widgets keep freezing the panel; the watchdog stopped acting. Close the panel, or run "Code Explainer: Revoke Widget Consent".`);
      void vscode.window.showErrorMessage(`Widgets in “${p.port.title() || ref.name}” keep freezing the panel. Close it, or revoke widget consent.`);
      return false;
    }
    const srcs = step === 'suspect' && suspect ? [suspect] : p.sources();
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
  async unresponsive(p: PanelWidgets, crumbs: { mounted: string[]; mounting: string | null; recent: string | null }): Promise<void> {
    for (const x of this.panels) x.port.post({ type: 'widgetsReset', phase: 'unmount' });
    const suspect = crumbs.mounting ?? crumbs.recent ?? crumbs.mounted.at(-1);
    log.warn(`${p.port.ref().name}: widgets stopped responding (mounted: ${crumbs.mounted.join(', ') || 'none'}; mounting: ${crumbs.mounting ?? 'none'}).`);
    await this.escalate(p, suspect);
    setTimeout(() => {
      for (const x of this.panels) {
        void x.refreshGate();
        x.port.post({ type: 'widgetsReset', phase: 'remount' });
      }
    }, REMOUNT_DELAY);
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
      void vscode.window.showErrorMessage(`The explainer panel “${p.port.title() || ref.name}” is still not responding. Close it to recover.`);
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
    for (const t of this.checkTimers.values()) clearTimeout(t);
    for (const d of this.subscriptions) d.dispose();
  }
}

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
  private gateSeq = 0;
  /** What the panel was sent, by src (hash), so live edits push new builds. */
  private readonly served = new Map<string, string>();
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

  /** After `init` (a new or rebuilt page): it needs the gate again. */
  onInit(): void {
    this.served.clear();
    this.codeAnchors.clear();
    if (this.gate) this.port.post({ type: 'widgets', gate: this.gate });
    void this.refreshGate();
  }

  /** The HTML changed, or something the gate depends on did. */
  async refreshGate(): Promise<void> {
    if (this.disposed) return;
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
      const files = await this.host.widgetFiles(ref, results);
      if (stale()) return;
      const record = this.host.consent();
      const d = decideConsent(record, files);
      if (record.granted && d.observed.length) await this.host.acknowledge(d.observed, false);
      this.changed = record.granted ? d.changed : [];
      status = d.ask ? 'ask' : 'on';
    }
    const disabled = this.srcs.filter((s) => this.host.isDisabled(ref, s, this.results.get(s)?.hash));
    let unconfirmed: WidgetGate['unconfirmed'] = null;
    if (status === 'on' && results.length) {
      const list = await this.host.unconfirmed(this.port, results);
      if (stale()) return;
      if (list.length) {
        const byFile = new Map<string, number>();
        for (const a of list) byFile.set(a.file, (byFile.get(a.file) ?? 0) + a.range.end - a.range.start + 1);
        unconfirmed = { anchors: list.length, summary: [...byFile].map(([f, n]) => `${f}, ${plural(n, 'line')}`).join('; ').slice(0, 200) };
      }
    }
    const gate: WidgetGate = { status, unconfirmed, disabled, heights: this.host.heightsFor(ref) };
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
    if (![...this.codeAnchors].some((id) => { const a = m.anchors.get(id); return a && vscode.Uri.joinPath(ref.root, a.file).toString() === fileUri; })) return;
    clearTimeout(this.codeTimer);
    this.codeTimer = setTimeout(() => {
      for (const id of this.codeAnchors) void this.sendCode(id);
    }, CODE_DELAY);
  }

  /** Allowed to run widgets now (checked on every request, not only when the gate was computed). */
  private allowed(): boolean {
    return this.gate?.status === 'on' && this.host.enabled() && vscode.workspace.isTrusted;
  }

  private async sendCode(id: string): Promise<void> {
    const generation = this.port.generation();
    const code = await this.host.codeFor(this.port, id);
    if (this.disposed || generation !== this.port.generation() || !this.allowed()) return;
    if (code.status === 'unavailable' && !this.loggedReasons.has(`${id}:${code.reason}`)) {
      this.loggedReasons.add(`${id}:${code.reason}`);
      log.info(`${this.port.ref().name}: useAnchorCode('${id}') is unavailable to widgets: ${code.reason}. ${REASON_FIX[code.reason!] ?? ''}`);
    }
    this.port.post({ type: 'widgetCode', code });
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
      case 'widgetCompile': {
        const r = this.results.get(m.src);
        const ok = this.allowed() && r && !this.gate!.disabled.includes(m.src);
        if (ok) this.served.set(m.src, r.hash);
        this.port.post({ type: 'widget', src: m.src, build: ok ? toBuild(r) : null });
        return true;
      }
      case 'widgetLibs':
        if (!this.allowed()) return true;
        void Promise.all(m.ids.map(async (id) => [id, await this.host.library(id)] as const)).then((entries) => {
          if (!this.allowed()) return;
          this.port.post({ type: 'widgetLibs', libs: Object.fromEntries(entries.filter((e): e is [string, string] => e[1] !== undefined)) });
        });
        return true;
      case 'widgetCode':
        if (!this.allowed() || !this.port.manifest()?.anchors.has(m.anchor)) return true;
        this.codeAnchors.add(m.anchor);
        void this.sendCode(m.anchor);
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
      case 'heartbeat':
        if (this.watchdog.beat({ delay: m.delay, visible: m.visible, mounted: m.mounted, mounting: m.mounting, recent: m.recent }, Date.now()) === 'trip') void this.host.trip(this);
        return true;
      case 'widgetsUnresponsive':
        if (!this.stopped) void this.host.unresponsive(this, m);
        return true;
      case 'focusAnswer':
      case 'focusTheft':
        if (m.type === 'focusTheft' || !m.legit) void vscode.commands.executeCommand('workbench.action.focusActiveEditorGroup');
        return true;
      default:
        return false;
    }
  }

  private async askConsent(): Promise<void> {
    if (this.asking || this.gate?.status !== 'ask') return;
    this.asking = true;
    try {
      const ref = this.port.ref();
      const generation = this.port.generation();
      const results = [...this.results.values()];
      const files = await this.host.widgetFiles(ref, results);
      const changed = this.changed.map((u) => vscode.workspace.asRelativePath(vscode.Uri.parse(u)));
      const run = 'Run Widgets';
      const detail = [
        `Explainer: ${this.port.title() || ref.name} (${plural(this.srcs.length, 'widget')}: ${this.srcs.join(', ')})`,
        changed.length ? `Changed since you last agreed (arrived through git): ${changed.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      const choice = await vscode.window.showWarningMessage(
        'Widgets are code from this repository. They can read the code this explainer points at (including unsaved edits) and may be able to reach the network. Run widgets in this workspace?',
        { modal: true, detail },
        run,
      );
      if (choice !== run || generation !== this.port.generation()) return;
      await this.host.acknowledge(files, true);
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
    for (const id of this.codeAnchors) void this.sendCode(id);
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
  'not-pinned': 'Pin this anchor (Code Explainer: Pin Anchors) so it has a v2 quote.',
  unconfirmed: 'Confirm it in VS Code (the panel offers it), or commit the manifest.',
  ignored: 'The file is ignored by git.',
  'secret-file': 'Widgets never read files that look like they hold secrets.',
  lost: "The anchor's code can't be found.",
  'changed-untracked': 'The code changed and the file is not tracked by git: pin again.',
  'changed-since-commit': 'The code changed since the quote was committed: pin again.',
  'too-large': 'The anchor is longer than 2,000 lines.',
};
