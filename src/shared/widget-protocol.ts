// Messages between a widget frame (untrusted code + our runtime) and the panel. The panel validates
// everything a widget frame sends with `fromWidgetSchema`, and accepts it only from that frame's window.
// See docs/WIDGETS-PLAN.md §5.3 and §6.
import { z } from 'zod';
import { anchorIdSchema } from '../core/manifest.ts';

export const MAX_WIDGET_STATE_BYTES = 64 * 1024;
export const MAX_WIDGET_HEIGHT = 20_000;

const lines = z.tuple([z.number().int().min(1).max(100_000), z.number().int().min(1).max(100_000)]);
const identifier = z.string().regex(/^[A-Za-z_$][\w$]{0,99}$/);

export const fromWidgetSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('boot') }),
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('height'), px: z.number().finite().min(0).max(MAX_WIDGET_HEIGHT) }),
  z.object({ type: z.literal('highlight'), lines: lines.optional(), anchor: anchorIdSchema.optional(), identifiers: z.array(identifier).max(20).optional() }),
  z.object({ type: z.literal('reveal'), id: z.number().int(), anchor: anchorIdSchema, lines: lines.optional(), highlight: z.array(identifier).max(20).optional() }),
  z.object({ type: z.literal('step'), id: z.number().int(), anchor: anchorIdSchema }),
  z.object({ type: z.literal('key'), id: z.number().int(), action: z.enum(['next', 'prev', 'back']) }),
  z.object({ type: z.literal('state'), json: z.string().max(MAX_WIDGET_STATE_BYTES) }),
  z.object({ type: z.literal('error'), message: z.string().max(2048), file: z.string().max(512).optional(), line: z.number().int().optional() }),
  z.object({ type: z.literal('activity') }),
  z.object({ type: z.literal('focusExit'), dir: z.enum(['forward', 'backward', 'escape', 'pointer', 'shortcut']) }),
  z.object({ type: z.literal('requestCode'), anchor: anchorIdSchema }),
  z.object({ type: z.literal('pong'), n: z.number().int() }),
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
  reason?: 'not-pinned' | 'unconfirmed' | 'ignored' | 'secret-file' | 'lost' | 'changed-untracked' | 'changed-since-commit' | 'too-large';
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
      theme: { kind: ThemeKind; vars: Record<string, string>; bodyClass: string };
      viewportHeight: number;
      activeStep: string | null;
      myAnchor: string | null;
      anchors: WidgetAnchor[];
      reducedMotion: boolean;
      entry: string;
      modules: Record<string, string>;
    }
  | { type: 'step'; activeStep: string | null }
  | { type: 'anchors'; anchors: WidgetAnchor[] }
  | { type: 'code'; code: WidgetCode }
  | { type: 'theme'; kind: ThemeKind; vars: Record<string, string>; bodyClass: string }
  | { type: 'visible'; visible: boolean }
  | { type: 'viewport'; height: number }
  | { type: 'result'; id: number; ok: boolean }
  | { type: 'saveState' }
  | { type: 'ping'; n: number };
