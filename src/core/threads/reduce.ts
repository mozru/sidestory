// Reducing a thread's events to what is shown (docs/COMMENTS-PLAN.md §3.4). Pure and deterministic: the
// extension, the server and the checker run the same function, so they agree on order, state and trust.
import { ulidTime, type Author, type EventType, type ThreadAnchor, type ThreadEvent, type Trust } from './schema.ts';

export interface TrustedEvent {
  event: ThreadEvent;
  /** From the authored ledger (§5.2), never from the file. */
  trust: Trust;
}

export interface CommentView {
  id: string;
  at: string;
  by: Author;
  /** The lowest trust of the comment and every edit applied to it. */
  trust: Trust;
  body: string;
  /** The comment was the thread's `open` event. */
  first: boolean;
  to?: 'claude';
  inReplyTo?: string;
  edited?: string[];
  resolveSuggested?: boolean;
  /** An edit was applied. */
  changed: boolean;
  retracted: boolean;
  /** Its ULID time is more than a day ahead of the reducer's clock (ordered as if written now). */
  future: boolean;
}

export interface Thread {
  id: string;
  anchor: ThreadAnchor;
  origin?: ThreadEvent['origin'];
  /** The `open` event's id. */
  openId: string;
  comments: CommentView[];
  state: 'open' | 'resolved';
  /** Who resolved or reopened it last, with that event's trust. */
  stateBy?: { by: Author; trust: Trust; at: string; type: 'resolve' | 'reopen' };
  /** A local_user comment to Claude with no later claude-trust event (§9.5 `waiting_for_claude`). */
  waitingForClaude: boolean;
  /** The newest claude-trust comment suggests resolving, and the thread is open. */
  claudeSuggestsResolve: boolean;
  /** Skipped or ignored events, for diagnostics. */
  diagnostics: string[];
  /** Newest event time (ULID, clamped), for sorting lists. */
  lastAt: number;
}

const FUTURE_MS = 24 * 3600 * 1000;
const isKnown = (t: Trust) => t !== 'repository';

/** Order key: ULID time, clamped to `now` when more than a day ahead, then the id. */
function orderKey(id: string, now: number): [number, boolean] {
  const t = ulidTime(id);
  return t > now + FUTURE_MS ? [now, true] : [t, false];
}

function sameAuthor(a: Author, b: Author): boolean {
  return a.kind === b.kind && a.name === b.name;
}

/**
 * Reduces one thread's events. Returns null when there is no usable `open` event. `now` is the reducer's clock
 * (milliseconds), passed in so every caller can be deterministic in tests.
 */
export function reduceThread(events: readonly TrustedEvent[], now: number): Thread | null {
  const diagnostics: string[] = [];
  const keyed = events.map((te) => {
    const [t, future] = orderKey(te.event.id, now);
    return { ...te, t, future };
  });
  keyed.sort((a, b) => a.t - b.t || (a.event.id < b.event.id ? -1 : a.event.id > b.event.id ? 1 : 0));

  // 3. The open event: the ledger-known one if there is one, else the smallest id.
  const opens = keyed.filter((k) => k.event.type === 'open');
  if (!opens.length) return null;
  const known = opens.filter((k) => isKnown(k.trust)).sort((a, b) => (a.event.id < b.event.id ? -1 : 1));
  const open = known[0] ?? [...opens].sort((a, b) => (a.event.id < b.event.id ? -1 : 1))[0]!;

  const comments = new Map<string, CommentView>();
  const order: string[] = [];
  let state: Thread['state'] = 'open';
  let stateBy: Thread['stateBy'];

  for (const k of keyed) {
    const e = k.event;
    const type: EventType = e.type;
    if (type === 'open' || type === 'comment') {
      comments.set(e.id, {
        id: e.id,
        at: e.at,
        by: e.by,
        trust: k.trust,
        body: e.body ?? '',
        first: e.id === open.event.id,
        ...(e.to ? { to: e.to } : {}),
        ...(e.inReplyTo ? { inReplyTo: e.inReplyTo } : {}),
        ...(e.edited ? { edited: e.edited } : {}),
        ...(e.resolveSuggested ? { resolveSuggested: true } : {}),
        changed: false,
        retracted: false,
        future: k.future,
      });
      order.push(e.id);
      if (type === 'open' && e.id !== open.event.id) diagnostics.push(`${e.id}: a second open event, shown as a comment`);
    }
  }

  for (const k of keyed) {
    const e = k.event;
    if (e.type === 'edit' || e.type === 'retract') {
      const target = e.target ? comments.get(e.target) : undefined;
      if (!target) {
        diagnostics.push(`${e.id}: ${e.type} of an unknown comment`);
        continue;
      }
      // 4. An edit applies only from the same author, at the target's trust or (for a repository target) any trust.
      const trustOk = target.trust === 'repository' || k.trust === target.trust;
      if (!trustOk || !sameAuthor(e.by, target.by)) {
        diagnostics.push(`${e.id}: ${e.type} by someone else, ignored`);
        continue;
      }
      if (e.type === 'edit') {
        target.body = e.body ?? '';
        target.changed = true;
      } else {
        target.retracted = true;
        target.body = '';
      }
      if (k.trust === 'repository') target.trust = 'repository';
    } else if (e.type === 'resolve' || e.type === 'reopen') {
      // A future-dated state change counts only from the reader or this machine's Claude.
      if (k.future && k.trust !== 'local_user' && k.trust !== 'claude') {
        diagnostics.push(`${e.id}: dated in the future, its ${e.type} ignored`);
        continue;
      }
      state = e.type === 'resolve' ? 'resolved' : 'open';
      stateBy = { by: e.by, trust: k.trust, at: e.at, type: e.type };
    }
  }

  const list = order.map((id) => comments.get(id)!);
  // waiting: the newest local_user ask with no later claude-trust comment.
  let waiting = false;
  let suggests = false;
  for (const c of list) {
    if (c.retracted) continue;
    if (c.trust === 'local_user' && c.to === 'claude') waiting = true;
    if (c.trust === 'claude') {
      waiting = false;
      suggests = !!c.resolveSuggested;
    } else if (c.trust === 'local_user') suggests = false;
  }
  const last = keyed[keyed.length - 1];
  return {
    id: open.event.thread,
    anchor: open.event.anchor!,
    ...(open.event.origin ? { origin: open.event.origin } : {}),
    openId: open.event.id,
    comments: list,
    state,
    ...(stateBy ? { stateBy } : {}),
    waitingForClaude: waiting && state === 'open',
    claudeSuggestsResolve: suggests && state === 'open',
    diagnostics,
    lastAt: last ? last.t : 0,
  };
}

/** Whether a comment has been answered by this machine's Claude (§9.8 Answered). */
export function isAnswered(thread: Thread, eventId: string): boolean {
  const i = thread.comments.findIndex((c) => c.id === eventId);
  if (i < 0) return false;
  return thread.comments.some((c, j) => c.trust === 'claude' && (c.inReplyTo === eventId || j > i));
}

/** The comment's author as shown: "you" for the reader's own, "Claude (via X)", "Claude (from the repository)". */
export function authorLabel(c: Pick<CommentView, 'by' | 'trust'>): string {
  if (c.trust === 'local_user') return 'you';
  const name = c.by.name || 'Anonymous';
  if (c.by.kind === 'claude') return c.trust === 'claude' ? `Claude${c.by.via ? ` (via ${c.by.via})` : ''}` : 'Claude (from the repository)';
  if (c.by.kind === 'agent') return c.trust === 'agent' ? `${name}${c.by.via ? ` (via ${c.by.via})` : ''}` : `${name} (from the repository)`;
  // A name that could pass for the reader or for Claude is marked, so a planted comment can't look like theirs.
  if (/^(you|me)$|claude|anthropic/.test(foldLookalikes(name))) return `${name} (from the repository)`;
  return name;
}

/** Lowercased, NFKC, with common Cyrillic and Greek lookalikes folded to Latin, for the label guard above. */
function foldLookalikes(s: string): string {
  const map: Record<string, string> = { а: 'a', е: 'e', о: 'o', р: 'p', с: 'c', у: 'y', х: 'x', і: 'i', ј: 'j', ӏ: 'l', ɩ: 'l', α: 'a', ο: 'o', υ: 'u', ε: 'e', ι: 'i', ν: 'v', κ: 'k', τ: 't', ρ: 'p', 'ⅼ': 'l' };
  return [...s.normalize('NFKC').toLowerCase()].map((c) => map[c] ?? c).join('').replace(/[^a-z]/g, (c) => (c === ' ' ? ' ' : ''));
}
