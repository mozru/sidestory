// docs/COMMENTS-PLAN.md §9.8: the extension's delivery states, Stop Waiting, Send Again and retiring through the arbiter.
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('vscode', () => import('./vscode-stub.ts'));
const vscode = await import('./vscode-stub.ts');
const { CommentService } = await import('../../src/extension/comments/service.ts');
const { StateStore } = await import('../../src/comments/delivery.ts');
const { newId } = await import('../../src/comments/fsx.ts');

class Memento {
  private m = new Map<string, unknown>();
  get<T>(k: string): T | undefined {
    return this.m.get(k) as T | undefined;
  }
  async update(k: string, v: unknown) {
    this.m.set(k, v);
  }
  keys() {
    return [...this.m.keys()];
  }
}

let tmp: string;
let root: import("vscode").Uri;
let svc: InstanceType<typeof CommentService>;
let state: InstanceType<typeof StateStore>;

beforeEach(async () => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), 'cx-svc-')));
  mkdirSync(join(tmp, 'repo/.sidestory/retry'), { recursive: true });
  process.env.SIDESTORY_STATE_DIR = join(tmp, 'state');
  root = vscode.Uri.file(join(tmp, "repo")) as unknown as import("vscode").Uri;
  svc = new CommentService(new Memento() as never);
  await svc.init();
  state = new StateStore(svc.stateDir);
});
afterEach(() => {
  svc.dispose();
  delete process.env.SIDESTORY_STATE_DIR;
  rmSync(tmp, { recursive: true, force: true });
});

async function presence(channel: 'likely' | 'confirmed' | 'unknown', heartbeatAgo = 0) {
  const serverId = newId('srv');
  const now = Date.now();
  await state.writePresence({ v: 1, serverId, pid: 1, startedAt: new Date(now - 60_000).toISOString(), heartbeatAt: new Date(now - heartbeatAgo).toISOString(), roots: [root.fsPath], repoKeys: [svc.repo(root).key], channel, client: 'claude-code', label: 'repo · 14:01' });
  return serverId;
}

async function asked(intent: 'answer' | 'edit' = 'answer') {
  const { thread, event } = await svc.createThread(root, { tier: 'local', scope: { kind: 'sidestory', name: 'retry' } }, { kind: 'step', step: 'delay' }, 'Why?', { toClaude: true });
  const e = (await svc.findEntry(root, thread))!;
  await svc.ask(e, event, 'Why?', intent);
  return { e: (await svc.findEntry(root, thread))!, event };
}

describe('delivery states', () => {
  it('no session: the No session line with Copy Prompt', async () => {
    const { e, event } = await asked();
    expect(await svc.delivery(e, event)).toMatchObject({ state: 'no-session', actions: expect.arrayContaining(['copyPrompt', 'howTo']) });
  });

  it('routes to the one likely session, then Pushed, Working, and nothing once answered', async () => {
    const srv = await presence('likely');
    const { e, event } = await asked();
    const sends = await state.sendIds();
    expect(sends).toHaveLength(1);
    expect((await state.readSend(sends[0]!))!.route).toBe(srv);
    expect((await svc.delivery(e, event))!.state).toBe('sending');
    await state.claim(sends[0]!, { at: new Date().toISOString(), serverId: srv, nonce: 'ABCDEFGHIJKLMNOP' });
    expect(await svc.delivery(e, event)).toMatchObject({ state: 'pushed', text: 'Sent to Claude · repo · 14:01' });
    await state.markSeen(sends[0]!);
    expect((await svc.delivery(e, event))!.state).toBe('working');
  });

  it('an undetected session is never chosen by itself', async () => {
    await presence('unknown');
    const { e, event } = await asked();
    expect(await state.sendIds()).toHaveLength(0);
    expect((await svc.delivery(e, event))!.actions).toContain('chooseSession');
  });

  it('ended before answering: Send to Another Session retires the claimed send', async () => {
    const srv = await presence('likely');
    const { e, event } = await asked('edit');
    const [send] = await state.sendIds();
    await state.claim(send!, { at: new Date().toISOString(), serverId: srv, nonce: 'ABCDEFGHIJKLMNOP' });
    await presence('likely'); // another session, live
    await state.writePresence({ ...(await state.readPresence(srv))!, heartbeatAt: new Date(Date.now() - 600_000).toISOString() });
    expect((await svc.delivery(e, event))!.state).toBe('ended-before-answering');
    expect(await svc.retire(event)).toBe(true);
    expect(svc.intentOf(event)).toBe('edit');
  });

  it('a live server that claimed the send keeps it: no second push', async () => {
    const srv = await presence('likely');
    const { event } = await asked();
    const [send] = await state.sendIds();
    await state.claim(send!, { at: new Date().toISOString(), serverId: srv, nonce: 'ABCDEFGHIJKLMNOP' });
    expect(await svc.retire(event)).toBe(false);
  });

  it('Stop Waiting covers the latest ask only; a later ask waits again', async () => {
    const { e, event } = await asked();
    expect(svc.isWaiting(e)).toBe(true);
    await svc.stopWaiting(e);
    expect(svc.isWaiting(e)).toBe(false);
    expect(await svc.delivery(e, event)).toBeUndefined();
    await svc.reply(e, 'And another thing?', true);
    const again = (await svc.findEntry(root, e.thread.id))!;
    expect(svc.isWaiting(again)).toBe(true);
  });
});
