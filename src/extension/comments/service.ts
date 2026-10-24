// The extension's side of comments (docs/COMMENTS-PLAN.md §3–§6, §9.4, §9.8, §9.9): reading and writing thread
// files, the ledger, Ask Claude sends, routing to a Claude Code session, and delivery states. The panel, the
// editor's Comments API and the Comments view all go through this one service.
import * as vscode from 'vscode';
import { join } from 'node:path';
import { displayText, plainForMessage } from '../../core/display-text.ts';
import { copyPrompt, type Intent } from '../../core/threads/prompt.ts';
import { isAnswered, type Thread } from '../../core/threads/reduce.ts';
import { cleanAuthorName, cleanBody, isPlainPath, type CodeAnchor, type ThreadAnchor, type ThreadEvent } from '../../core/threads/schema.ts';
import { liveness, RECORD_MAX_AGE_MS, StateStore, type Presence, type Send } from '../../comments/delivery.ts';
import { newId, writeReplace } from '../../comments/fsx.ts';
import { Ledger } from '../../comments/ledger.ts';
import { canonical, defaultStateDir, ensureStateDir, repoKeyFor, servesPath, sweepOld } from '../../comments/state-dir.ts';
import { locationKey, ThreadFiles, threadsSegments, type Location } from '../../comments/storage.ts';
import type { DeliveryView } from '../../shared/comments-protocol.ts';
import { log } from '../log.ts';
import { gitHead, gitIgnores, gitTracks, gitUserName } from './git.ts';

export interface Entry {
  root: vscode.Uri;
  files: ThreadFiles;
  location: Location;
  thread: Thread;
  paths: Map<string, string>;
}

interface SendRecord {
  send?: string;
  route?: string;
  at: number;
  /** No session was available: the reader saw the No session state. */
  noSession?: boolean;
  intent?: Intent;
  /** Copy Prompt was used for this comment. */
  copied?: boolean;
}

const SENDS_KEY = 'sidestory.comments.sends';
const THREAD_SESSION_KEY = 'sidestory.comments.threadSession';
const DEFAULT_SESSION_KEY = 'sidestory.comments.defaultSession';
const READ_KEY = 'sidestory.comments.read';
const WAIT_OFF_KEY = 'sidestory.comments.stopWaiting';
const GITATTR_OFFERED_KEY = 'sidestory.comments.gitattributesOffered';
const ANSWER_MS = 60_000;
const SLOW_MS = 120_000;

export const HOW_TO_URL = 'https://github.com/mozru/sidestory/blob/main/docs/GUIDE.md#comments-and-claude';

export class CommentService implements vscode.Disposable {
  readonly stateDir: string;
  readonly state: StateStore;
  private ready: Promise<void> | undefined;
  private readonly memento: vscode.Memento;
  private readonly repos = new Map<string, { root: vscode.Uri; files: ThreadFiles; key: string }>();
  private readonly cache = new Map<string, Map<string, Entry[]>>();
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];
  private pollTimer: ReturnType<typeof setInterval> | undefined;
  private changeTimer: ReturnType<typeof setTimeout> | undefined;
  private dirtyRoots = new Set<string>();
  /** For tests: the clock. */
  now: () => number = Date.now;

  constructor(memento: vscode.Memento) {
    this.memento = memento;
    const override = vscode.workspace.getConfiguration('sidestory.comments').get<string>('stateDir');
    this.stateDir = override && override.trim() ? override.trim() : defaultStateDir();
    this.state = new StateStore(this.stateDir);
    // Thread files arrive through a watcher on every .sidestory tree (§6.4), plus a backstop poll while sends are pending.
    const w = vscode.workspace.createFileSystemWatcher('**/.sidestory/**/threads/**');
    const on = (uri: vscode.Uri) => this.fileChanged(uri);
    this.subscriptions.push(w, w.onDidCreate(on), w.onDidChange(on), w.onDidDelete(on), this.emitter);
    this.pollTimer = setInterval(() => void this.backstop(), 2000);
  }

  dispose(): void {
    clearInterval(this.pollTimer);
    clearTimeout(this.changeTimer);
    for (const d of this.subscriptions) d.dispose();
  }

  /** Creates and checks the state directory, writes the profile and the pointer file, sweeps old records. */
  init(): Promise<void> {
    this.ready ??= (async () => {
      await ensureStateDir(this.stateDir);
      const def = defaultStateDir();
      if (this.stateDir !== def) {
        await ensureStateDir(def);
        await writeReplace(def, 'override.json', JSON.stringify({ stateDir: this.stateDir }));
      }
      await this.writeProfile();
      for (const d of ['sends', 'pushed', 'seen']) await sweepOld(join(this.stateDir, d), RECORD_MAX_AGE_MS);
    })().catch((e: unknown) => {
      log.error(`Comments: the state directory ${this.stateDir} can't be used: ${(e as Error).message}`);
      throw e;
    });
    return this.ready;
  }

  async writeProfile(): Promise<void> {
    const name = await this.authorName(vscode.workspace.workspaceFolders?.[0]?.uri);
    const flag = vscode.workspace.getConfiguration('sidestory.claude').get<string>('channelFlag') === 'channels' ? 'channels' : 'dev';
    await writeReplace(this.stateDir, 'profile.json', JSON.stringify({ v: 1, ...(name ? { name } : {}), channelFlag: flag }));
  }

  /** The name on the reader's comments (§5.1): the setting, else git's user.name (trusted only), else empty. */
  async authorName(at: vscode.Uri | undefined): Promise<string> {
    const set = vscode.workspace.getConfiguration('sidestory.comments').get<string>('authorName');
    if (set && cleanAuthorName(set)) return cleanAuthorName(set);
    if (!at) return '';
    return cleanAuthorName((await gitUserName(at)) ?? '');
  }

  repo(root: vscode.Uri): { root: vscode.Uri; files: ThreadFiles; key: string } {
    const k = root.fsPath;
    let r = this.repos.get(k);
    if (!r) {
      const key = repoKeyFor(root.fsPath);
      r = { root, files: new ThreadFiles(root.fsPath, new Ledger(this.stateDir, key)), key };
      this.repos.set(k, r);
    }
    return r;
  }

  private fileChanged(uri: vscode.Uri) {
    const parts = uri.path.split('/');
    const at = parts.lastIndexOf('.sidestory');
    if (at < 0) return;
    const root = uri.with({ path: parts.slice(0, at).join('/') });
    this.dirtyRoots.add(root.fsPath);
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.flush(), 300);
  }

  private flush() {
    for (const r of this.dirtyRoots) this.cache.delete(r);
    this.dirtyRoots.clear();
    this.emitter.fire();
  }

  /** Re-reads now (after this window wrote). */
  invalidate(root: vscode.Uri): void {
    this.cache.delete(root.fsPath);
    clearTimeout(this.changeTimer);
    this.changeTimer = setTimeout(() => this.flush(), 75);
  }

  private async backstop() {
    const sends = this.memento.get<Record<string, SendRecord>>(SENDS_KEY) ?? {};
    const pending = Object.values(sends).some((s) => s.send && this.now() - s.at < 30 * 60_000);
    if (!pending) return;
    // Delivery records live outside the repository: re-read the threads and recompute delivery states.
    for (const k of this.repos.keys()) this.cache.delete(k);
    this.emitter.fire();
  }

  /** Every thread under a repository root, by location. */
  async entries(root: vscode.Uri): Promise<Entry[]> {
    await this.init().catch(() => undefined);
    const r = this.repo(root);
    let byLoc = this.cache.get(root.fsPath);
    if (!byLoc) {
      byLoc = new Map();
      for (const location of await r.files.locations()) {
        const list: Entry[] = [];
        for (const { read, thread } of await r.files.readLocation(location, this.now())) if (thread) list.push({ root, files: r.files, location, thread, paths: read.paths });
        byLoc.set(locationKey(location), list);
      }
      this.cache.set(root.fsPath, byLoc);
    }
    return [...byLoc.values()].flat();
  }

  async findEntry(root: vscode.Uri, thread: string): Promise<Entry | undefined> {
    return (await this.entries(root)).find((e) => e.thread.id === thread);
  }

  /** Every thread in the workspace, across the roots that hold `.sidestory/`. */
  async allEntries(roots: readonly vscode.Uri[]): Promise<Entry[]> {
    const out: Entry[] = [];
    for (const r of roots) out.push(...(await this.entries(r)));
    return out;
  }

  // ---- writing ----

  private async write(root: vscode.Uri, location: Location, event: ThreadEvent): Promise<void> {
    const r = this.repo(root);
    if (location.tier === 'local' && vscode.workspace.isTrusted) {
      // The content check runs in ThreadFiles; in a trusted workspace git's own answer too (§3.1).
      const c = await r.files.checkLocalTier(true);
      if (c.ok) {
        const probe = vscode.Uri.file(join(root.fsPath, '.sidestory', '.local', 'x', 'threads', 't', 'e.json'));
        if ((await gitIgnores(probe)) === false) throw new Error("Local comments here wouldn't stay private: git doesn't ignore .sidestory/.local in this repository");
      }
    }
    await r.files.write(location, event, 'human');
    this.invalidate(root);
  }

  async createThread(root: vscode.Uri, location: Location, anchor: ThreadAnchor, body: string, opts: { toClaude: boolean; sidestoryId?: string }): Promise<{ thread: string; event: string }> {
    const head = vscode.workspace.isTrusted ? await gitHead(root) : {};
    const origin = location.tier === 'local' ? { ...(head.branch && /^[A-Za-z0-9._/-]{1,100}$/.test(head.branch) ? { branch: head.branch } : {}), ...(head.commit && /^[0-9a-f]{40}$/.test(head.commit) ? { head: head.commit } : {}), ...(opts.sidestoryId ? { sidestory: opts.sidestoryId } : {}) } : undefined;
    const thread = newId('t');
    const event: ThreadEvent = {
      v: 1,
      id: newId('e'),
      thread,
      type: 'open',
      at: new Date(this.now()).toISOString(),
      by: { kind: 'human', name: await this.authorName(root) },
      anchor,
      ...(origin && Object.keys(origin).length ? { origin } : {}),
      body: cleanBody(body),
      ...(opts.toClaude ? { to: 'claude' as const } : {}),
    };
    await this.write(root, location, event);
    return { thread, event: event.id };
  }

  async reply(e: Entry, body: string, toClaude: boolean): Promise<string> {
    const event: ThreadEvent = { v: 1, id: newId('e'), thread: e.thread.id, type: 'comment', at: new Date(this.now()).toISOString(), by: { kind: 'human', name: await this.authorName(e.root) }, body: cleanBody(body), ...(toClaude ? { to: 'claude' as const } : {}) };
    await this.write(e.root, e.location, event);
    return event.id;
  }

  /** Edit or retract one of the reader's own comments (the ledger says they wrote it). */
  async change(e: Entry, target: string, body: string | undefined): Promise<void> {
    const c = e.thread.comments.find((x) => x.id === target);
    if (!c || c.trust !== 'local_user') throw new Error('Only your own comments can be changed');
    const event: ThreadEvent = { v: 1, id: newId('e'), thread: e.thread.id, type: body === undefined ? 'retract' : 'edit', at: new Date(this.now()).toISOString(), by: c.by, target, ...(body !== undefined ? { body: cleanBody(body) } : {}) };
    await this.write(e.root, e.location, event);
  }

  async setState(e: Entry, type: 'resolve' | 'reopen'): Promise<void> {
    const event: ThreadEvent = { v: 1, id: newId('e'), thread: e.thread.id, type, at: new Date(this.now()).toISOString(), by: { kind: 'human', name: await this.authorName(e.root) } };
    await this.write(e.root, e.location, event);
  }

  /** Share (local → shared) or Make Local (§3.5). */
  async move(e: Entry, to: 'shared' | 'local'): Promise<boolean> {
    if (e.location.scope.kind !== 'sidestory') {
      void vscode.window.showInformationMessage("Code comments that no sidestory covers stay local in this version. Use Move to a Sidestory… first.");
      return false;
    }
    const target: Location = { tier: to, scope: e.location.scope };
    if (to === 'shared') {
      if (!(await this.ensureSharedName())) return false;
    } else {
      const dir = vscode.Uri.file(join(e.root.fsPath, ...threadsSegments(e.location), e.thread.id));
      const tracked = vscode.workspace.isTrusted ? await gitTracks(dir) : undefined;
      if (tracked !== false) {
        const go = 'Make Local';
        const msg = tracked ? 'This thread was committed: making it local removes it from the working tree, but it stays in git history.' : "Can't check whether git tracks this thread here (Restricted Mode). A committed thread stays in git history.";
        if ((await vscode.window.showWarningMessage(msg, { modal: true }, go)) !== go) return false;
      }
    }
    await e.files.move(e.thread.id, e.location, target);
    this.invalidate(e.root);
    if (to === 'shared') void this.offerGitattributes(e.root);
    return true;
  }

  /** The first Share asks once for a name when there's none (§5.1). */
  private async ensureSharedName(): Promise<boolean> {
    const cfg = vscode.workspace.getConfiguration('sidestory.comments');
    if (cleanAuthorName(cfg.get<string>('authorName') ?? '')) return true;
    if (await this.authorName(vscode.workspace.workspaceFolders?.[0]?.uri)) return true;
    const name = await vscode.window.showInputBox({ title: 'Name shown on your shared comments', prompt: 'Your earlier comments in this thread will show as Anonymous.', placeHolder: 'Alex Chen', validateInput: (v) => (v && !cleanAuthorName(v) ? 'Use a name, not an address' : undefined) });
    if (name === undefined) return true; // dismissed: Anonymous
    if (cleanAuthorName(name)) await cfg.update('authorName', cleanAuthorName(name), vscode.ConfigurationTarget.Global);
    await this.writeProfile();
    return true;
  }

  private async offerGitattributes(root: vscode.Uri) {
    const offered = this.memento.get<string[]>(GITATTR_OFFERED_KEY) ?? [];
    if (offered.includes(root.fsPath)) return;
    await this.memento.update(GITATTR_OFFERED_KEY, [...offered, root.fsPath]);
    const line = '.sidestory/**/threads/** linguist-generated=true';
    const file = vscode.Uri.joinPath(root, '.gitattributes');
    const text = await vscode.workspace.fs.readFile(file).then((b) => new TextDecoder().decode(b), () => '');
    if (text.includes(line)) return;
    const add = 'Add .gitattributes Entry';
    const choice = await vscode.window.showInformationMessage('Shared comment threads are committed with the sidestory. Collapse their files in GitHub pull requests?', add);
    if (choice !== add) return;
    await vscode.workspace.fs.writeFile(file, new TextEncoder().encode(`${text}${text && !text.endsWith('\n') ? '\n' : ''}${line}\n`));
  }

  async deleteThread(e: Entry): Promise<void> {
    if (e.location.tier !== 'local') throw new Error('Only local threads can be deleted');
    const del = 'Delete Thread';
    if ((await vscode.window.showWarningMessage('Delete this local thread and its comments?', { modal: true }, del)) !== del) return;
    await e.files.deleteThread(e.location, e.thread.id);
    this.invalidate(e.root);
  }

  // ---- Ask Claude (§9.4, §9.9) ----

  /** Live Claude Code sessions offered for this repository, confirmed first, then likely, then undetected. */
  async sessionsFor(root: vscode.Uri): Promise<Presence[]> {
    await this.init().catch(() => undefined);
    const key = this.repo(root).key;
    const rank = { confirmed: 0, likely: 1, unknown: 2 };
    return (await this.state.sessions())
      .filter((p) => p.client === 'claude-code' && liveness(p, this.now()) === 'live' && (p.repoKeys.includes(key) || servesPath(p.roots, root.fsPath)))
      .sort((a, b) => rank[a.channel] - rank[b.channel] || b.startedAt.localeCompare(a.startedAt));
  }

  /** The session a send in this thread would go to now (the button's label), or none. */
  async routeFor(root: vscode.Uri, thread?: string): Promise<{ route?: Presence; eligible: Presence[]; undetected: Presence[] }> {
    const all = await this.sessionsFor(root);
    const eligible = all.filter((p) => p.channel !== 'unknown');
    const undetected = all.filter((p) => p.channel === 'unknown');
    const threadSession = thread ? (this.memento.get<Record<string, string>>(THREAD_SESSION_KEY) ?? {})[thread] : undefined;
    const def = (this.memento.get<Record<string, string>>(DEFAULT_SESSION_KEY) ?? {})[this.repo(root).key];
    const route = eligible.find((p) => p.serverId === threadSession) ?? (eligible.length === 1 ? eligible[0] : eligible.find((p) => p.serverId === def));
    return { route, eligible, undetected };
  }

  async setDefaultSession(root: vscode.Uri, serverId: string): Promise<void> {
    const all = this.memento.get<Record<string, string>>(DEFAULT_SESSION_KEY) ?? {};
    await this.memento.update(DEFAULT_SESSION_KEY, { ...all, [this.repo(root).key]: serverId });
  }

  sessionLabel(p: Presence): string {
    return displayText(p.label, 80);
  }

  /** Lets the reader pick a session (native quick pick); remembers it as the repository's default. */
  async pickSession(root: vscode.Uri, includeUndetected: boolean): Promise<Presence | undefined> {
    const all = await this.sessionsFor(root);
    const list = includeUndetected ? all : all.filter((p) => p.channel !== 'unknown');
    if (!list.length) {
      void vscode.window.showInformationMessage("No Claude session with Sidestory's channel is running here.");
      return undefined;
    }
    const pick = await vscode.window.showQuickPick(
      list.map((p) => ({ label: this.sessionLabel(p).replace(/\$\(/g, '\\$('), description: p.channel === 'confirmed' ? 'channel confirmed' : p.channel === 'likely' ? 'channel on' : 'channel not detected', p })),
      { title: 'Ask Claude in which session?' },
    );
    if (pick) await this.setDefaultSession(root, pick.p.serverId);
    return pick?.p;
  }

  /**
   * Sends one of the reader's comments to Claude (§9.4): routes it, then writes the send. The event and its
   * ledger entry are already written. Returns the delivery record for the event.
   */
  async ask(e: Entry, eventId: string, text: string, intent: Intent, chosen?: Presence): Promise<void> {
    let route = chosen;
    if (!route) {
      const r = await this.routeFor(e.root, e.thread.id);
      route = r.route;
      if (!route && r.eligible.length > 1) route = await this.pickSession(e.root, false);
    }
    const sends = { ...(this.memento.get<Record<string, SendRecord>>(SENDS_KEY) ?? {}) };
    if (!route) {
      sends[eventId] = { at: this.now(), noSession: true };
      await this.memento.update(SENDS_KEY, sends);
      this.emitter.fire();
      return;
    }
    const a = e.thread.anchor;
    const sidestory = e.location.scope.kind === 'sidestory' ? e.location.scope.name : undefined;
    const head = vscode.workspace.isTrusted ? await gitHead(e.root) : {};
    const send: Send = {
      v: 1,
      send: newId('s'),
      event: eventId,
      thread: e.thread.id,
      root: canonical(e.root.fsPath),
      repoKey: this.repo(e.root).key,
      ...(sidestory ? { sidestory } : {}),
      tier: e.location.tier,
      text: cleanBody(text),
      intent: e.location.scope.kind === 'review' ? 'answer' : intent,
      mode: e.location.scope.kind === 'review' ? 'review' : head.branch ? 'branch' : 'file',
      ...(head.branch && /^[A-Za-z0-9._/-]{1,100}$/.test(head.branch) && !head.branch.includes('..') ? { branch: head.branch } : {}),
      ...(e.location.scope.kind === 'review' && a.kind === 'code' && a.commit ? { commit: a.commit } : {}),
      via: (await this.authorName(e.root)) || undefined,
      workspaceTrusted: vscode.workspace.isTrusted,
      target: targetOf(a),
      followUp: Math.max(0, e.thread.comments.filter((c) => c.id !== eventId && !c.retracted).length),
      route: route.serverId,
      at: new Date(this.now()).toISOString(),
    };
    if (!send.via) delete send.via;
    await this.state.writeSend(send);
    sends[eventId] = { send: send.send, route: route.serverId, at: this.now(), intent: send.intent };
    await this.memento.update(SENDS_KEY, sends);
    const ts = this.memento.get<Record<string, string>>(THREAD_SESSION_KEY) ?? {};
    await this.memento.update(THREAD_SESSION_KEY, { ...ts, [e.thread.id]: route.serverId });
    this.emitter.fire();
  }

  /** Cancels or retires a send through the `pushed/` arbiter: false when the server got there first. */
  async retire(eventId: string): Promise<boolean> {
    const rec = (this.memento.get<Record<string, SendRecord>>(SENDS_KEY) ?? {})[eventId];
    if (!rec?.send) return true;
    return this.state.claim(rec.send, { cancelled: true, by: 'extension', at: new Date(this.now()).toISOString() });
  }

  async markCopied(eventId: string): Promise<void> {
    const sends = { ...(this.memento.get<Record<string, SendRecord>>(SENDS_KEY) ?? {}) };
    sends[eventId] = { ...(sends[eventId] ?? { at: this.now() }), copied: true };
    await this.memento.update(SENDS_KEY, sends);
    this.emitter.fire();
  }

  /** Ask Claude in a shared thread warns once per thread (§3.5). */
  async warnSharedAsk(thread: string): Promise<boolean> {
    const key = 'sidestory.comments.sharedAskWarned';
    const warned = this.memento.get<string[]>(key) ?? [];
    if (warned.includes(thread)) return true;
    const ok = 'Ask Claude';
    if ((await vscode.window.showWarningMessage("Your question and Claude's answer will be committed with this sidestory.", { modal: true }, ok)) !== ok) return false;
    await this.memento.update(key, [...warned, thread].slice(-500));
    return true;
  }

  async stopWaiting(thread: string): Promise<void> {
    const off = this.memento.get<string[]>(WAIT_OFF_KEY) ?? [];
    if (!off.includes(thread)) await this.memento.update(WAIT_OFF_KEY, [...off, thread].slice(-500));
    this.emitter.fire();
  }

  isWaiting(e: Entry): boolean {
    return e.thread.waitingForClaude && !(this.memento.get<string[]>(WAIT_OFF_KEY) ?? []).includes(e.thread.id);
  }

  /** The delivery line for one of the reader's comments to Claude (§9.8), or undefined when there's none to show. */
  async delivery(e: Entry, eventId: string): Promise<DeliveryView | undefined> {
    const c = e.thread.comments.find((x) => x.id === eventId);
    if (!c || c.trust !== 'local_user' || c.to !== 'claude' || isAnswered(e.thread, eventId) || !this.isWaiting(e)) return undefined;
    const latestAsk = [...e.thread.comments].reverse().find((x) => x.trust === 'local_user' && x.to === 'claude' && !x.retracted);
    if (latestAsk?.id !== eventId) return undefined; // the delivery line is on the latest send
    const rec = (this.memento.get<Record<string, SendRecord>>(SENDS_KEY) ?? {})[eventId];
    const now = this.now();
    if (!rec) return { state: 'not-answered', text: 'Not answered', actions: ['sendAgain', 'copyPrompt', 'markAnswered', 'stopWaiting'] };
    if (rec.copied && !rec.send) return { state: 'copied', text: 'Prompt copied: paste it into Claude Code', actions: ['copyPrompt', 'sendAgain', 'markAnswered', 'stopWaiting'] };
    if (rec.noSession || !rec.send || !rec.route) {
      const { undetected } = await this.routeFor(e.root, e.thread.id);
      return { state: 'no-session', text: "No Claude session with Sidestory's channel is running here", actions: ['copyPrompt', ...(undetected.length ? (['chooseSession'] as const) : []), 'sendAgain', 'howTo'] };
    }
    const presence = await this.state.readPresence(rec.route);
    const label = presence ? this.sessionLabel(presence) : 'Claude session';
    const live = liveness(presence, now);
    const pushed = await this.state.pushed(rec.send);
    if (pushed && pushed !== 'pending' && 'cancelled' in pushed) return undefined;
    if (!pushed || pushed === 'pending') {
      if (now - rec.at > RECORD_MAX_AGE_MS) return { state: 'not-answered', text: 'Not answered', actions: ['sendAgain', 'copyPrompt'] };
      if (live === 'ended') return { state: 'session-ended', text: 'That session ended', actions: ['sendElsewhere', 'copyPrompt'] };
      if (live === 'not-responding') return { state: 'not-responding', text: "That session isn't responding", actions: ['copyPrompt'] };
      return { state: 'sending', text: 'Sending to Claude…', actions: [] };
    }
    const seen = await this.state.seen(rec.send);
    if (seen) {
      const since = Math.max(0, now - Date.parse(seen.at));
      const slow = since > (rec.intent === "edit" ? SLOW_MS : ANSWER_MS);
      return { state: 'working', text: `Claude is on it${slow ? ' · it may be waiting for your approval in its session' : ''}`, actions: slow ? ['copyPrompt', 'markAnswered'] : [], since };
    }
    if (live === 'ended') return { state: 'ended-before-answering', text: 'That session ended before answering', actions: ['sendElsewhere', 'copyPrompt'] };
    if (live === 'not-responding') return { state: 'not-responding', text: "That session isn't responding", actions: ['copyPrompt'] };
    if (now - Date.parse(pushed.at) > SLOW_MS) {
      if (presence?.channel === 'confirmed') return { state: 'busy', text: 'Delivered while Claude was busy; it may answer after its current turn', actions: ['sendAgain', 'copyPrompt', 'markAnswered'] };
      return { state: 'not-picked-up', text: "Not picked up yet: that session may not have Sidestory's channel on", actions: ['sendAgain', 'copyPrompt', 'markAnswered'] };
    }
    return { state: 'pushed', text: `Sent to Claude · ${label}`, actions: [] };
  }

  /** Copy Prompt for a thread's latest comment to Claude (or its first comment). */
  promptFor(e: Entry, intent: Intent = 'answer'): string {
    const a = e.thread.anchor;
    const ask = [...e.thread.comments].reverse().find((c) => c.trust === 'local_user' && c.to === 'claude' && !c.retracted) ?? e.thread.comments.find((c) => c.first)!;
    const info = {
      thread: e.thread.id,
      ...(e.location.scope.kind === 'sidestory' ? { sidestory: e.location.scope.name } : {}),
      ...(a.kind !== 'code' ? { step: a.step } : { file: a.file, lines: a.range, ...(a.commit ? { commit: a.commit } : {}) }),
    };
    return copyPrompt(info, ask.body, intent, e.location.scope.kind === 'review' ? 'review' : 'branch');
  }

  // ---- read state (workspaceState, never files) ----

  isUnread(e: Entry): boolean {
    const seen = (this.memento.get<Record<string, string>>(READ_KEY) ?? {})[e.thread.id];
    const newestOther = [...e.thread.comments].reverse().find((c) => c.trust !== 'local_user' && !c.retracted);
    return !!newestOther && (!seen || newestOther.id > seen);
  }

  async markRead(entries: readonly Entry[]): Promise<void> {
    const all = { ...(this.memento.get<Record<string, string>>(READ_KEY) ?? {}) };
    let changed = false;
    for (const e of entries) {
      const newest = e.thread.comments[e.thread.comments.length - 1]?.id;
      if (newest && all[e.thread.id] !== newest) {
        all[e.thread.id] = newest;
        changed = true;
      }
    }
    if (!changed) return;
    const keys = Object.keys(all);
    for (const k of keys.slice(0, Math.max(0, keys.length - 5000))) delete all[k];
    await this.memento.update(READ_KEY, all);
    this.emitter.fire();
  }

  /** Whether the reader took part (a local_user event) — "threads you took part in". */
  tookPart(e: Entry): boolean {
    return e.thread.comments.some((c) => c.trust === 'local_user');
  }

  report(e: unknown, what: string): void {
    log.error(`Comments: ${what} failed: ${(e as Error).message}`);
    void vscode.window.showErrorMessage(`Couldn't ${what}: ${plainForMessage((e as Error).message)}`);
  }
}

export function targetOf(a: ThreadAnchor): Send['target'] {
  if (a.kind === 'code') return { ...(isPlainPath(a.file) ? { file: a.file } : {}), lines: a.range, side: a.side };
  return { step: a.step };
}

export function codeAnchorLabel(a: CodeAnchor): string {
  return `${a.file}:${a.range[0]}${a.range[1] !== a.range[0] ? `–${a.range[1]}` : ''}`;
}
