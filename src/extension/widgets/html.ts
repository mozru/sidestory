// Widget placeholders as the extension sees them in explainer.html (it has no DOM): their sources, for
// compiling, consent and diagnostics, and problems an author should see in the Problems panel. The panel's
// sanitizer is what renders them (src/webview/sanitize.ts); this mirrors its rules for diagnostics.
import { isWidgetSrc, MAX_WIDGETS } from '../../shared/protocol.ts';

export interface HtmlWidget {
  src: string;
  /** 1-based line of the tag. */
  line: number;
}

export interface HtmlProblem {
  line: number;
  message: string;
  severity: 'error' | 'warning';
}

const MAX_PROPS = 16 * 1024;
const TAG_START = /<explain-widget(?=[\s/>])/gi;
const ATTR = /([^\s"'>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

const decode = (s: string) => s.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

export function scanWidgets(html: string): { widgets: HtmlWidget[]; problems: HtmlProblem[] } {
  const widgets: HtmlWidget[] = [];
  const problems: HtmlProblem[] = [];
  // Line numbers counted incrementally (tags come in order), not by re-scanning from the start each time.
  let counted = 0;
  let lines = 1;
  const lineAt = (i: number) => {
    for (; counted < i; counted++) if (html.charCodeAt(counted) === 10) lines++;
    return lines;
  };
  // Each tag is scanned only up to the next one (quotes respected), so the work stays linear in the input.
  const starts = [...html.matchAll(TAG_START)].map((m) => m.index);
  const tags: { index: number; end: number; body: string }[] = [];
  starts.forEach((start, n) => {
    const limit = starts[n + 1] ?? html.length;
    let quote = '';
    let i = start + 15;
    for (; i < limit; i++) {
      const c = html[i]!;
      if (quote) {
        if (c === quote) quote = '';
      } else if (c === '"' || c === "'") quote = c;
      else if (c === '>') break;
    }
    if (i < limit) tags.push({ index: start, end: i + 1, body: html.slice(start + 15, i) });
  });
  for (const tag of tags) {
    const line = lineAt(tag.index);
    let body = tag.body;
    const selfClosing = /\/\s*$/.test(body);
    if (selfClosing) {
      body = body.replace(/\/\s*$/, '');
      problems.push({ line, severity: 'warning', message: '<explain-widget …/> is not self-closing in HTML: write <explain-widget …></explain-widget> (it was read that way).' });
    }
    const attrs = new Map<string, string>();
    for (const a of body.matchAll(ATTR)) attrs.set(a[1]!.toLowerCase(), decode(a[2] ?? a[3] ?? a[4] ?? ''));
    const src = attrs.get('src') ?? '';
    if (!isWidgetSrc(src)) {
      problems.push({ line, severity: 'error', message: `<explain-widget src="${src}">: src must be a .tsx, .ts, .jsx or .js file inside the explainer folder.` });
      continue;
    }
    widgets.push({ src, line });
    // Props: the JSON child wins over the attribute; both are checked as JSON.
    const close = html.indexOf('</explain-widget', tag.end);
    const rest = selfClosing ? '' : html.slice(tag.end, close < 0 ? Math.min(html.length, tag.end + MAX_PROPS + 1000) : close);
    const child = /^\s*<script\b[^>]*type\s*=\s*["']?application\/json["']?[^>]*>([\s\S]*?)<\/script>/i.exec(rest);
    const attrProps = attrs.get('props');
    if (child && attrProps !== undefined) problems.push({ line, severity: 'warning', message: `${src}: both a props attribute and a JSON <script> child; the JSON child is used.` });
    const json = child ? child[1]! : attrProps;
    if (json !== undefined && json.trim() !== '') {
      const at = child ? line + (rest.slice(0, child.index + child[0].indexOf('>') + 1).split('\n').length - 1) : line;
      if (json.length > MAX_PROPS) problems.push({ line: at, severity: 'error', message: `${src}: props are larger than 16 KB and are ignored.` });
      else {
        try {
          const v: unknown = JSON.parse(json);
          if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new Error('props must be a JSON object');
        } catch (e) {
          const msg = (e as Error).message;
          const pos = /position (\d+)/.exec(msg);
          const extra = /\(line (\d+)/.exec(msg)?.[1] ?? (pos ? String(json.slice(0, Number(pos[1])).split('\n').length) : '1');
          problems.push({ line: at + Number(extra) - 1, severity: 'error', message: `${src}: props aren't valid JSON: ${msg}` });
        }
      }
    }
  }
  if (widgets.length > MAX_WIDGETS) problems.push({ line: widgets[MAX_WIDGETS]!.line, severity: 'warning', message: `More than ${MAX_WIDGETS} widgets: only the first ${MAX_WIDGETS} run.` });
  return { widgets, problems };
}

/** The distinct widget sources an explainer uses (the first MAX_WIDGETS placeholders). */
export function widgetSources(html: string): string[] {
  return [...new Set(scanWidgets(html).widgets.slice(0, MAX_WIDGETS).map((w) => w.src))];
}

/**
 * Anchors a widget reads with `useAnchorCode`, from its compiled modules: literal ids, or `all` when an id is
 * computed (any anchor could then be read).
 */
export function anchorsRead(modules: Record<string, string>): Set<string> | 'all' {
  const ids = new Set<string>();
  for (const code of Object.values(modules)) {
    // Compiled calls look like `useAnchorCode.call(void 0, 'id')` (Sucrase), `(0, x.useAnchorCode)('id')` or plain.
    for (const m of code.matchAll(/useAnchorCode\b\)?(?:\.call\(\s*void 0\s*,|\s*\()\s*(?:(["'`])([A-Za-z][\w-]{0,63})\1\s*\)|([^)\s]))/g)) {
      if (m[2]) ids.add(m[2]);
      else if (m[3]) return 'all';
    }
  }
  return ids;
}
