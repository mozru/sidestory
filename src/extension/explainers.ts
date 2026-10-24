import * as vscode from 'vscode';
import { log } from './log.ts';
import { open as openFile, stat as statFile } from 'node:fs/promises';
import { assertSize, realPathInside } from './paths.ts';

/** One explainer folder: `<root>/.sidestory/<name>/`. */
export interface ExplainerRef {
  name: string;
  /** The folder holding the explainer's files. */
  dir: vscode.Uri;
  /** The folder that holds `.sidestory/`; anchor file paths are relative to it. */
  root: vscode.Uri;
}

export { MAX_MANIFEST_BYTES } from '../core/manifest.ts';
export const MAX_HTML_BYTES = 5_000_000;
export const MAX_CODE_BYTES = 10_000_000;

/**
 * Builds a ref for `<root>/.sidestory/<name>`, or undefined if the folder isn't laid out like that inside the workspace.
 * A root that itself lies inside a Sidestory folder below the workspace folder (`.sidestory/x/.sidestory/y`) is refused.
 */
export function refFromDir(dir: vscode.Uri): ExplainerRef | undefined {
  const parts = dir.path.split('/').filter(Boolean);
  const name = parts.at(-1);
  if (!name || parts.at(-2) !== '.sidestory') return undefined;
  const root = vscode.Uri.joinPath(dir, '..', '..');
  const folder = vscode.workspace.getWorkspaceFolder(dir);
  // Compared as the file system does: on Windows VS Code's own URIs disagree on the drive letter's case (a folder
  // opened from `D:\x` is `/D:/x`, while findFiles answers `/d:/x/...`, built from the lowercased fsPath).
  const fold = (p: string) => (caseInsensitive && dir.scheme === 'file' ? p.toLowerCase() : p);
  if (!folder || !fold(root.path + '/').startsWith(fold(folder.uri.path.replace(/\/?$/, '/')))) return undefined;
  // Only below the workspace folder: a workspace that itself sits under some `.sidestory` folder still works.
  const inside = parts.slice(folder.uri.path.split('/').filter(Boolean).length, -2);
  if (inside.includes('.sidestory')) return undefined;
  return { name, dir, root };
}

/**
 * `length` bytes at `offset` of a file under `root` (symlinks followed and checked, size capped), read with a
 * positioned read: the workspace index's quote slices (docs/NAVIGATION-PLAN.md §7.2). Undefined when the
 * file is missing, outside, too big, shorter than the slice, or not on the local file system.
 */
export async function readSliceInside(uri: vscode.Uri, root: vscode.Uri, offset: number, length: number, maxBytes: number): Promise<Uint8Array | undefined> {
  if (uri.scheme !== 'file' || root.scheme !== 'file' || offset < 0 || length <= 0 || offset + length > maxBytes) return undefined;
  const real = await realPathInside(uri.fsPath, root.fsPath);
  if (!real) return undefined;
  let handle: Awaited<ReturnType<typeof openFile>> | undefined;
  try {
    // A regular file only: opening a FIFO would block a thread of the file system pool.
    if (!(await lstatFile(real))) return undefined;
    handle = await openFile(real, 'r');
    const st = await handle.stat();
    if (!st.isFile()) return undefined;
    const size = st.size;
    if (size > maxBytes || offset + length > size) return undefined;
    const buf = new Uint8Array(length);
    const { bytesRead } = await handle.read(buf, 0, length, offset);
    return bytesRead === length ? buf : undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/** File names on macOS and Windows are case-insensitive by default: a key under which `RTL/x.sv` and `rtl/x.sv` are one file. */
const caseInsensitive = process.platform === 'win32' || process.platform === 'darwin';
export function uriKey(uri: vscode.Uri | string): string {
  const s = uri.toString();
  return caseInsensitive && s.startsWith('file:') ? s.toLowerCase() : s;
}

export const manifestUri = (ref: ExplainerRef) => vscode.Uri.joinPath(ref.dir, 'manifest.json');
export const htmlUri = (ref: ExplainerRef) => vscode.Uri.joinPath(ref.dir, 'sidestory.html');

export const MAX_ASSET_BYTES = 5_000_000;

/** Bytes of a file under `root` (symlinks followed and checked), or undefined if missing, outside or too big. */
export async function readBytesInside(uri: vscode.Uri, root: vscode.Uri, maxBytes: number): Promise<Uint8Array | undefined> {
  try {
    if (uri.scheme === 'file' && root.scheme === 'file') {
      const real = await realPathInside(uri.fsPath, root.fsPath);
      if (!real) {
        log.warn(`Not reading ${uri.fsPath}: missing, or outside ${root.fsPath} after following links.`);
        return undefined;
      }
      await assertSize(real, maxBytes);
      return await vscode.workspace.fs.readFile(vscode.Uri.file(real));
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.byteLength > maxBytes) log.warn(`Not reading ${uri.toString()}: larger than ${maxBytes} bytes.`);
    return bytes.byteLength <= maxBytes ? bytes : undefined;
  } catch (e) {
    log.warn(`Can't read ${uri.toString()}: ${(e as Error).message}`);
    return undefined;
  }
}

/**
 * Text of a file under `root`, preferring an open editor's unsaved buffer so edits show without saving.
 * Refuses files outside `root` (after following symlinks) and files over `maxBytes`.
 * Returns undefined if the file is missing or refused.
 */
export async function readInside(uri: vscode.Uri, root: vscode.Uri, maxBytes: number): Promise<string | undefined> {
  const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
  if (uri.scheme !== 'file' || root.scheme !== 'file') {
    // Virtual file systems: no symlinks to follow. On remote hosts the extension runs there, so paths are `file:`.
    if (open) return open.getText();
    const bytes = await vscode.workspace.fs.readFile(uri).then(undefined, () => undefined);
    return bytes && bytes.byteLength <= maxBytes ? new TextDecoder().decode(bytes) : undefined;
  }
  const real = await realPathInside(uri.fsPath, root.fsPath);
  if (!real) {
    log.warn(`Not reading ${uri.fsPath}: missing, or outside ${root.fsPath} after following links.`);
    return undefined;
  }
  if (open) {
    const text = open.getText(); // a copy of the whole buffer: once, not once to measure and again to return
    return text.length <= maxBytes ? text : undefined;
  }
  try {
    await assertSize(real, maxBytes);
    // Files that aren't open are read as UTF-8 (documented limit).
    return new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.file(real)));
  } catch (e) {
    log.warn(`Can't read ${uri.fsPath}: ${(e as Error).message}`);
    return undefined;
  }
}

async function lstatFile(path: string): Promise<boolean> {
  try {
    return (await statFile(path)).isFile();
  } catch {
    return false;
  }
}
