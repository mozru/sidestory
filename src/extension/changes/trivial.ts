// "Mark as Trivial…" (docs/CHANGES-PLAN.md §7.6): a pinned `trivial` anchor with a required `why`, written into a
// sidestory that belongs to the branch, or into a new one (`.sidestory/<branch-slug>/`, with the base and a title from
// the branch name). Head side for added or replaced lines; base side (version 3) for a pure deletion.
import { randomBytes } from 'node:crypto';
import { applyEdits, modify, parse } from 'jsonc-parser';
import * as vscode from 'vscode';
import { displayText, escapeIcons, plainForMessage } from '../../core/display-text.ts';
import type { LineRange, Side } from '../../core/manifest.ts';
import { parseWhy } from '../../core/manifest.ts';
import { pinQuote } from '../../core/pin.ts';
import { splitLines } from '../../core/text.ts';
import { writeFileAtomic } from '../paths.ts';
import type { Belonging } from './coverage-service.ts';
import type { Snapshot } from './comparison.ts';

const ULID_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A ULID (time, then randomness), for a new sidestory's `id`. */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ULID_CHARS[t % 32]! + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let rest = '';
  for (let i = 0; i < 16; i++) rest += ULID_CHARS[rnd[i]! % 32]!;
  return time + rest;
}

/** A folder name from a branch: `alice/retry-jitter` → `retry-jitter`; letters, digits, `.`, `-`, `_`. */
export function branchSlug(branch: string | undefined): string {
  const last = (branch ?? '').split('/').filter(Boolean).at(-1) ?? '';
  const slug = last.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[^A-Za-z0-9]+/, '').slice(0, 60).replace(/[-.]+$/, '');
  return slug || 'this-branch';
}

/** A manifest with a trivial anchor added (and version 3 for a base-side one), keeping the rest as written. */
export function addTrivialAnchor(text: string, a: { file: string; side: Side; range: LineRange; quote: object; why: string }): { text: string; id: string } {
  const raw = parse(text.replace(/^﻿/, '')) as { version?: number; anchors?: Record<string, unknown> };
  const anchors = raw.anchors ?? {};
  let n = 1;
  while (`trivial-${n}` in anchors) n++;
  const id = `trivial-${n}`;
  const value = { file: a.file, ...(a.side === 'base' ? { side: 'base' } : {}), range: [a.range.start, a.range.end], quote: a.quote, trivial: true, why: a.why };
  const fmt = { formattingOptions: { insertSpaces: true, tabSize: 2, eol: text.includes('\r\n') ? '\r\n' : '\n' } };
  let out = applyEdits(text, modify(text, ['anchors', id], value, fmt));
  const version = typeof raw.version === 'number' ? raw.version : 2;
  const want = a.side === 'base' ? 3 : 2;
  if (version < want) out = applyEdits(out, modify(out, ['version'], want, fmt));
  return { text: out, id };
}

export interface TrivialTarget {
  /** Repo-relative path on the side. */
  path: string;
  side: Side;
  range: LineRange;
  /** The side's text (the quote is pinned against it). */
  text: string;
}

/** Asks where and why, then writes the mark. Returns the folder written to, or undefined when cancelled. */
export async function markTrivial(s: Snapshot, belonging: readonly Belonging[], t: TrivialTarget): Promise<string | undefined> {
  type Pick = vscode.QuickPickItem & { b?: Belonging };
  const items: Pick[] = belonging.map((b) => ({ label: `$(book) ${escapeIcons(displayText(b.manifest.title, 80))}`, description: escapeIcons(displayText(b.folder, 80)), b }));
  items.push({ label: '$(add) A new sidestory for this branch', description: `.sidestory/${branchSlug(s.head.name)}` });
  const pick = items.length === 1 ? items[0] : await vscode.window.showQuickPick(items, { title: 'Mark as Trivial: Which Sidestory?' });
  if (!pick) return undefined;
  const why = await vscode.window.showInputBox({
    title: 'Mark as Trivial',
    prompt: 'Why does this change need no explanation? (Reviewers see this.)',
    placeHolder: 'formatting only; a generated file; a rename the tests cover',
    validateInput: (v) => (v.trim() ? parseWhy(v.trim()).error : 'Say why: a trivial mark needs a reason'),
  });
  const reason = why?.trim();
  if (!reason || parseWhy(reason).error) return undefined;
  const quote = pinQuote(splitLines(t.text), t.range, 'ws');
  if (!quote) {
    void vscode.window.showWarningMessage("Can't mark that as trivial: its lines are blank.");
    return undefined;
  }
  const root = s.repo.rootUri;
  if (pick.b) {
    const b = pick.b;
    const file = b.prefix ? t.path.slice(b.prefix.length + 1) : t.path;
    const uri = vscode.Uri.joinPath(b.dir, 'manifest.json');
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    const before = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(uri));
    const { text } = addTrivialAnchor(before, { file, side: t.side, range: t.range, quote, why: reason });
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(open.positionAt(0), open.positionAt(before.length)), text);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error("couldn't edit manifest.json");
      await open.save();
    } else await writeFileAtomic(uri.fsPath, text);
    vscode.window.setStatusBarMessage(`Marked ${plainForMessage(t.path, 80)} L${t.range.start}–${t.range.end} trivial in ${plainForMessage(b.folder, 80)}.`, 5000);
    return b.folder;
  }
  // A new sidestory for this branch: the base, a title from the branch, and one sentence on the page.
  let slug = branchSlug(s.head.name);
  for (let i = 2; ; i++) {
    try {
      await vscode.workspace.fs.stat(vscode.Uri.joinPath(root, '.sidestory', slug));
      slug = `${branchSlug(s.head.name)}-${i}`;
    } catch {
      break;
    }
  }
  const dir = vscode.Uri.joinPath(root, '.sidestory', slug);
  const title = displayText((s.head.name ?? slug).split('/').at(-1)!.replace(/[-_]+/g, ' '), 60) || 'This branch';
  const manifest = {
    version: t.side === 'base' ? 3 : 2,
    id: ulid(),
    title: title.charAt(0).toUpperCase() + title.slice(1),
    base: s.base.spec,
    anchors: { 'trivial-1': { file: t.path, ...(t.side === 'base' ? { side: 'base' } : {}), range: [t.range.start, t.range.end], quote, trivial: true, why: reason } },
  };
  await vscode.workspace.fs.createDirectory(dir);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'manifest.json'), new TextEncoder().encode(`${JSON.stringify(manifest, null, 2)}\n`));
  const page = `<!doctype html>\n<html><head><meta charset="utf-8"><title>${manifest.title.replace(/[<&]/g, '')}</title></head><body>\n<h1>${manifest.title.replace(/[<&]/g, '')}</h1>\n<p>Started from the Changes view, with a change marked trivial. Explain the branch's other changes here.</p>\n</body></html>\n`;
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(dir, 'sidestory.html'), new TextEncoder().encode(page));
  vscode.window.setStatusBarMessage(`Started .sidestory/${slug} with a trivial mark.`, 5000);
  return `.sidestory/${slug}`;
}
