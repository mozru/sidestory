// Copies of the caps in src/shared/widget-protocol.ts, which the frame can't import without bundling zod
// (and the manifest schema) into the runtime. test/widgets/runtime.pw.ts checks they stay equal.
export const MAX_WIDGET_STATE_BYTES = 64 * 1024;
export const MAX_WIDGET_HEIGHT = 20_000;
/** The manifest's anchor id rule and the protocol's line and identifier limits (the panel drops anything else). */
export const ANCHOR_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
export const IDENTIFIER = /^[A-Za-z_$][\w$]{0,99}$/;
export const MAX_LINE = 100_000;
export const MAX_IDENTIFIERS = 20;
