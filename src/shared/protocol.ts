// Messages between the extension host and the explainer webview.
// The webview never reloads: content and anchor states arrive as updates it applies in place.
import { z } from 'zod';
import { anchorIdSchema, isSafeRelativePath } from '../core/manifest.ts';
import type { AnchorState } from '../core/resolve.ts';

export interface AnchorView {
  id: string;
  file: string;
  /** Current location, 1-based inclusive. Null when the code can't be found. */
  range: { start: number; end: number } | null;
  /** `pending`: not resolved yet (shown as normal, never as "not found"). */
  state: AnchorState | 'pending';
  /** CSS variable for the section accent, e.g. `--vscode-charts-purple`. */
  colorVar?: string;
}

export type ToWebview =
  /** Everything the page needs; sent in reply to `ready`. */
  | { type: 'init'; title: string; html: string; anchors: AnchorView[]; active?: string }
  /** The explainer HTML changed: patch it in place. */
  | { type: 'content'; title: string; html: string }
  /** Anchor locations or states changed. */
  | { type: 'anchors'; anchors: AnchorView[] }
  /** The cursor moved into another section's code. */
  | { type: 'syncTo'; anchorId: string }
  /** Step forward or back (keyboard command from the editor). */
  | { type: 'navigate'; delta: 1 | -1 }
  /** The explainer could not be loaded; keep showing the last good content. */
  | { type: 'error'; message: string | null }
  /** Files in the explainer folder changed (paths relative to it): reload them. */
  | { type: 'assetsChanged'; paths: string[] }
  /** Reply to `requestAsset`: the file's bytes as base64 (binary doesn't survive every remote setup), or null. */
  | { type: 'asset'; id: number; mime: string; data: string | null };

export type FromWebview =
  | { type: 'ready' }
  /** The reader moved to a section: reveal and highlight its code without moving the cursor. */
  | { type: 'focusAnchor'; anchorId: string; source: 'scroll' | 'click' | 'step' }
  /** An inline reference was clicked: jump the cursor there. */
  | { type: 'openRef'; anchorId: string }
  /** A web or mail link was clicked. */
  | { type: 'openExternal'; url: string }
  /** A link to another file in the explainer folder was clicked (path relative to that folder). */
  | { type: 'openFile'; path: string }
  /** The content frame needs a file from the explainer folder (an image, font or stylesheet). */
  | { type: 'requestAsset'; id: number; path: string };

/** `charts.purple` → `--vscode-charts-purple`. Input is validated by the manifest schema. */
export function themeColorVar(colorId: string): string {
  return `--vscode-${colorId.replace(/\./g, '-')}`;
}

/** Runtime check for messages from the webview, which renders untrusted HTML. */
export const fromWebviewSchema: z.ZodType<FromWebview> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('focusAnchor'), anchorId: anchorIdSchema, source: z.enum(['scroll', 'click', 'step']) }),
  z.object({ type: z.literal('openRef'), anchorId: anchorIdSchema }),
  z.object({ type: z.literal('openExternal'), url: z.string().max(2048).refine((u) => safeExternalUrl(u) !== null) }),
  z.object({ type: z.literal('openFile'), path: z.string().max(1024).refine(isSafeRelativePath) }),
  z.object({ type: z.literal('requestAsset'), id: z.number().int().nonnegative(), path: z.string().max(1024).refine(isSafeRelativePath) }),
]);

const MIME: Record<string, string> = {
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
  woff2: 'font/woff2', woff: 'font/woff', ttf: 'font/ttf', otf: 'font/otf', css: 'text/css', mp4: 'video/mp4', webm: 'video/webm',
};

/** The media type for an explainer asset, or null for file types the content may not load. */
export function assetMime(path: string): string | null {
  return MIME[path.split('.').pop()?.toLowerCase() ?? ''] ?? null;
}

/**
 * The normalized URL if an explainer may open it in the browser, else null: http(s) or mailto only,
 * no credentials, and no local or private hosts. (On a remote host, VS Code would tunnel a localhost
 * link to the remote machine's own services.)
 */
export function safeExternalUrl(raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol === 'mailto:') {
    // Only the plain fields: some mail clients honour others, e.g. attach=/path/to/file.
    return [...u.searchParams.keys()].every((k) => ['subject', 'body', 'cc', 'bcc'].includes(k.toLowerCase())) ? u.href : null;
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  if (u.username || u.password) return null;
  // On a remote window VS Code also opens port forwards for localhost URLs found *inside* the query
  // (e.g. an OAuth redirect_uri). Refuse any query or fragment value that is itself a web URL.
  // Mirror VS Code: it percent-decodes the whole query first, then splits on & and =. Check every
  // value both that way and the standard way, and refuse local hosts anywhere in the decoded text.
  const decodedQuery = decodeURIComponentSafe(u.search.slice(1));
  const decodedHash = decodeURIComponentSafe(u.hash.slice(1));
  const values = [
    ...decodedQuery.split('&').map((p) => p.slice(p.indexOf('=') + 1)),
    ...u.searchParams.values(),
    decodedHash,
  ];
  if (values.some((v) => /^\s*https?:/i.test(v))) return null;
  if (/https?:|localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]/i.test(decodedQuery + decodedHash)) return null;
  const host = u.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  // The URL parser has already turned every IPv4 spelling (hex, decimal, short) into a dotted quad.
  const ipv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  const ipv6 = host.includes(':');
  const privateHost =
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    /\.(internal|home\.arpa|lan|corp)$/.test(host) ||
    (!ipv4 && !ipv6 && !host.includes('.')) || // single-label names resolve on the local network
    (ipv4 && /^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.|2(2[4-9]|[3-5]\d)\.)/.test(host)) ||
    (ipv6 && (host === '::1' || host === '::' || /^(fc|fd|fe[89ab]|fe[c-f]|ff)/.test(host) || host.startsWith('::ffff:')));
  return privateHost ? null : u.href;
}

function decodeURIComponentSafe(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}
