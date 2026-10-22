// Messages between the extension host and the explainer webview.
// The webview never reloads: content and anchor states arrive as updates it applies in place.
import { z } from 'zod';
import { anchorIdSchema, explainerNameSchema, isSafeRelativePath } from '../core/manifest.ts';
import type { AnchorState } from '../core/resolve.ts';
import { WIDGET_SOURCE_EXTENSIONS } from './widget-imports.ts';
import type { WidgetCode } from './widget-protocol.ts';

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

/** One level of the explainer path (the trail): the root explainer, the details dived into, the current one. */
export interface TrailItem {
  name: string;
  title: string;
}

/** What a parent shows about a detail explainer before you dive into it. */
export interface DetailInfo {
  name: string;
  found: boolean;
  title: string;
  summary: string;
  /** How many steps diving would add. */
  steps: number;
}

/** What the panel may do with the widgets of the explainer shown (docs/WIDGETS-PLAN.md §5.1). */
export interface WidgetGate {
  /** `off`: the setting; `untrusted`: Restricted Mode; `ask`: the reader hasn't agreed (or code arrived through git); `on`: widgets run. */
  status: 'off' | 'untrusted' | 'ask' | 'on';
  /** Anchors widgets read whose quotes the reader hasn't confirmed: the consent bar offers to confirm them. */
  unconfirmed: { anchors: number; summary: string } | null;
  /** Widget sources (relative to the explainer folder) the watchdog disabled until their code changes. */
  disabled: string[];
  /** Last known heights by widget key, so remounts don't shift the page. */
  heights: Record<string, number>;
  /** The watchdog gave up on this explainer's widgets (they kept freezing the panel): none run until re-enabled. */
  stopped?: boolean;
}

/** A compiled widget as the panel needs it (docs/WIDGETS-PLAN.md §3 "Compile"). */
export interface WidgetBuild {
  entry: string;
  modules: Record<string, string>;
  /** Library ids in load order. */
  libraries: string[];
  icons: Record<string, unknown>;
  /** Problems, relative paths only; the first error is shown in the widget's box. */
  errors: { file: string; line?: number; message: string }[];
  /** Over the import closure: tells versions apart. */
  hash: string;
}

export type ToWebview =
  /** Everything the page needs; sent in reply to `ready`, and when the panel moves to another explainer. */
  | {
      type: 'init';
      title: string;
      html: string;
      anchors: AnchorView[];
      active?: string;
      /** Identifies the explainer (its folder URI), so the page can remember the reader's place in each. */
      dir: string;
      /** Base URL that relative URLs in this explainer resolve against. */
      base: string;
      trail: TrailItem[];
    }
  /** Answers `describe`. */
  | { type: 'details'; items: DetailInfo[] }
  /** The editor cursor is in a file that a detail of the current step explains. */
  | { type: 'childHint'; name: string; title: string }
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
  | { type: 'asset'; id: number; mime: string; data: string | null }
  /** Whether widgets may run in the explainer shown, and what the consent bar offers. */
  | { type: 'widgets'; gate: WidgetGate }
  /** A widget's compiled code (reply to `widgetCompile`, and again whenever its files change); null when refused. */
  | { type: 'widget'; src: string; build: WidgetBuild | null }
  /** Library texts by id (reply to `widgetLibs`). */
  | { type: 'widgetLibs'; libs: Record<string, string> }
  /** An anchor's code for the widgets with this src (reply to `widgetCode`, and again when it changes). */
  | { type: 'widgetCode'; src: string; code: WidgetCode }
  /** The watchdog: remove every widget frame now (`unmount`), or mount them again (`remount`). */
  | { type: 'widgetsReset'; phase: 'unmount' | 'remount' }
  /** The panel just became active: did focus arrive legitimately? Answered with `focusAnswer`. */
  | { type: 'focusQuery'; id: number };

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
  | { type: 'requestAsset'; id: number; path: string }
  /** Open a detail explainer in this panel, optionally at one of its sections. */
  | { type: 'dive'; name: string; section?: string }
  /** Go back up the trail to this level (0 = the root explainer). */
  | { type: 'goTo'; depth: number }
  /** Describe these detail explainers (title, summary, size). */
  | { type: 'describe'; names: string[] }
  /** Point this section at the code selected in the editor (asks the user to confirm first). */
  | { type: 'reanchor'; anchorId: string }
  /** The consent bar: ask the reader (in a native modal) whether to run this explainer's widgets. */
  | { type: 'widgetConsent' }
  /** The consent bar in Restricted Mode: start VS Code's own "Trust workspace" flow. */
  | { type: 'widgetTrust' }
  /** The consent bar: let widgets read anchors whose quotes nobody confirmed (a native modal asks). */
  | { type: 'widgetConfirmAnchors' }
  /** Compiled code for a widget source (refused without trust, the setting and consent). */
  | { type: 'widgetCompile'; src: string }
  /** Library texts for widget frames. */
  | { type: 'widgetLibs'; ids: string[] }
  /** A widget wants an anchor's code (`useAnchorCode`); the panel forwards the answer to the widgets that asked. */
  | { type: 'widgetCode'; src: string; anchor: string }
  /** Decorate lines of an anchor (relative to its first line) while its step is current; no anchor clears. */
  | { type: 'widgetHighlight'; anchor?: string; lines?: [number, number]; identifiers?: string[] }
  /** A widget's `reveal`, already checked by the panel (a click in that widget). */
  | { type: 'widgetReveal'; anchor: string; lines?: [number, number]; highlight?: string[] }
  /** For Output (authors): a widget's error, a dropped call, a placement problem. */
  | { type: 'widgetLog'; src: string; level: 'error' | 'warn' | 'info'; message: string }
  /** Last heights by widget key, coalesced. */
  | { type: 'widgetHeights'; heights: Record<string, number> }
  /** Every second while visible: the extension-side watchdog (docs/WIDGETS-PLAN.md §4). */
  | { type: 'heartbeat'; delay: number; visible: boolean; mounted: string[]; mounting: string | null; recent: string | null }
  /** The panel-side watchdog: mounted widgets stopped answering pings. */
  | { type: 'widgetsUnresponsive'; mounted: string[]; mounting: string | null; recent: string | null }
  /** Answers `focusQuery`. */
  | { type: 'focusAnswer'; id: number; legit: boolean }
  /** A widget took focus while the panel didn't have it (from the editor): give focus back to the editor. */
  | { type: 'focusTheft' };

/** `charts.purple` → `--vscode-charts-purple`. Input is validated by the manifest schema. */
export function themeColorVar(colorId: string): string {
  return `--vscode-${colorId.replace(/\./g, '-')}`;
}

/** How deep detours can nest. */
export const MAX_TRAIL = 16;

/** The most widgets an explainer may have; the rest show their fallback. */
export const MAX_WIDGETS = 24;

/** A widget's `src`: a relative path inside the explainer folder with a source extension. */
export const isWidgetSrc = (s: string) => isSafeRelativePath(s) && WIDGET_SOURCE_EXTENSIONS.some((e) => s.toLowerCase().endsWith(e));
const widgetSrcSchema = z.string().max(512).refine(isWidgetSrc);
const lineRangeSchema = z.tuple([z.number().int().min(1).max(100_000), z.number().int().min(1).max(100_000)]);
const identifierSchema = z.string().regex(/^[A-Za-z_$][\w$]{0,99}$/);
const widgetKeySchema = z.string().max(300);
const breadcrumbs = {
  mounted: z.array(widgetSrcSchema).max(MAX_WIDGETS),
  mounting: widgetSrcSchema.nullable(),
  recent: widgetSrcSchema.nullable(),
};

/** Runtime check for messages from the webview, which renders untrusted HTML. */
export const fromWebviewSchema: z.ZodType<FromWebview> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('focusAnchor'), anchorId: anchorIdSchema, source: z.enum(['scroll', 'click', 'step']) }),
  z.object({ type: z.literal('openRef'), anchorId: anchorIdSchema }),
  z.object({ type: z.literal('openExternal'), url: z.string().max(2048).refine((u) => safeExternalUrl(u) !== null) }),
  z.object({ type: z.literal('openFile'), path: z.string().max(1024).refine(isSafeRelativePath) }),
  z.object({ type: z.literal('requestAsset'), id: z.number().int().nonnegative(), path: z.string().max(1024).refine(isSafeRelativePath) }),
  z.object({ type: z.literal('dive'), name: explainerNameSchema, section: anchorIdSchema.optional() }),
  z.object({ type: z.literal('goTo'), depth: z.number().int().min(0).max(MAX_TRAIL) }),
  z.object({ type: z.literal('describe'), names: z.array(explainerNameSchema).max(50) }),
  z.object({ type: z.literal('reanchor'), anchorId: anchorIdSchema }),
  z.object({ type: z.literal('widgetConsent') }),
  z.object({ type: z.literal('widgetTrust') }),
  z.object({ type: z.literal('widgetConfirmAnchors') }),
  z.object({ type: z.literal('widgetCompile'), src: widgetSrcSchema }),
  z.object({ type: z.literal('widgetLibs'), ids: z.array(z.string().regex(/^[a-z0-9-]{1,32}$/)).max(20) }),
  z.object({ type: z.literal('widgetCode'), src: widgetSrcSchema, anchor: anchorIdSchema }),
  z.object({ type: z.literal('widgetHighlight'), anchor: anchorIdSchema.optional(), lines: lineRangeSchema.optional(), identifiers: z.array(identifierSchema).max(20).optional() }),
  z.object({ type: z.literal('widgetReveal'), anchor: anchorIdSchema, lines: lineRangeSchema.optional(), highlight: z.array(identifierSchema).max(20).optional() }),
  z.object({ type: z.literal('widgetLog'), src: z.string().max(512), level: z.enum(['error', 'warn', 'info']), message: z.string().max(4096) }),
  z.object({ type: z.literal('widgetHeights'), heights: z.record(widgetKeySchema, z.number().int().min(0).max(20_000)).refine((h) => Object.keys(h).length <= 200) }),
  z.object({ type: z.literal('heartbeat'), delay: z.number().finite().min(0).max(3_600_000), visible: z.boolean(), ...breadcrumbs }),
  z.object({ type: z.literal('widgetsUnresponsive'), ...breadcrumbs }),
  z.object({ type: z.literal('focusAnswer'), id: z.number().int(), legit: z.boolean() }),
  z.object({ type: z.literal('focusTheft') }),
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
  // A query or fragment that doesn't decode cleanly is refused: decoders disagree on such input.
  if (!decodesCleanly(u.search.slice(1)) || !decodesCleanly(u.hash.slice(1))) return null;
  const decodedQuery = percentDecode(u.search.slice(1));
  const decodedHash = percentDecode(u.hash.slice(1));
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

function decodesCleanly(s: string): boolean {
  try {
    decodeURIComponent(s);
    return true;
  } catch {
    return false;
  }
}

// VS Code's own decoding (src/vs/base/common/uri.ts), so we see a URL exactly as it will.
const ENCODED_AS_HEX = /(%[0-9A-Za-z][0-9A-Za-z])+/g;

function decodeURIComponentGraceful(str: string): string {
  try {
    return decodeURIComponent(str);
  } catch {
    return str.length > 3 ? str.slice(0, 3) + decodeURIComponentGraceful(str.slice(3)) : str;
  }
}

function percentDecode(str: string): string {
  return str.replace(ENCODED_AS_HEX, (m) => decodeURIComponentGraceful(m));
}
