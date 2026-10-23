// Syntax highlighting for explainer code blocks, VS Code side (docs/HIGHLIGHT-PLAN.md §3): works out the active
// color theme, loads it, follows changes, and owns the shared Highlighter.
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import * as vscode from 'vscode';
import { log } from '../log.ts';
import { realPathInside } from '../paths.ts';
import { Highlighter } from './host.ts';
import {
  candidateThemes, customizationRules, findContribution, type HighlightTheme, loadThemeChain, MAX_THEME_FILE, normalizeTheme,
  type ThemeContribution, type ThemeKind, type ThemeReader,
} from './theme.ts';

const KINDS: Record<number, ThemeKind> = {
  [vscode.ColorThemeKind.Light]: 'light',
  [vscode.ColorThemeKind.Dark]: 'dark',
  [vscode.ColorThemeKind.HighContrast]: 'hc-dark',
  [vscode.ColorThemeKind.HighContrastLight]: 'hc-light',
};

/** The preferred-theme setting whose default names VS Code's own theme for a kind. */
const PREFERRED: Record<ThemeKind, string> = {
  dark: 'preferredDarkColorTheme',
  light: 'preferredLightColorTheme',
  'hc-dark': 'preferredHighContrastColorTheme',
  'hc-light': 'preferredHighContrastLightColorTheme',
};

const SETTINGS = ['workbench.colorTheme', 'workbench.preferredDarkColorTheme', 'workbench.preferredLightColorTheme', 'workbench.preferredHighContrastColorTheme', 'workbench.preferredHighContrastLightColorTheme', 'window.autoDetectColorScheme', 'window.autoDetectHighContrast', 'editor.tokenColorCustomizations'];

/** Reads theme files through VS Code's file system, real paths checked for local files. */
const reader: ThemeReader = {
  async read(uri) {
    try {
      const u = vscode.Uri.parse(uri, true);
      if (u.scheme === 'file') {
        if ((await stat(u.fsPath)).size > MAX_THEME_FILE) return undefined;
        return await readFile(u.fsPath, 'utf8');
      }
      const st = await vscode.workspace.fs.stat(u);
      if (st.size > MAX_THEME_FILE) return undefined;
      return new TextDecoder().decode(await vscode.workspace.fs.readFile(u));
    } catch {
      return undefined;
    }
  },
  async inside(uri, root) {
    const u = vscode.Uri.parse(uri, true);
    const r = vscode.Uri.parse(root, true);
    if (u.scheme !== 'file' || r.scheme !== 'file') {
      // No real paths to check: compare the decoded, normalized paths.
      const root = posix.normalize(`${r.path}/`);
      return u.scheme === r.scheme && u.authority === r.authority && posix.normalize(u.path).startsWith(root);
    }
    return (await realPathInside(u.fsPath, r.fsPath)) !== null;
  },
};

function contributions(): ThemeContribution[] {
  const out: ThemeContribution[] = [];
  for (const ext of vscode.extensions.all) {
    const themes = (ext.packageJSON as { contributes?: { themes?: unknown } } | undefined)?.contributes?.themes;
    if (!Array.isArray(themes)) continue;
    const root = ext.extensionUri.toString();
    for (const t of themes as { id?: unknown; label?: unknown; uiTheme?: unknown; path?: unknown }[]) {
      if (typeof t.path !== 'string') continue;
      const id = typeof t.id === 'string' ? t.id : typeof t.label === 'string' ? t.label : undefined;
      if (!id) continue;
      out.push({
        id,
        label: typeof t.label === 'string' ? t.label : undefined,
        uiTheme: typeof t.uiTheme === 'string' ? t.uiTheme : undefined,
        uri: vscode.Uri.joinPath(ext.extensionUri, t.path).toString(),
        root,
      });
    }
  }
  return out;
}

export class HighlightService implements vscode.Disposable {
  readonly highlighter: Highlighter;
  private readonly emitter = new vscode.EventEmitter<string>();
  /** Fires with the new theme key when the colors code blocks get changed. */
  readonly onDidChangeTheme = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private seq = 0;
  /** Undefined until a panel first asks: nothing is read for workspaces that never show a code block. */
  private ready: Promise<void> | undefined;
  private readonly fallbackDir: vscode.Uri;
  private readonly logged = new Set<string>();

  constructor(extensionUri: vscode.Uri) {
    this.fallbackDir = vscode.Uri.joinPath(extensionUri, 'dist', 'highlight', 'themes');
    this.highlighter = new Highlighter({ log: (m) => log.warn(m) });
    const changed = () => {
      if (this.ready) this.ready = this.refresh();
    };
    this.subscriptions.push(
      vscode.window.onDidChangeActiveColorTheme(changed),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (SETTINGS.some((s) => e.affectsConfiguration(s))) changed();
      }),
      vscode.extensions.onDidChange(changed),
    );
  }

  /** Resolves once the theme is known (the first time, and after a change). */
  whenReady(): Promise<void> {
    return (this.ready ??= this.refresh());
  }

  private logOnce(m: string): void {
    if (this.logged.has(m) || this.logged.size > 50) return;
    this.logged.add(m);
    log.info(m);
  }

  private async refresh(): Promise<void> {
    const seq = ++this.seq;
    let theme: HighlightTheme | undefined;
    try {
      theme = await this.resolve();
    } catch (e) {
      this.logOnce(`Code block colors: ${(e as Error).message}`);
    }
    if (seq !== this.seq || !theme) return;
    const before = this.highlighter.themeKey;
    this.highlighter.setTheme(theme);
    if (before !== undefined && before !== theme.key) this.emitter.fire(theme.key);
  }

  private async resolve(): Promise<HighlightTheme | undefined> {
    const kind = KINDS[vscode.window.activeColorTheme.kind] ?? 'dark';
    const wb = vscode.workspace.getConfiguration('workbench');
    const win = vscode.workspace.getConfiguration('window');
    const kindDefault = wb.inspect<string>(PREFERRED[kind])?.defaultValue ?? '';
    const names = candidateThemes(kind, {
      colorTheme: wb.get('colorTheme'),
      preferredDark: wb.get('preferredDarkColorTheme'),
      preferredLight: wb.get('preferredLightColorTheme'),
      preferredHighContrast: wb.get('preferredHighContrastColorTheme'),
      preferredHighContrastLight: wb.get('preferredHighContrastLightColorTheme'),
      autoDetectColorScheme: win.get('autoDetectColorScheme'),
      autoDetectHighContrast: win.get('autoDetectHighContrast'),
      kindDefault,
    });
    const custom = vscode.workspace.getConfiguration('editor').get<unknown>('tokenColorCustomizations');
    const all = contributions();
    for (const name of names) {
      const c = findContribution(name, kind, all);
      if (!c) continue;
      const raw = await loadThemeChain(c.uri, c.root, reader);
      if (raw) return normalizeTheme(raw, kind, c.id, customizationRules(custom, c.id));
      this.logOnce(`Code block colors: couldn't read the color theme "${name}"; using another.`);
    }
    // VS Code's default theme for this kind, bundled with us (in remote windows the active theme is often local-only).
    const file = vscode.Uri.joinPath(this.fallbackDir, `${kind}.json`).toString();
    const raw = await loadThemeChain(file, this.fallbackDir.toString(), reader);
    if (!raw) throw new Error('the bundled fallback theme is missing');
    this.logOnce(`Code block colors: the color theme ${names[0] ? `"${names[0]}" ` : ''}isn't readable here; using VS Code's default ${kind} theme.`);
    return normalizeTheme(raw, kind, kindDefault || kind, customizationRules(custom, kindDefault));
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
    this.emitter.dispose();
    this.highlighter.dispose();
  }
}
