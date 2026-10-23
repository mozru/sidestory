// Just enough of the VS Code API to run an ExplainerSession in Node: files come from disk, events are
// fired by the test, and every listener and watcher is counted so tests can tell what was left behind.
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

export const counts = { joinPath: 0, watchers: 0 };

/** VS Code's file URIs on Windows: forward slashes, a leading slash before the drive, which toString and fsPath lowercase. */
const win = process.platform === 'win32';
const drive = /^\/[A-Za-z]:/;

export class Uri {
  readonly scheme: string;
  readonly path: string;
  constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }
  static file(path: string): Uri {
    if (win) {
      path = path.replace(/\\/g, '/');
      if (/^[A-Za-z]:/.test(path)) path = `/${path}`;
    }
    return new Uri('file', path);
  }
  static parse(value: string): Uri {
    const u = new URL(value);
    return new Uri(u.protocol.slice(0, -1), decodeURIComponent(u.pathname));
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    counts.joinPath++;
    return new Uri(base.scheme, posix.join(base.path, ...parts));
  }
  get fsPath(): string {
    if (!win) return this.path;
    const p = drive.test(this.path) ? this.path[1]!.toLowerCase() + this.path.slice(2) : this.path;
    return p.replace(/\//g, '\\');
  }
  toString(): string {
    if (win && drive.test(this.path)) return `${this.scheme}:///${this.path[1]!.toLowerCase()}%3A${this.path.slice(3).split('/').map(encodeURIComponent).join('/')}`;
    return `${this.scheme}://${this.path}`;
  }
}

type Listener<T> = (e: T) => unknown;

export class EventEmitter<T> {
  readonly listeners = new Set<Listener<T>>();
  readonly event = (fn: Listener<T>) => {
    this.listeners.add(fn);
    return { dispose: () => this.listeners.delete(fn) };
  };
  fire(e: T): void {
    for (const l of [...this.listeners]) l(e);
  }
  dispose(): void {
    this.listeners.clear();
  }
}

export class RelativePattern {
  readonly base: Uri;
  readonly pattern: string;
  constructor(base: Uri, pattern: string) {
    this.base = base;
    this.pattern = pattern;
  }
}

export class TabInputText {}
export class TabInputWebview {}
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const ColorThemeKind = { Light: 1, Dark: 2, HighContrast: 3, HighContrastLight: 4 };
export const TextEditorSelectionChangeKind = { Keyboard: 1, Mouse: 2, Command: 3 };
export const TextEditorRevealType = { Default: 0, InCenterIfOutsideViewport: 2 };

/** Events the test fires, as VS Code would. */
export const events = {
  documentChanged: new EventEmitter<unknown>(),
  selectionChanged: new EventEmitter<unknown>(),
  visibleEditorsChanged: new EventEmitter<unknown>(),
  configurationChanged: new EventEmitter<unknown>(),
  trustGranted: new EventEmitter<void>(),
};

export class Range {
  readonly start: { line: number; character: number };
  readonly end: { line: number; character: number };
  constructor(sl: number, sc: number, el: number, ec: number) {
    this.start = { line: sl, character: sc };
    this.end = { line: el, character: ec };
  }
  isEqual(o: Range): boolean {
    return this.start.line === o.start.line && this.start.character === o.start.character && this.end.line === o.end.line && this.end.character === o.end.character;
  }
}
export const DiagnosticSeverity = { Error: 0, Warning: 1 };
export class Diagnostic {
  readonly range: Range;
  readonly message: string;
  readonly severity: number;
  source?: string;
  code?: string;
  constructor(range: Range, message: string, severity: number) {
    this.range = range;
    this.message = message;
    this.severity = severity;
  }
}
/** Diagnostics published, by URI string. */
export const diagnostics = new Map<string, Diagnostic[]>();
export const languages = {
  createDiagnosticCollection: () => ({
    set: (uri: Uri, list: Diagnostic[]) => diagnostics.set(uri.toString(), list),
    delete: (uri: Uri) => diagnostics.delete(uri.toString()),
    dispose() {},
  }),
};
/** The built-in git extension's API (version 1), when a test sets one. */
export const extensions = {
  git: undefined as unknown,
  getExtension: (id: string) => (id === 'vscode.git' && extensions.git ? { isActive: true, exports: { getAPI: () => extensions.git } } : undefined),
};
/** What modal questions answer (the button to "click"), set by the test; and the questions asked. */
export const modal = { answer: undefined as string | undefined, asked: [] as string[], details: [] as string[], buttons: [] as string[][] };

export const workspace = {
  /** The folder workspace URIs resolve against; set by the test. */
  root: undefined as Uri | undefined,
  isTrusted: true,
  onDidChangeConfiguration: events.configurationChanged.event,
  onDidGrantWorkspaceTrust: events.trustGranted.event,
  asRelativePath: (u: Uri) => (workspace.root && u.path.startsWith(`${workspace.root.path}/`) ? u.path.slice(workspace.root.path.length + 1) : u.path),
  textDocuments: [] as unknown[],
  onDidChangeTextDocument: events.documentChanged.event,
  fs: { readFile: async (uri: Uri) => new Uint8Array(await readFile(uri.fsPath)) },
  getWorkspaceFolder: (uri: Uri) => (workspace.root && uri.path.startsWith(`${workspace.root.path}/`) ? { uri: workspace.root } : undefined),
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
  createFileSystemWatcher: (_pattern?: unknown) => {
    counts.watchers++;
    const e = new EventEmitter<Uri>();
    let disposed = false;
    return {
      onDidChange: e.event,
      onDidCreate: e.event,
      onDidDelete: e.event,
      dispose: () => {
        if (!disposed) counts.watchers--;
        disposed = true;
      },
    };
  },
};

export const window = {
  onDidChangeTextEditorSelection: events.selectionChanged.event,
  onDidChangeVisibleTextEditors: events.visibleEditorsChanged.event,
  visibleTextEditors: [] as unknown[],
  tabGroups: { all: [] as unknown[] },
  activeColorTheme: { kind: ColorThemeKind.Dark },
  createOutputChannel: () => ({ info() {}, warn() {}, error() {}, dispose() {} }),
  showInformationMessage: async () => undefined,
  showWarningMessage: async (message: string, ...rest: unknown[]) => {
    const opts = rest[0] as { modal?: boolean; detail?: string } | undefined;
    if (!opts?.modal) return undefined;
    modal.asked.push(message);
    modal.details.push(opts.detail ?? '');
    modal.buttons.push(rest.slice(1) as string[]);
    return modal.answer;
  },
  showErrorMessage: async () => undefined,
  setStatusBarMessage: () => ({ dispose() {} }),
};

export class ThemeColor {
  readonly id: string;
  constructor(id: string) {
    this.id = id;
  }
}
export const OverviewRulerLane = { Left: 1, Center: 2, Right: 4, Full: 7 };
/** Options of every decoration type created, in order. */
export const decorationTypes: Record<string, unknown>[] = [];
(window as Record<string, unknown>).createTextEditorDecorationType = (options: Record<string, unknown>) => {
  decorationTypes.push(options);
  return { dispose() {} };
};

export const commands = { executeCommand: async () => undefined };
export const env = { openExternal: async () => true };
