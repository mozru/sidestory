// Copies of the caps in src/shared/widget-protocol.ts, which the frame can't import without bundling zod
// (and the manifest schema) into the runtime. test/widgets/runtime.pw.ts checks they stay equal.
export const MAX_WIDGET_STATE_BYTES = 64 * 1024;
export const MAX_WIDGET_HEIGHT = 20_000;
