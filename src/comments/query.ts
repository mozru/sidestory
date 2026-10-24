// What agents read about threads (docs/COMMENTS-PLAN.md §9.5, §10.2): the MCP server's get_thread and
// list_threads, and the checker's `threads` command, from one place, with the same labels.
import { join } from 'node:path';
import { displayText } from '../core/display-text.ts';
import { outlineHtml } from '../core/html-scan.ts';
import { type Anchor } from '../core/manifest.ts';
import { resolveAnchor } from '../core/resolve.ts';
import { authorLabel, type Thread } from '../core/threads/reduce.ts';
import { CAPS, type CodeAnchor } from '../core/threads/schema.ts';
import { PreparedText } from '../core/text.ts';
import { readSmall, realInside } from './fsx.ts';
import { type Location, type ThreadFiles, type ThreadRead } from './storage.ts';

export interface ThreadEntry {
  files: ThreadFiles;
  location: Location;
  read: ThreadRead;
  thread: Thread;
}

/** Every reduced thread under these repositories, newest activity first. */
export async function allThreads(repos: readonly ThreadFiles[], now = Date.now()): Promise<ThreadEntry[]> {
  const out: ThreadEntry[] = [];
  let total = CAPS.threadsTotal;
  for (const files of repos) {
    for (const location of await files.locations()) {
      if (total <= 0) break;
      const budget = { bytes: CAPS.bytesPerSidestory, threads: Math.min(CAPS.threadsPerSidestory, total) };
      for (const { read, thread } of await files.readLocation(location, now, budget)) {
        total--;
        if (thread) out.push({ files, location, read, thread });
      }
    }
  }
  return out.sort((a, b) => b.thread.lastAt - a.thread.lastAt);
}

export type Status = 'waiting_for_claude' | 'open' | 'all';

export function sidestoryOf(l: Location): string | undefined {
  return l.scope.kind === 'sidestory' ? l.scope.name : undefined;
}

export function shortAnchor(t: Thread): Record<string, unknown> {
  const a = t.anchor;
  if (a.kind === 'code') return { kind: 'code', file: a.file, lines: `${a.range[0]}-${a.range[1]}`, side: a.side };
  return { kind: 'step', step: a.step };
}

export function summary(e: ThreadEntry): Record<string, unknown> {
  const last = [...e.thread.comments].reverse().find((c) => !c.retracted) ?? e.thread.comments[e.thread.comments.length - 1];
  return {
    thread: e.thread.id,
    sidestory: sidestoryOf(e.location) ?? null,
    tier: e.location.tier,
    anchor: shortAnchor(e.thread),
    state: e.thread.state,
    waiting_for_claude: e.thread.waitingForClaude,
    last: last ? { trust: last.trust, author: authorLabel(last), excerpt: displayText(last.body, 200) } : null,
  };
}

export function filterStatus(entries: readonly ThreadEntry[], status: Status, sidestory?: string): ThreadEntry[] {
  return entries.filter(
    (e) =>
      (sidestory === undefined || sidestoryOf(e.location) === sidestory) &&
      (status === 'all' || (status === 'open' ? e.thread.state === 'open' : e.thread.waitingForClaude)),
  );
}

/** A step's title from the sidestory's HTML (repository data). */
async function stepTitle(root: string, sidestory: string | undefined, step: string): Promise<string | undefined> {
  if (!sidestory) return undefined;
  try {
    const p = join(root, '.sidestory', sidestory, 'sidestory.html');
    if (!(await realInside(p, root))) return undefined; // no symlinks out of the repository
    const html = await readSmall(p, 5_000_000);
    if (html === undefined) return undefined;
    const o = outlineHtml(html);
    const s = o.steps.find((x) => x.id === step) ?? o.steps.find((x) => x.id === o.anchorStep.get(step));
    return s ? displayText(s.title, 200) : undefined;
  } catch {
    return undefined;
  }
}

/** Where a code thread's quote is now, with the core resolver (exact, moved, changed, stale, lost). */
export async function resolveCode(root: string, a: CodeAnchor): Promise<{ state: string; lines?: [number, number] }> {
  const p = join(root, ...a.file.split('/'));
  if (!(await realInside(p, root))) return { state: 'lost' };
  const text = await readSmall(p, 10_000_000);
  if (text === undefined) return { state: 'lost' };
  const anchor: Anchor = { id: 'x', file: a.file, range: { start: a.range[0], end: a.range[1] }, quote: { ...a.quote, norm: 'ws' }, highlight: [] };
  const r = resolveAnchor(PreparedText.from(text), anchor);
  return { state: r.state, ...(r.range ? { lines: [r.range.start, r.range.end] as [number, number] } : {}) };
}

/** get_thread's result (§9.5): the newest `limit` events before the cursor. Anchor fields are repository data. */
export async function threadDetail(e: ThreadEntry, limit = 50, before?: string): Promise<Record<string, unknown>> {
  const ss = sidestoryOf(e.location);
  const a = e.thread.anchor;
  const anchor: Record<string, unknown> = { kind: a.kind === 'code' ? 'code' : 'step' };
  if (a.kind !== 'code') {
    anchor.step = a.step;
    const title = await stepTitle(e.files.root, ss, a.step);
    if (title) anchor.step_title = title;
  } else {
    const r = await resolveCode(e.files.root, a);
    Object.assign(anchor, { file: a.file, lines: r.lines ?? a.range, side: a.side, code_state: r.state });
    if (a.commit) anchor.commit = a.commit;
  }
  let list = e.thread.comments.filter((c) => !c.retracted);
  if (before) {
    const i = list.findIndex((c) => c.id === before);
    if (i >= 0) list = list.slice(0, i);
  }
  const page = list.slice(-limit);
  return {
    thread: e.thread.id,
    sidestory: ss ?? null,
    tier: e.location.tier,
    state: e.thread.state,
    anchor,
    events: page.map((c) => ({ id: c.id, at: c.at, trust: c.trust, author: authorLabel(c), kind: c.first ? 'open' : 'comment', ...(c.to ? { to: c.to } : {}), body: c.body })),
    ...(list.length > page.length ? { more: true, before: page[0]?.id } : {}),
  };
}
