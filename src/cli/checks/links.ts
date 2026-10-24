// The checker's findings for the links in a page (docs/AUTHORING-PLAN.md §2.3, §3.3, §8.1, §10.4):
//   - ids: every data-explain-anchor, data-explain-ref and data-explain-on id is in the manifest, and every manifest
//     anchor is used (by the page or its widgets); data-explain-on ids that never become active;
//   - diagrams: links inside role="img", linked elements with no accessible name, links on or inside form controls
//     and widgets (the panel ignores them), data-explain-ref and data-explain-code on one element, empty
//     data-explain-diagram scopes, tagged elements with no scope;
//   - code links: syntax, the file (real path, inside the repository, not in .git), SV symbols with the scanner,
//     line ranges against the file, and a symbol to use instead of lines in SV files.
// It runs on the shared linear HTML tokenizer and tree builder, so it stays linear on hostile pages.
import { readFile, stat } from 'node:fs/promises';
import { HtmlTokenizer, TreeBuilder, type Frame, type StartTag } from '../../core/html-scan.ts';
import { anchorIdSchema, type LineRange } from '../../core/manifest.ts';
import { defaultDriverName, findSvSymbol, isSvPath, scanSv, type SymbolTable } from '../../core/symbols/sv.ts';
import { formatCodeLink, MAX_CODE_LINKS, parseCodeLink, parseCodeTarget } from '../../shared/code-link.ts';
import { checkCodePath } from '../../extension/code-paths.ts';
import { lineIndex } from '../html.ts';

export type Severity = 'error' | 'warning' | 'info';
export interface Problem {
  severity: Severity;
  line: number;
  code: string;
  message: string;
}

/** Elements the panel won't open links on or in: a <label> forwards clicks to these (main.ts LABELABLE). */
const CONTROLS = new Set(['button', 'input', 'select', 'textarea', 'meter', 'output', 'progress']);
/** Records kept per kind, so a hostile page can't make the checker's lists grow without bound. */
const MAX_RECORDS = 5000;
const MAX_PROBLEMS_PER_CODE = 50;

export interface PageLinks {
  anchors: { id: string; line: number }[];
  refs: { id: string; line: number }[];
  codes: { value: string; inherited?: string; line: number }[];
  ons: { ids: string[]; line: number }[];
  problems: Problem[];
}

interface LinkFrame extends Frame {
  line: () => number;
  roleImg: boolean;
  /** The nearest ancestor with role="img", and the nearest <explain-widget>: links inside are reported once per owner. */
  img?: LinkFrame;
  widget?: LinkFrame;
  /** Links found inside this element (when it's an img or widget owner). */
  inner?: string[];
  inControl: boolean;
  codeFile?: string;
  /** The data-explain-diagram (or outermost <svg>) this element is in, for data-explain-on. */
  scope?: { diagram: boolean; participants: number; line: number };
  /** A linked element: the text counter when it opened, and whether an attribute names it. */
  link?: { at: number; named: boolean };
}

const hasToken = (v: string | undefined, t: string) => !!v && v.toLowerCase().split(/\s+/).includes(t);
const quoted = (s: string) => JSON.stringify(s.length > 120 ? `${s.slice(0, 120)}…` : s);

export function scanPageLinks(html: string): PageLinks {
  let lines: ((offset: number) => number) | undefined;
  const lineOf = (offset: number) => (lines ??= lineIndex(html))(offset);
  const out: PageLinks = { anchors: [], refs: [], codes: [], ons: [], problems: [] };
  const counts = new Map<string, number>();
  const problem = (p: Problem) => {
    const n = counts.get(p.code) ?? 0;
    counts.set(p.code, n + 1);
    if (n < MAX_PROBLEMS_PER_CODE) out.problems.push(p);
  };
  const diagrams: NonNullable<LinkFrame['scope']>[] = [];
  /** Bumped by every bit of text, <title> or alt inside the page: a link with a later count has a name. */
  let named = 0;

  const start = (f: LinkFrame, t: StartTag, pushed: boolean) => {
    const stack = tree.stack;
    const parent = (pushed ? stack[stack.length - 2] : stack[stack.length - 1]) as LinkFrame | undefined;
    const a = t.attrs;
    f.roleImg = hasToken(a.get('role'), 'img');
    f.img = parent?.roleImg ? parent : parent?.img;
    f.widget = parent?.name === 'explain-widget' ? parent : parent?.widget;
    f.inControl = !!parent && (parent.inControl || CONTROLS.has(parent.name));
    f.codeFile = a.get('data-explain-code-file') ?? parent?.codeFile;
    if (a.has('data-explain-diagram')) {
      f.scope = { diagram: true, participants: 0, line: f.line() };
      if (diagrams.length < MAX_RECORDS) diagrams.push(f.scope);
    } else f.scope = parent?.scope ?? (t.name === 'svg' ? { diagram: false, participants: 0, line: 0 } : undefined);
    if ((t.name === 'img' || t.name === 'area') && a.get('alt')?.trim()) named++;

    const anchor = a.get('data-explain-anchor');
    if (anchor !== undefined && out.anchors.length < MAX_RECORDS) out.anchors.push({ id: anchor.trim(), line: f.line() });
    const on = a.get('data-explain-on');
    if (on !== undefined) {
      const ids = on.trim() ? on.trim().split(/\s+/) : [];
      if (out.ons.length < MAX_RECORDS) out.ons.push({ ids, line: f.line() });
      if (f.scope) f.scope.participants++;
      else if (ids.length) problem({ severity: 'info', line: f.line(), code: 'on-no-scope', message: `data-explain-on=${quoted(on)} is outside any data-explain-diagram or <svg>: it lights up, but nothing fades around it.` });
    }
    const ref = a.get('data-explain-ref');
    const code = a.get('data-explain-code');
    if (ref === undefined && code === undefined) return;
    if (ref !== undefined && out.refs.length < MAX_RECORDS) out.refs.push({ id: ref.trim(), line: f.line() });
    if (code !== undefined && ref === undefined && out.codes.length < MAX_RECORDS) out.codes.push({ value: code, inherited: f.codeFile, line: f.line() });
    const what = ref !== undefined ? `data-explain-ref=${quoted(ref)}` : `data-explain-code=${quoted(code!)}`;
    if (ref !== undefined && code !== undefined) {
      problem({ severity: 'error', line: f.line(), code: 'ref-and-code', message: `${what} and data-explain-code on one element: the panel opens the anchor and ignores the code link. Keep one.` });
    }
    if (f.img) (f.img.inner ??= []).push(what);
    if (f.widget) (f.widget.inner ??= []).push(what);
    if (f.inControl || CONTROLS.has(t.name) || t.name === 'explain-widget') {
      problem({ severity: 'warning', line: f.line(), code: 'link-on-control', message: `${what} is on or inside a form control, where the panel ignores links (a <label> could fire them). Put the link on another element.` });
    }
    const attrNamed = ['aria-label', 'aria-labelledby', 'title', 'alt'].some((n) => a.get(n)?.trim());
    if (pushed) f.link = { at: named, named: attrNamed };
    else if (!attrNamed) problem({ severity: 'info', line: f.line(), code: 'ref-no-name', message: `${what} has no text, aria-label or <title>: screen readers announce it as an unnamed link.` });
  };

  const tree: TreeBuilder<LinkFrame> = new TreeBuilder<LinkFrame>(
    (t) => {
      const f = { name: t.name, attrs: t.attrs, offset: t.offset, roleImg: false, inControl: false } as LinkFrame;
      f.line = () => lineOf(t.offset);
      return f;
    },
    {
      open: (f, t) => start(f, t, true),
      leaf: (f, t) => start(f, t, false),
      raw: (f, t) => {
        start(f, t, false);
        if (t.name === 'title' && t.raw && html.slice(t.raw.start, t.raw.end).trim()) named++;
      },
      close: (f) => {
        if (f.inner?.length) {
          const list = `${f.inner.slice(0, 3).join(', ')}${f.inner.length > 3 ? ` and ${f.inner.length - 3} more` : ''}`;
          if (f.roleImg) problem({ severity: 'warning', line: f.line(), code: 'links-in-img', message: `This <${f.name}> has role="img", whose children screen readers can't reach, and it holds ${f.inner.length} link${f.inner.length === 1 ? '' : 's'} (${list}). Give it role="group" (or wrap it in a <figure>) and an aria-label.` });
          if (f.name === 'explain-widget') problem({ severity: 'info', line: f.line(), code: 'link-in-widget', message: `The fallback of this widget holds ${f.inner.length} link${f.inner.length === 1 ? '' : 's'} (${list}), which the panel doesn't open: links inside a widget's placeholder are ignored. Readers without widgets see them, but can't click them.` });
        }
        if (f.link && !f.link.named && f.link.at === named) {
          const ref = f.attrs.get('data-explain-ref');
          const what = ref !== undefined ? `data-explain-ref=${quoted(ref)}` : `data-explain-code=${quoted(f.attrs.get('data-explain-code') ?? '')}`;
          problem({ severity: 'info', line: f.line(), code: 'ref-no-name', message: `${what} has no text, aria-label or <title>: screen readers announce it as an unnamed link.` });
        }
      },
      text: (s, e) => {
        if (/\S/.test(html.slice(s, Math.min(e, s + 200)))) named++;
      },
    },
  );
  const tokens = new HtmlTokenizer(html);
  for (let t = tokens.next(); t; t = tokens.next()) tree.token(t);
  tree.finish();
  for (const d of diagrams) {
    if (d.participants === 0) problem({ severity: 'warning', line: d.line, code: 'empty-diagram', message: 'This data-explain-diagram has no elements with data-explain-on, so nothing in it lights up or fades. Tag its boxes and wires, or drop the attribute.' });
  }
  return out;
}

/**
 * Ids against the manifest, both ways. `widgetIds` are the anchors widget code names ('any' when some widget
 * computes an id, so unused anchors can't be told).
 */
export function checkIds(page: PageLinks, manifestIds: ReadonlySet<string>, widgetIds: ReadonlySet<string> | 'any', manifestLine: (id: string) => number | undefined): { html: Problem[]; manifest: Problem[] } {
  const html: Problem[] = [];
  const manifest: Problem[] = [];
  const valid = (id: string) => anchorIdSchema.safeParse(id).success;
  const sections = new Set(page.anchors.map((a) => a.id));
  const used = new Set<string>([...sections, ...page.refs.map((r) => r.id), ...page.ons.flatMap((o) => o.ids)]);
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  for (const a of page.anchors) {
    if (!manifestIds.has(a.id) && once(`a:${a.id}`)) html.push({ severity: 'warning', line: a.line, code: 'unknown-anchor', message: `data-explain-anchor=${quoted(a.id)}: no anchor ${valid(a.id) ? `"${a.id}" ` : ''}in manifest.json, so this section is a step with no code${valid(a.id) ? '' : ' (ids start with a letter and use letters, digits, - and _)'}.` });
  }
  for (const r of page.refs) {
    if (!manifestIds.has(r.id) && once(`r:${r.id}`)) html.push({ severity: 'warning', line: r.line, code: 'unknown-anchor', message: `data-explain-ref=${quoted(r.id)}: no anchor with that id in manifest.json; the link opens nothing. For code without an anchor, use data-explain-code.` });
  }
  for (const o of page.ons) {
    for (const id of o.ids) {
      if (!manifestIds.has(id)) {
        if (once(`o:${id}`)) html.push({ severity: 'warning', line: o.line, code: 'unknown-anchor', message: `data-explain-on: no anchor ${quoted(id)} in manifest.json, so this never lights up for it.` });
      } else if (!sections.has(id) && once(`n:${id}`)) {
        html.push({ severity: 'warning', line: o.line, code: 'never-on', message: `data-explain-on: "${id}" never becomes the current step, because no element in the page has data-explain-anchor="${id}".` });
      }
    }
  }
  if (widgetIds !== 'any') {
    for (const id of manifestIds) {
      if (used.has(id) || widgetIds.has(id)) continue;
      manifest.push({ severity: 'warning', line: manifestLine(id) ?? 1, code: 'unused-anchor', message: `Anchor "${id}" isn't used: no data-explain-anchor, data-explain-ref or data-explain-on in sidestory.html names it, and no widget does. Link it from the page, or remove it.` });
    }
  }
  return { html, manifest };
}

/** What the checker needs to know about a code link's file: its text, and its symbol table for SV. */
interface FileInfo {
  error?: string;
  secret?: boolean;
  lines?: number;
  table?: SymbolTable;
  sv?: boolean;
}

/**
 * Every data-explain-code link (§8.1): errors for bad syntax and files that aren't in the repository; warnings for
 * SV symbols that are missing or ambiguous and line ranges past the end; info for line links in SV files that a
 * symbol would keep pointing at the code, symbols in other languages, and secret-looking files.
 */
export async function checkCodeLinks(root: string, codes: PageLinks['codes'], maxBytes: number): Promise<Problem[]> {
  const out: Problem[] = [];
  const files = new Map<string, Promise<FileInfo>>();
  const done = new Set<string>();
  const fileInfo = (path: string) => {
    let p = files.get(path);
    if (!p) {
      p = (async (): Promise<FileInfo> => {
        const c = await checkCodePath(root, path);
        if (!c.ok) return { error: c.why };
        try {
          if ((await stat(c.real)).size > maxBytes) return { secret: c.secret, error: 'it is too large to check' };
          const text = await readFile(c.real, 'utf8');
          const sv = isSvPath(path);
          return { secret: c.secret, lines: text.split(/\r\n|\r|\n/).length, sv, table: sv ? scanSv(text) : undefined };
        } catch {
          return { error: "it can't be read" };
        }
      })();
      files.set(path, p);
    }
    return p;
  };
  for (const c of codes) {
    const at = { line: c.line };
    const link = parseCodeLink(c.value, c.inherited);
    const what = `data-explain-code=${quoted(c.value)}`;
    if (!link) {
      const v = c.value.trim();
      const noFile = (v === '' || v.startsWith('#')) && !c.inherited?.trim();
      const target = v.includes('#') ? v.slice(v.indexOf('#') + 1) : '';
      const message = noFile
        ? `${what} names no file: write the path before # (from the folder that holds .sidestory/), or put data-explain-code-file on an ancestor.`
        : target && !parseCodeTarget(target)
          ? `${what}: "#${target.slice(0, 80)}" isn't a line range (#L10 or #L10-L20) or a symbol path (#name, #driver(x), #driver(x).case(LABEL), #u_inst(.port)).`
          : `${what}: the path isn't a relative path inside the repository (from the folder that holds .sidestory/, with / separators, no .. or .git).`;
      out.push({ severity: 'error', ...at, code: 'code-link-syntax', message });
      continue;
    }
    const canonical = formatCodeLink(link);
    if (done.has(canonical) || done.size >= MAX_CODE_LINKS) continue;
    done.add(canonical);
    const info = await fileInfo(link.path);
    const shownPath = quoted(link.path);
    if (info.error && info.lines === undefined && !info.secret) {
      out.push({ severity: 'error', ...at, code: 'code-link-file', message: `${what}: can't open ${shownPath}: ${info.error}.` });
      continue;
    }
    if (info.secret) out.push({ severity: 'info', ...at, code: 'code-link-secret', message: `${what}: ${shownPath} has a secret-looking name, so the panel asks the reader before opening it.` });
    if (info.lines === undefined) continue;
    const t = link.target === undefined ? undefined : parseCodeTarget(link.target);
    if (!t) continue;
    if (t.kind === 'lines') {
      if (t.start > info.lines || t.end > info.lines) {
        out.push({ severity: 'warning', ...at, code: 'code-link-range', message: `${what}: ${shownPath} has ${info.lines} lines, so ${t.start > info.lines ? 'the link opens nothing' : `lines past ${info.lines} don't exist`}.` });
      } else if (info.table) {
        const better = symbolFor(info.table, { start: t.start, end: t.end });
        out.push({ severity: 'info', ...at, code: 'code-link-lines', message: `${what}: line links point wherever those lines are after an edit${better ? `; #${better} follows the code` : '; a symbol (#name, #driver(x)) follows the code'}.` });
      }
      continue;
    }
    if (!info.sv) {
      out.push({ severity: 'info', ...at, code: 'symbol-unchecked', message: `${what}: symbols in files other than SystemVerilog and Verilog are found by VS Code when the link is clicked; this check can't look them up.` });
      continue;
    }
    const r = findSvSymbol(info.table!, t.path);
    if (r.ok) {
      if (r.note) out.push({ severity: 'info', ...at, code: 'symbol-kind', message: `${what}: ${r.note}.` });
      continue;
    }
    if (r.reason === 'syntax') out.push({ severity: 'error', ...at, code: 'code-link-syntax', message: `${what}: ${r.message}` });
    else if (r.partial) out.push({ severity: 'info', ...at, code: 'symbol-partial-scan', message: `${what}: ${r.message}` });
    else out.push({ severity: 'warning', ...at, code: 'code-link-symbol', message: `${what}: ${r.message}` });
  }
  return out;
}

/** A symbol path whose extent covers `range` (the tightest), checked to resolve back to that extent. */
function symbolFor(table: SymbolTable, range: LineRange): string | undefined {
  type C = { path: string; extent: LineRange };
  const cands: C[] = [];
  const covers = (e: LineRange) => e.start <= range.start && e.end >= range.end;
  for (const d of table.drivers) {
    if (!covers(d.extent)) continue;
    const name = defaultDriverName(d);
    if (!name) continue;
    const inner = d.scope.slice(1).filter((s) => !s.startsWith('\0'));
    cands.push({ path: [...inner, `driver(${name})`].join('.'), extent: d.extent });
    for (const c of d.cases) {
      if (c.depth !== 0) continue;
      for (const it of c.items) if (covers(it.extent) && it.labels[0] && !it.labels[0].includes('\0')) cands.push({ path: [...inner, `driver(${name})`, `case(${it.labels[0]})`].join('.'), extent: it.extent });
    }
  }
  for (const s of table.symbols) {
    if (s.kind === 'module' || s.kind === 'package' || s.kind === 'interface' || s.kind === 'class' || !covers(s.extent)) continue;
    if (s.scope.some((x) => x.startsWith('\0'))) continue;
    cands.push({ path: [...s.scope.slice(1), s.name].join('.'), extent: s.extent });
  }
  cands.sort((a, b) => a.extent.end - a.extent.start - (b.extent.end - b.extent.start));
  for (const c of cands.slice(0, 20)) {
    for (const path of [c.path, `${table.symbols.find((s) => s.extent.start <= c.extent.start && s.extent.end >= c.extent.end && (s.kind === 'module' || s.kind === 'interface'))?.name ?? ''}.${c.path}`]) {
      if (path.startsWith('.')) continue;
      const r = findSvSymbol(table, path);
      if (r.ok && r.extent.start === c.extent.start && r.extent.end === c.extent.end) return path;
    }
  }
  return undefined;
}
