// The formatting subset comment bodies get (docs/COMMENTS-PLAN.md §6.5). Bodies are untrusted text: this small
// parser turns them into a tree of a few node types; the panel builds DOM from it with textContent only, and the
// editor builds an escaped MarkdownString from it. No links, images, headings, tables or HTML, ever.
import { isSafeRelativePath } from '../paths.ts';
import { CAPS } from './caps.ts';

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'strong'; children: Inline[] }
  | { t: 'em'; children: Inline[] }
  | { t: 'code'; text: string }
  /** A code reference inside inline code: `path#L10-L20` or `path:10-20`. */
  | { t: 'ref'; text: string; path: string; start?: number; end?: number }
  | { t: 'br' };

export type Block =
  | { t: 'p'; children: Inline[] }
  | { t: 'pre'; lang: string; text: string }
  | { t: 'list'; ordered: boolean; items: Inline[][] }
  | { t: 'quote'; children: Inline[][] };

/** Bidirectional, invisible and control characters (but newlines and tabs) are removed before parsing. */
const STRIP = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f؜​-‏‪-‮⁠-⁤⁦-⁩﻿]|\udb40[\udc00-\udc7f]/g;

export function cleanForDisplay(body: string): string {
  return body.replace(/\r\n?/g, '\n').replace(STRIP, '').slice(0, CAPS.bodyChars);
}

const REF = /^([A-Za-z0-9._/-]{1,300})(?:#L(\d{1,7})(?:-L(\d{1,7}))?|:(\d{1,7})(?:-(\d{1,7}))?)$/;

/** A code reference in inline code, when its path is safe. */
export function parseCodeRef(text: string): { path: string; start?: number; end?: number } | null {
  const m = REF.exec(text);
  if (!m || !isSafeRelativePath(m[1]!) || !m[1]!.includes('.')) return null;
  const a = m[2] ?? m[4];
  const b = m[3] ?? m[5];
  const start = a ? Number(a) : undefined;
  const end = b ? Number(b) : start;
  if (start !== undefined && (start < 1 || (end ?? start) < start)) return null;
  return { path: m[1]!, ...(start !== undefined ? { start, end } : {}) };
}

export function parseInline(s: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let text = '';
  const flush = () => {
    if (text) out.push({ t: 'text', text });
    text = '';
  };
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === '\n') {
      flush();
      out.push({ t: 'br' });
      i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        flush();
        const code = s.slice(i + 1, j);
        const ref = parseCodeRef(code);
        out.push(ref ? { t: 'ref', text: code, ...ref } : { t: 'code', text: code });
        i = j + 1;
        continue;
      }
    }
    if (depth < 2 && c === '*' && s[i + 1] === '*') {
      const j = s.indexOf('**', i + 2);
      if (j > i + 2) {
        flush();
        out.push({ t: 'strong', children: parseInline(s.slice(i + 2, j), depth + 1) });
        i = j + 2;
        continue;
      }
    }
    if (depth < 2 && (c === '*' || c === '_') && s[i + 1] !== c && s[i + 1] !== ' ') {
      const j = s.indexOf(c, i + 1);
      if (j > i + 1 && s[j - 1] !== ' ') {
        flush();
        out.push({ t: 'em', children: parseInline(s.slice(i + 1, j), depth + 1) });
        i = j + 1;
        continue;
      }
    }
    text += c;
    i++;
  }
  flush();
  return out;
}

/** Parses a comment body into the subset's blocks. Anything else is text. */
export function parseBody(body: string): Block[] {
  const lines = cleanForDisplay(body).split('\n');
  const blocks: Block[] = [];
  let para: string[] = [];
  const flushPara = () => {
    if (para.length) blocks.push({ t: 'p', children: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(```+|~~~+)\s*([A-Za-z0-9_+-]{0,30})\s*$/.exec(line);
    if (fence) {
      flushPara();
      const close = fence[1]!;
      const text: string[] = [];
      i++;
      while (i < lines.length && !lines[i]!.trimStart().startsWith(close)) text.push(lines[i++]!);
      blocks.push({ t: 'pre', lang: fence[2]!.toLowerCase(), text: text.join('\n') });
      continue;
    }
    const bullet = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      const ordered = /\d/.test(bullet[1]!);
      const items: Inline[][] = [];
      let j = i;
      for (; j < lines.length; j++) {
        const m = /^\s{0,3}([-*+]|\d{1,3}[.)])\s+(.*)$/.exec(lines[j]!);
        if (!m || /\d/.test(m[1]!) !== ordered) break;
        items.push(parseInline(m[2]!));
      }
      blocks.push({ t: 'list', ordered, items });
      i = j - 1;
      continue;
    }
    if (/^\s{0,3}>/.test(line)) {
      flushPara();
      const quoted: string[] = [];
      let j = i;
      for (; j < lines.length && /^\s{0,3}>/.test(lines[j]!); j++) quoted.push(lines[j]!.replace(/^\s{0,3}>\s?/, ''));
      blocks.push({ t: 'quote', children: quoted.join('\n').split(/\n{2,}/).map((p) => parseInline(p)) });
      i = j - 1;
      continue;
    }
    if (!line.trim()) {
      flushPara();
      continue;
    }
    para.push(line);
  }
  flushPara();
  return blocks;
}

/** U+2060 WORD JOINER: breaks autolinks in the editor's markdown; stripped again whenever text is copied. */
export const JOINER = '⁠';

/** Breaks what markdown renderers turn into links on their own: `scheme://`, `www.`, and `a@b`. */
export function breakAutolinks(s: string): string {
  return s
    .replace(/:\/\//g, `:${JOINER}//`)
    .replace(/\bwww\./gi, (m) => `${m.slice(0, 3)}${JOINER}.`)
    .replace(/@/g, `${JOINER}@`);
}

export function stripJoiners(s: string): string {
  return s.split(JOINER).join('');
}

/** Escapes every markdown-significant character, so text renders as itself. */
export function escapeMarkdown(s: string): string {
  return s.replace(/[\\`*_{}[\]()#+\-.!|<>~&:$]/g, (c) => (c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '&' ? '&amp;' : `\\${c}`));
}

function inlineMd(nodes: Inline[]): string {
  return nodes
    .map((n) => {
      switch (n.t) {
        case 'text':
          return escapeMarkdown(breakAutolinks(n.text));
        case 'strong':
          return `**${inlineMd(n.children)}**`;
        case 'em':
          return `*${inlineMd(n.children)}*`;
        case 'code':
        case 'ref': {
          const t = breakAutolinks(n.text).replace(/`/g, 'ˋ');
          return `\`${t}\``;
        }
        case 'br':
          return '  \n';
      }
    })
    .join('');
}

/**
 * Markdown for VS Code's Comments API (a MarkdownString with isTrusted, supportHtml and supportThemeIcons off),
 * built only from escaped pieces of the subset, with autolinks broken (§12.4).
 */
export function toEditorMarkdown(body: string): string {
  return parseBody(body)
    .map((b) => {
      switch (b.t) {
        case 'p':
          return inlineMd(b.children);
        case 'pre': {
          const text = breakAutolinks(b.text).replace(/^(\s*)(```|~~~)/gm, '$1​$2');
          return `\`\`\`${b.lang}\n${text}\n\`\`\``;
        }
        case 'list':
          return b.items.map((it, i) => `${b.ordered ? `${i + 1}.` : '-'} ${inlineMd(it)}`).join('\n');
        case 'quote':
          return b.children.map((p) => `> ${inlineMd(p)}`).join('\n>\n');
      }
    })
    .join('\n\n');
}
