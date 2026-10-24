// Just enough of the VS Code API to run an ExplainerSession in Node: files come from disk, events are
// fired by the test, and every listener and watcher is counted so tests can tell what was left behind.
import { readdir, readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';

export const counts = { joinPath: 0, watchers: 0, reads: 0, readPaths: [] as string[] };

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
  with(change: { scheme?: string; path?: string }): Uri {
    return new Uri(change.scheme ?? this.scheme, change.path ?? this.path);
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
  documentClosed: new EventEmitter<unknown>(),
  documentSaved: new EventEmitter<unknown>(),
  filesDeleted: new EventEmitter<{ files: Uri[] }>(),
  foldersChanged: new EventEmitter<unknown>(),
  windowState: new EventEmitter<{ focused: boolean }>(),
  activeEditorChanged: new EventEmitter<unknown>(),
};

export class Position {
  readonly line: number;
  readonly character: number;
  constructor(line: number, character: number) {
    this.line = line;
    this.character = character;
  }
  compareTo(o: Position): number {
    return this.line - o.line || this.character - o.character;
  }
}

export class Range {
  readonly start: Position;
  readonly end: Position;
  constructor(sl: number | Position, sc: number | Position, el?: number, ec?: number) {
    if (sl instanceof Position && sc instanceof Position) {
      this.start = sl;
      this.end = sc;
    } else {
      this.start = new Position(sl as number, sc as number);
      this.end = new Position(el!, ec!);
    }
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
/** CodeLens providers registered, in order. */
export const codeLensProviders: unknown[] = [];
export const languages = {
  registerCodeLensProvider: (_selector: unknown, provider: unknown) => {
    codeLensProviders.push(provider);
    return { dispose: () => void codeLensProviders.splice(codeLensProviders.indexOf(provider), 1) };
  },
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
/** Every non-modal information message, with its buttons. */
export const info: { message: string; buttons: string[] }[] = [];
export const modal = { answer: undefined as string | undefined, asked: [] as string[], details: [] as string[], buttons: [] as string[][] };

/** Settings by full key (`sidestory.codeLens.enabled`, `files.exclude`), set by the test. */
export const config: Record<string, unknown> = {};
/** Every findFiles call: [include, exclude, max]. */
export const findFilesCalls: [unknown, unknown, unknown][] = [];

async function walkManifests(dir: string, out: Uri[]): Promise<void> {
  let names: import('node:fs').Dirent[];
  try {
    names = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of names) {
    const p = `${dir}/${d.name}`;
    if (d.isDirectory()) {
      if (d.name === 'node_modules' || d.name === '.git') continue;
      await walkManifests(p, out);
    } else if (d.name === 'manifest.json' && dir.split('/').at(-2) === '.sidestory') out.push(Uri.file(p));
  }
}

/** A TextDocument over a string. */
export function fakeDocument(uri: Uri, text: string, version = 1) {
  const lines = text.split(/\r\n|\r|\n/);
  const ext = uri.path.split('.').pop() ?? '';
  return {
    uri,
    version,
    isClosed: false,
    languageId: ext === 'sv' || ext === 'svh' ? 'systemverilog' : ext === 'v' ? 'verilog' : ext === 'ts' ? 'typescript' : 'plaintext',
    lineCount: lines.length,
    getText: () => text,
    lineAt: (n: number) => ({ text: lines[n] ?? '' }),
  };
}

/** Editors the extension showed (showTextDocument), in order. */
export const shown: { document: { uri: Uri }; options: Record<string, unknown> }[] = [];
/** Status bar messages, in order. */
export const statusMessages: string[] = [];

export const workspace = {
  /** The folder workspace URIs resolve against; set by the test. */
  root: undefined as Uri | undefined,
  /** Several workspace folders (multi-root); when unset, `root` is the only one. */
  folders: undefined as { uri: Uri; name: string }[] | undefined,
  get workspaceFolders() {
    if (workspace.folders) return workspace.folders.map((f, index) => ({ ...f, index }));
    return workspace.root ? [{ uri: workspace.root, name: workspace.root.path.split('/').at(-1)!, index: 0 }] : undefined;
  },
  /** Replaces the disk walk behind findFiles. */
  findFilesImpl: undefined as ((include: unknown, exclude: unknown, max: unknown) => Promise<Uri[]> | Uri[]) | undefined,
  findFiles: async (include: unknown, exclude?: unknown, max?: unknown) => {
    findFilesCalls.push([include, exclude, max]);
    if (workspace.findFilesImpl) return workspace.findFilesImpl(include, exclude, max);
    const out: Uri[] = [];
    for (const f of workspace.workspaceFolders ?? []) await walkManifests(f.uri.fsPath, out);
    return typeof max === 'number' ? out.slice(0, max) : out;
  },
  onDidCloseTextDocument: events.documentClosed.event,
  onDidSaveTextDocument: events.documentSaved.event,
  onDidDeleteFiles: events.filesDeleted.event,
  onDidChangeWorkspaceFolders: events.foldersChanged.event,
  isTrusted: true,
  onDidChangeConfiguration: events.configurationChanged.event,
  onDidGrantWorkspaceTrust: events.trustGranted.event,
  asRelativePath: (u: Uri) => (workspace.root && u.path.startsWith(`${workspace.root.path}/`) ? u.path.slice(workspace.root.path.length + 1) : u.path),
  textDocuments: [] as unknown[],
  onDidChangeTextDocument: events.documentChanged.event,
  /** A document read from disk: enough of TextDocument for the code-link host (docs/AUTHORING-PLAN.md §8). */
  openTextDocument: async (uri: Uri) => {
    const text = await readFile(uri.fsPath, 'utf8');
    return fakeDocument(uri, text);
  },
  fs: {
    readFile: async (uri: Uri) => {
      counts.reads++;
      counts.readPaths.push(uri.path);
      return new Uint8Array(await readFile(uri.fsPath));
    },
    stat: async (uri: Uri) => {
      const s = await stat(uri.fsPath);
      return { mtime: Math.floor(s.mtimeMs), size: s.size, ctime: Math.floor(s.ctimeMs), type: s.isDirectory() ? 2 : 1 };
    },
  },
  getWorkspaceFolder: (uri: Uri) => {
    if (workspace.folders) {
      const f = workspace.folders.find((x) => uri.path === x.uri.path || uri.path.startsWith(`${x.uri.path}/`));
      return f ? { ...f, index: workspace.folders.indexOf(f) } : undefined;
    }
    return workspace.root && uri.path.startsWith(`${workspace.root.path}/`) ? { uri: workspace.root, name: workspace.root.path.split('/').at(-1)!, index: 0 } : undefined;
  },
  getConfiguration: (section?: string, _scope?: unknown) => ({
    get: <T>(key: string, fallback?: T) => {
      const k = section ? `${section}.${key}` : key;
      return (Object.hasOwn(config, k) ? config[k] : fallback) as T;
    },
    update: async (key: string, value: unknown) => {
      config[section ? `${section}.${key}` : key] = value;
    },
  }),
  createFileSystemWatcher: (pattern?: unknown) => {
    counts.watchers++;
    const changed = new EventEmitter<Uri>();
    const created = new EventEmitter<Uri>();
    const deleted = new EventEmitter<Uri>();
    let disposed = false;
    const w = {
      pattern,
      fireChange: (u: Uri) => changed.fire(u),
      fireCreate: (u: Uri) => created.fire(u),
      fireDelete: (u: Uri) => deleted.fire(u),
    };
    watchers.push(w);
    return {
      onDidChange: changed.event,
      onDidCreate: created.event,
      onDidDelete: deleted.event,
      dispose: () => {
        if (!disposed) {
          counts.watchers--;
          watchers.splice(watchers.indexOf(w), 1);
        }
        disposed = true;
      },
    };
  },
};

/** Live file watchers (the test fires their events). */
export const watchers: { pattern: unknown; fireChange(u: Uri): void; fireCreate(u: Uri): void; fireDelete(u: Uri): void }[] = [];

export const StatusBarAlignment = { Left: 1, Right: 2 };
export interface StubStatusItem {
  id: string;
  alignment: number;
  priority: number;
  name?: string;
  text: string;
  tooltip?: unknown;
  command?: unknown;
  shown: boolean;
  disposed: boolean;
  show(): void;
  hide(): void;
  dispose(): void;
}
export const statusItems: StubStatusItem[] = [];

/** A quick pick the test drives: it records items, and `accept(item)` picks one. */
export interface StubQuickPick {
  items: { label: string; description?: string; detail?: string; kind?: number; [k: string]: unknown }[];
  activeItems: unknown[];
  selectedItems: unknown[];
  placeholder?: string;
  title?: string;
  busy: boolean;
  buttons: unknown[];
  matchOnDescription: boolean;
  matchOnDetail: boolean;
  shown: boolean;
  accept(item: unknown): void;
  triggerButton(b?: unknown): void;
  hide(): void;
}
export const quickPicks: StubQuickPick[] = [];

export const window = {
  onDidChangeWindowState: events.windowState.event,
  onDidChangeActiveTextEditor: events.activeEditorChanged.event,
  activeTextEditor: undefined as unknown,
  registerWebviewPanelSerializer: () => ({ dispose() {} }),
  withProgress: (_options: unknown, task: () => unknown) => task(),
  createStatusBarItem: (id: string, alignment: number, priority: number) => {
    const item: StubStatusItem = {
      id,
      alignment,
      priority,
      text: '',
      shown: false,
      disposed: false,
      show() {
        item.shown = true;
      },
      hide() {
        item.shown = false;
      },
      dispose() {
        item.disposed = true;
        item.shown = false;
      },
    };
    statusItems.push(item);
    return item;
  },
  createQuickPick: () => {
    const accept = new EventEmitter<void>();
    const hide = new EventEmitter<void>();
    const button = new EventEmitter<unknown>();
    const qp = {
      items: [],
      activeItems: [],
      selectedItems: [],
      busy: false,
      buttons: [],
      matchOnDescription: false,
      matchOnDetail: false,
      shown: false,
      onDidAccept: accept.event,
      onDidHide: hide.event,
      onDidTriggerButton: button.event,
      show() {
        qp.shown = true;
      },
      hide() {
        if (qp.shown) {
          qp.shown = false;
          hide.fire();
        }
      },
      dispose() {
        qp.shown = false;
      },
      accept(item: unknown) {
        qp.selectedItems = [item];
        accept.fire();
      },
      triggerButton(b?: unknown) {
        button.fire(b ?? qp.buttons[0]);
      },
    } as StubQuickPick & Record<string, unknown>;
    quickPicks.push(qp);
    return qp;
  },
  onDidChangeTextEditorSelection: events.selectionChanged.event,
  onDidChangeVisibleTextEditors: events.visibleEditorsChanged.event,
  visibleTextEditors: [] as unknown[],
  tabGroups: { all: [] as unknown[] },
  activeColorTheme: { kind: ColorThemeKind.Dark },
  createOutputChannel: () => ({ info() {}, warn() {}, error() {}, dispose() {} }),
  showInformationMessage: async (message: string, ...buttons: unknown[]) => {
    info.push({ message, buttons: buttons.filter((b): b is string => typeof b === 'string') });
    return undefined;
  },
  showWarningMessage: async (message: string, ...rest: unknown[]) => {
    const opts = rest[0] as { modal?: boolean; detail?: string } | undefined;
    if (!opts?.modal) return undefined;
    modal.asked.push(message);
    modal.details.push(opts.detail ?? '');
    modal.buttons.push(rest.slice(1) as string[]);
    return modal.answer;
  },
  showErrorMessage: async () => undefined,
  setStatusBarMessage: (text: string) => {
    statusMessages.push(text);
    return { dispose() {} };
  },
  showTextDocument: async (document: { uri: Uri }, options: Record<string, unknown> = {}) => {
    shown.push({ document, options });
    return { document, selection: options.selection, revealRange() {}, setDecorations() {} };
  },
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

/** Every executeCommand call. */
export const executed: unknown[][] = [];
export const commands = {
  executeCommand: async (...args: unknown[]) => {
    executed.push(args);
    return undefined;
  },
  registerCommand: () => ({ dispose() {} }),
};
export class CodeLens {
  readonly range: Range;
  readonly command?: { title: string; command: string; arguments?: unknown[] };
  constructor(range: Range, command?: { title: string; command: string; arguments?: unknown[] }) {
    this.range = range;
    this.command = command;
  }
}
export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class TreeItem {
  label: unknown;
  collapsibleState: number;
  id?: string;
  description?: string;
  tooltip?: unknown;
  iconPath?: unknown;
  contextValue?: string;
  command?: unknown;
  resourceUri?: unknown;
  constructor(label: unknown, state = 0) {
    this.label = label;
    this.collapsibleState = state;
  }
}
export class ThemeIcon {
  readonly id: string;
  readonly color?: unknown;
  constructor(id: string, color?: unknown) {
    this.id = id;
    this.color = color;
  }
}
export const QuickPickItemKind = { Separator: -1, Default: 0 };
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export class Disposable {
  private readonly fn: () => void;
  constructor(fn: () => void) {
    this.fn = fn;
  }
  dispose(): void {
    this.fn();
  }
}
export const env = { openExternal: async () => true };
