// What `coverage` takes, built the same way by the checker (src/cli/coverage.ts) and the extension
// (src/extension/changes/coverage-service.ts), so the two count the same changes against the same targets.
import { normLine, type FileInput, type Target } from './coverage.ts';
import { textLines, type ChangeBlock } from './hunks.ts';
import { sideOf, type Manifest, type Side } from './manifest.ts';
import { resolveAnchor } from './resolve.ts';
import { PreparedText } from './text.ts';

/**
 * One PreparedText per text: anchors in the same file share its split and index. Texts prepared by `previous` (the
 * last run) are taken over, so a file that didn't change isn't prepared again; older runs' texts are let go.
 */
export class PreparedTexts {
  private readonly now = new Map<string, PreparedText>();
  private readonly before: ReadonlyMap<string, PreparedText> | undefined;

  constructor(previous?: PreparedTexts) {
    this.before = previous?.now;
  }

  get(text: string): PreparedText {
    let p = this.now.get(text);
    if (!p) {
      p = this.before?.get(text) ?? PreparedText.from(text);
      this.now.set(text, p);
    }
    return p;
  }
}

/**
 * A belonging sidestory's targets: its anchors resolved on their side of the changed files. A trivial anchor without
 * a `why` and an anchor the page doesn't use (`used`) aren't targets; neither is one in a file this branch doesn't
 * change (`textOf` gives no text for that side).
 */
export function coverageTargets(
  s: { folder: string; prefix: string; manifest: Manifest },
  used: ReadonlySet<string>,
  textOf: (path: string, side: Side) => string | undefined,
  prepared: PreparedTexts = new PreparedTexts(),
): Target[] {
  const out: Target[] = [];
  for (const a of s.manifest.anchors.values()) {
    if (a.trivial && a.why === undefined) continue;
    if (!a.trivial && !used.has(a.id)) continue; // explains nothing (anchor-unused)
    const side = sideOf(a);
    const path = s.prefix ? `${s.prefix}/${a.file}` : a.file;
    const text = textOf(path, side);
    if (text === undefined) continue; // a file this branch doesn't change: nothing to cover
    const r = resolveAnchor(prepared.get(text), a);
    out.push({
      sidestory: s.folder,
      anchor: a.id,
      path,
      side,
      range: r.range,
      state: r.state,
      ...(a.trivial ? { trivial: true, why: a.why } : {}),
      ...(a.quote && side === 'head' ? { pinned: new Set(textLines(a.quote.exact).map(normLine)) } : {}),
    });
  }
  return out;
}

/** A changed file for `coverage`: its blocks, and its lines on each side (an absent side has none). */
export function fileInput(f: { path: string; oldPath?: string; changes: readonly ChangeBlock[]; old: string | undefined; new: string | undefined; trivialFile: boolean }): FileInput {
  const newLines = f.new !== undefined ? textLines(f.new) : [];
  const oldLines = f.old !== undefined ? textLines(f.old) : [];
  return {
    path: f.path,
    ...(f.oldPath !== undefined ? { oldPath: f.oldPath } : {}),
    changes: f.changes,
    newLine: (l) => newLines[l - 1] ?? '',
    oldLine: (l) => oldLines[l - 1] ?? '',
    trivialFile: f.trivialFile,
    newLines: newLines.length,
  };
}
