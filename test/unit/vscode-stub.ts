// Just enough of the VS Code API to run an ExplainerSession in Node: files come from disk, events are
// fired by the test, and every listener and watcher is counted so tests can tell what was left behind.
import { readFile } from 'node:fs/promises';
import { posix } from 'node:path';

export const counts = { joinPath: 0, watchers: 0 };

export class Uri {
  readonly scheme: string;
  readonly path: string;
  constructor(scheme: string, path: string) {
    this.scheme = scheme;
    this.path = path;
  }
  static file(path: string): Uri {
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
    return this.path;
  }
  toString(): string {
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
export const TextEditorRevealType = { InCenterIfOutsideViewport: 2 };

/** Events the test fires, as VS Code would. */
export const events = {
  documentChanged: new EventEmitter<unknown>(),
  selectionChanged: new EventEmitter<unknown>(),
  visibleEditorsChanged: new EventEmitter<unknown>(),
};

export const workspace = {
  /** The folder workspace URIs resolve against; set by the test. */
  root: undefined as Uri | undefined,
  textDocuments: [] as unknown[],
  onDidChangeTextDocument: events.documentChanged.event,
  fs: { readFile: async (uri: Uri) => new Uint8Array(await readFile(uri.fsPath)) },
  getWorkspaceFolder: (uri: Uri) => (workspace.root && uri.path.startsWith(`${workspace.root.path}/`) ? { uri: workspace.root } : undefined),
  getConfiguration: () => ({ get: <T>(_key: string, fallback: T) => fallback }),
  createFileSystemWatcher: () => {
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
  showWarningMessage: async () => undefined,
  showErrorMessage: async () => undefined,
  setStatusBarMessage: () => ({ dispose() {} }),
};

export const commands = { executeCommand: async () => undefined };
export const env = { openExternal: async () => true };
