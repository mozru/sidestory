// Messages between the extension host and the explainer webview.
// The webview never reloads: content and anchor states arrive as updates it applies in place.
import { z } from 'zod';
import { anchorIdSchema } from '../core/manifest.ts';
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
  | { type: 'error'; message: string | null };

export type FromWebview =
  | { type: 'ready' }
  /** The reader moved to a section: reveal and highlight its code without moving the cursor. */
  | { type: 'focusAnchor'; anchorId: string; source: 'scroll' | 'click' | 'step' }
  /** An inline reference was clicked: jump the cursor there. */
  | { type: 'openRef'; anchorId: string }
  /** A web or mail link was clicked; VS Code asks before opening it. */
  | { type: 'openExternal'; url: string };

/** `charts.purple` → `--vscode-charts-purple`. Input is validated by the manifest schema. */
export function themeColorVar(colorId: string): string {
  return `--vscode-${colorId.replace(/\./g, '-')}`;
}

/** Runtime check for messages from the webview, which renders untrusted HTML. */
export const fromWebviewSchema: z.ZodType<FromWebview> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('ready') }),
  z.object({ type: z.literal('focusAnchor'), anchorId: anchorIdSchema, source: z.enum(['scroll', 'click', 'step']) }),
  z.object({ type: z.literal('openRef'), anchorId: anchorIdSchema }),
  z.object({
    type: z.literal('openExternal'),
    url: z
      .string()
      .max(2048)
      .refine((u) => {
        try {
          return ['http:', 'https:', 'mailto:'].includes(new URL(u).protocol);
        } catch {
          return false;
        }
      }),
  }),
]);
