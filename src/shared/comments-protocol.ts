// Panel ↔ host messages for comment threads (docs/COMMENTS-PLAN.md §6.6). The panel renders untrusted HTML, so
// every message from it is schema-checked, carries ids only, and is posted only from its own handlers for
// trusted input in host chrome. What the host sends carries cleaned strings, trust labels and our own enums.
import { z } from 'zod';
import { anchorIdSchema } from '../core/manifest.ts';
import { CAPS, EVENT_ID_RE, THREAD_ID_RE, type Trust } from '../core/threads/schema.ts';

export type DeliveryState =
  | 'sending'
  | 'no-session'
  | 'pushed'
  | 'not-responding'
  | 'busy'
  | 'not-picked-up'
  | 'working'
  | 'session-ended'
  | 'ended-before-answering'
  | 'not-answered'
  | 'copied';

export type DeliveryAction = 'copyPrompt' | 'sendAgain' | 'chooseSession' | 'howTo' | 'sendElsewhere' | 'markAnswered' | 'stopWaiting';

export interface DeliveryView {
  state: DeliveryState;
  /** The line shown (the same strings in the panel and the editor). */
  text: string;
  actions: DeliveryAction[];
  /** Milliseconds since the ack, for "Claude is on it · 12s". */
  since?: number;
}

export interface CommentItemView {
  id: string;
  /** "you", "Alex Chen", "Claude (via you)", "Claude (from the repository)". */
  author: string;
  trust: Trust;
  claude: boolean;
  /** ISO time from the file (display only). */
  at: string;
  body: string;
  mine: boolean;
  changed: boolean;
  retracted: boolean;
  toClaude: boolean;
  /** Edited after it was sent to Claude: "edited after sending · Send Again". */
  editedAfterSend?: boolean;
  delivery?: DeliveryView;
  /** Claude's reply listed these edits: `step:<id>` or a safe path. */
  editedChips?: string[];
}

export interface ThreadTargetView {
  kind: 'step' | 'code';
  /** Step id (for code threads, the step whose anchor covers it, when one does). */
  step?: string;
  file?: string;
  lines?: [number, number];
  /** "Step 3 · Delay", "src/retry.ts:14–18 · in Step 3". */
  label: string;
  /** Code threads: exact, moved, changed, stale, lost. */
  codeState?: string;
  /** The step is no longer in this sidestory. */
  gone?: boolean;
}

export interface ThreadView {
  id: string;
  tier: 'local' | 'shared';
  target: ThreadTargetView;
  state: 'open' | 'resolved';
  /** "Resolved by Sam". */
  stateText?: string;
  comments: CommentItemView[];
  unread: boolean;
  suggestsResolve: boolean;
  waiting: boolean;
  canReply: boolean;
  canDelete: boolean;
  /** The session a send in this thread goes to, when known. */
  session?: string;
  /** Tracked by git although it lives in `.local`. */
  tracked?: boolean;
}

export interface CommentsContext {
  /** Ask Claude delivers by push (C2); false: it copies the prompt (C1-only). */
  push: boolean;
  /** "Ask Claude · svc (main)": the session a send would go to, when known. */
  session?: string;
  /** Several sessions: the ▾ next to the send button. */
  manySessions: boolean;
  defaultTier: 'local' | 'shared';
  restricted: boolean;
  /** The local tier refused (the `.gitignore` check failed): why. */
  localBlocked?: string;
}

export type CommentsToWebview =
  | { type: 'threads'; dir: string; threads: ThreadView[]; context: CommentsContext }
  /** A command or the Comments view asked to show the pane (at a step or thread, composing in a mode). */
  | { type: 'commentsShow'; step?: string; thread?: string; compose?: 'comment' | 'ask' };

export type CommentsFromWebview =
  | { type: 'commentCreate'; step: string; body: string; toClaude: boolean; intent?: 'answer' | 'edit' }
  | { type: 'commentReply'; thread: string; body: string; toClaude: boolean; intent?: 'answer' | 'edit' }
  | { type: 'commentEdit'; event: string; body: string }
  | { type: 'commentRetract'; event: string }
  | { type: 'threadAction'; thread: string; action: 'resolve' | 'reopen' | 'share' | 'local' | 'delete' | 'copyPrompt' | 'copyMarkdown' | 'showCode' }
  | { type: 'threadRead'; threads: string[] }
  | { type: 'deliveryAction'; event: string; action: DeliveryAction }
  | { type: 'pickSession' };

const body = z.string().min(1).max(CAPS.bodyChars);
const threadId = z.string().regex(THREAD_ID_RE);
const eventId = z.string().regex(EVENT_ID_RE);

export const commentsFromWebviewSchemas = [
  z.object({ type: z.literal('commentCreate'), step: anchorIdSchema, body, toClaude: z.boolean(), intent: z.enum(['answer', 'edit']).optional() }),
  z.object({ type: z.literal('commentReply'), thread: threadId, body, toClaude: z.boolean(), intent: z.enum(['answer', 'edit']).optional() }),
  z.object({ type: z.literal('commentEdit'), event: eventId, body }),
  z.object({ type: z.literal('commentRetract'), event: eventId }),
  z.object({ type: z.literal('threadAction'), thread: threadId, action: z.enum(['resolve', 'reopen', 'share', 'local', 'delete', 'copyPrompt', 'copyMarkdown', 'showCode']) }),
  z.object({ type: z.literal('threadRead'), threads: z.array(threadId).max(200) }),
  z.object({ type: z.literal('deliveryAction'), event: eventId, action: z.enum(['copyPrompt', 'sendAgain', 'chooseSession', 'howTo', 'sendElsewhere', 'markAnswered', 'stopWaiting']) }),
  z.object({ type: z.literal('pickSession') }),
] as const;

const COMMENT_TYPES = new Set(['commentCreate', 'commentReply', 'commentEdit', 'commentRetract', 'threadAction', 'threadRead', 'deliveryAction', 'pickSession']);
export const isCommentsMessage = (m: { type: string }): m is CommentsFromWebview => COMMENT_TYPES.has(m.type);
