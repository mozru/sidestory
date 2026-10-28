// Messages between a widget frame (untrusted code + our runtime) and the panel. The panel validates
// everything a widget frame sends with `fromWidgetSchema`, and accepts it only from that frame's window.
// See docs/WIDGETS-PLAN.md §5.3 and §6.
// zod/mini, not zod: this module is in the panel's bundle, and classic zod would add ~450 KB to it.
import * as z from 'zod/mini';
import { ANCHOR_ID_RE } from '../core/paths.ts';

export const MAX_WIDGET_STATE_BYTES = 64 * 1024;
export const MAX_WIDGET_HEIGHT = 20_000;

const lineNumber = z.int().check(z.minimum(1), z.maximum(100_000));
const lines = z.tuple([lineNumber, lineNumber]);
const identifier = z.string().check(z.regex(/^[A-Za-z_$][\w$]{0,99}$/));
const identifiers = z.optional(z.array(identifier).check(z.maxLength(20)));
const anchorId = z.string().check(z.regex(ANCHOR_ID_RE));
const text = (max: number) => z.string().check(z.maxLength(max));
const shortcutKey = z.object({
  key: text(32),
  code: text(32),
  keyCode: z.int().check(z.minimum(0), z.maximum(255)),
  shiftKey: z.boolean(),
  altKey: z.boolean(),
  ctrlKey: z.boolean(),
  metaKey: z.boolean(),
  repeat: z.boolean(),
});

export const fromWidgetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boot') }),
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('height'), px: z.number().check(z.minimum(0), z.maximum(MAX_WIDGET_HEIGHT)) }),
  z.object({ type: z.literal('highlight'), lines: z.optional(lines), anchor: z.optional(anchorId), identifiers }),
  z.object({ type: z.literal('reveal'), id: z.int(), anchor: anchorId, lines: z.optional(lines), highlight: identifiers }),
  z.object({ type: z.literal('step'), id: z.int(), anchor: anchorId }),
  z.object({ type: z.literal('key'), id: z.int(), action: z.enum(['next', 'prev', 'back']) }),
  z.object({ type: z.literal('state'), json: text(MAX_WIDGET_STATE_BYTES) }),
  z.object({ type: z.literal('error'), message: text(2048), file: z.optional(text(512)), line: z.optional(z.int()) }),
  z.object({ type: z.literal('activity') }),
  /** The reader pressed a pointer or key in the frame (the frame's own claim: spares it from being stopped, never grants anything). */
  z.object({ type: z.literal('input') }),
  /** `key`: the shortcut that made a `shortcut` exit, for VS Code (the frame's claim: the panel decides). */
  z.object({ type: z.literal('focusExit'), dir: z.enum(['forward', 'backward', 'escape', 'pointer', 'shortcut']), key: z.optional(shortcutKey) }),
  z.object({ type: z.literal('requestCode'), anchor: anchorId }),
  z.object({ type: z.literal('pong'), n: z.int() }),
]);
export type FromWidget = z.infer<typeof fromWidgetSchema>;

export type ThemeKind = 'dark' | 'light' | 'high-contrast' | 'high-contrast-light';

export interface WidgetAnchor {
  id: string;
  title: string;
  /** Index among steps, or -1 for a nested (non-step) anchor. */
  step: number;
  file: string;
  range: { start: number; end: number } | null;
  state: string;
  color?: string;
}

export interface WidgetCode {
  anchor: string;
  status: 'ok' | 'unavailable';
  reason?: 'not-pinned' | 'unconfirmed' | 'ignored' | 'secret-file' | 'lost' | 'changed-untracked' | 'changed-since-commit' | 'too-large' | 'not-requested';
  text?: string;
  startLine?: number;
  language?: string;
  state?: string;
}

/** Panel → widget. */
export type ToWidget =
  | { type: 'load'; scripts: string[] }
  | {
      type: 'init';
      props: Record<string, unknown>;
      state: string | null;
      theme: { kind: ThemeKind; vars: Record<string, string>; bodyClass: string; reducedMotion?: boolean };
      viewportHeight: number;
      activeStep: string | null;
      myAnchor: string | null;
      anchors: WidgetAnchor[];
      reducedMotion: boolean;
      entry: string;
      modules: Record<string, string>;
      /** lucide-react icon data by imported name (from the compiler), for the generated 'lucide-react' module. */
      icons: Record<string, unknown>;
      /** Data URLs for `asset(path)`, by path relative to the explainer folder. */
      assets?: Record<string, string>;
    }
  | { type: 'step'; activeStep: string | null }
  | { type: 'anchors'; anchors: WidgetAnchor[] }
  | { type: 'code'; code: WidgetCode }
  | { type: 'theme'; kind: ThemeKind; vars: Record<string, string>; bodyClass: string; reducedMotion?: boolean }
  | { type: 'visible'; visible: boolean }
  | { type: 'viewport'; height: number }
  | { type: 'result'; id: number; ok: boolean }
  | { type: 'saveState' }
  | { type: 'ping'; n: number };
