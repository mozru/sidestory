// Comments in VS Code (docs/COMMENTS-PLAN.md §6, §7, §10, §11): wires the service, the panel host, the editor's
// Comments API controller, the Comments view and the commands. extension.ts calls `activateComments` once.
import * as vscode from 'vscode';
import { join } from 'node:path';
import { ANSWER_WAITING_PROMPT } from '../../core/threads/prompt.ts';
import { mkdirsNoFollow, readSmall, writeReplace } from '../../comments/fsx.ts';
import type { CommentsFromWebview } from '../../shared/comments-protocol.ts';
import type { ExplainerRef } from '../explainers.ts';
import type { SidestoryIndex } from '../nav/index.ts';
import { claudeCommandText, showHowTo } from './commands-text.ts';
import { CommentsController } from './controller.ts';
import { CommentsPanels, threadAction, type CommentsSession } from './panel.ts';
import { CommentService } from './service.ts';
import { CommentsView, type CommentNode } from './view.ts';

export interface CommentsDeps {
  index: SidestoryIndex;
  /** Open sessions that can show comments. */
  sessions(): CommentsSession[];
  current(): CommentsSession | undefined;
  openAt(args: { dir: string; anchor?: string; source?: string }): Promise<unknown>;
  openCode(root: vscode.Uri, file: string, lines?: [number, number]): Promise<void>;
}

export interface CommentsApi {
  commands: Record<string, (...args: unknown[]) => unknown>;
  /** For SessionHost: a message from the panel, the page's init, a new session. */
  handle(s: CommentsSession, m: CommentsFromWebview): boolean;
  onInit(s: CommentsSession): void;
  attach(s: CommentsSession): vscode.Disposable;
}

export function activateComments(context: vscode.ExtensionContext, deps: CommentsDeps): CommentsApi {
  const service = new CommentService(context.workspaceState);
  const panels = new CommentsPanels(service, { openCode: deps.openCode });
  const controller = new CommentsController(service, deps.index, context.extensionUri);
  const view = new CommentsView(service, deps.index);
  const tree = vscode.window.createTreeView('sidestory.comments', { treeDataProvider: view, showCollapseAll: true });
  view.view = tree;
  context.subscriptions.push(service, panels, controller, view, tree);
  void service.init().then(() => writeLauncher(context, service.stateDir)).catch(() => undefined);
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('sidestory.comments.authorName') || e.affectsConfiguration('sidestory.claude.channelFlag')) void service.writeProfile().catch(() => undefined);
      if (e.affectsConfiguration('sidestory.comments')) void controller.refresh();
    }),
  );

  const sessionFor = (dir: string) => deps.sessions().find((s) => s.ref.dir.toString() === dir);

  const openThread = async (node?: unknown) => {
    const n = node as CommentNode | undefined;
    if (!n || n.kind !== 'thread') return;
    const e = n.entry;
    const a = e.thread.anchor;
    if (a.kind === 'code') {
      await controller.reveal(e.root, e.thread.id);
      return;
    }
    if (e.location.scope.kind !== 'sidestory') return;
    const dir = vscode.Uri.joinPath(e.root, '.sidestory', e.location.scope.name).toString();
    await deps.openAt({ dir, anchor: a.step, source: 'comments' });
    const s = sessionFor(dir);
    if (s) panels.show(s, { type: 'commentsShow', step: a.step, thread: e.thread.id });
  };

  const threadNode = (n: unknown) => (n && typeof n === 'object' && (n as CommentNode).kind === 'thread' ? (n as Extract<CommentNode, { kind: 'thread' }>) : undefined);

  const viewAction = (action: 'resolve' | 'reopen' | 'share' | 'local' | 'delete' | 'copyPrompt') => async (n?: unknown) => {
    const t = threadNode(n);
    if (t) await threadAction(service, t.entry, action, { openCode: deps.openCode }).catch((e: unknown) => service.report(e, 'update the thread'));
  };

  const commands: Record<string, (...args: unknown[]) => unknown> = {
    'sidestory.commentOnSelection': () => controller.commentOnSelection(false),
    'sidestory.askClaudeAboutSelection': () => controller.commentOnSelection(true),
    'sidestory.comments.show': async () => {
      const s = deps.current();
      if (s) panels.show(s, { type: 'commentsShow' });
      else await vscode.commands.executeCommand('sidestory.comments.focus');
    },
    'sidestory.comments.copyClaudeCommand': async () => {
      await vscode.env.clipboard.writeText(claudeCommandText());
      void vscode.window.showInformationMessage("Copied. Run it in this folder's terminal to start Claude Code with Sidestory's channel and its comment tools allowed. Install the plugin first: /plugin install sidestory-comments@sidestory");
    },
    'sidestory.comments.copyMcpConfig': async () => {
      const launcher = join(service.stateDir, 'bin', 'sidestory-mcp.cjs');
      const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '<workspace>';
      const json = JSON.stringify({ mcpServers: { sidestory: { command: 'node', args: [launcher, '--project', folder] } } }, null, 2);
      await vscode.env.clipboard.writeText(json);
      void vscode.window.showInformationMessage('Copied an MCP server config for Sidestory comments (Cursor: .cursor/mcp.json; Codex: the same command and args under [mcp_servers.sidestory]).');
    },
    'sidestory.comments.howTo': () => showHowTo(),
    'sidestory.comments.openThread': openThread,
    'sidestory.comments.refresh': () => view.rebuild(),
    'sidestory.comments.filter': async () => {
      const text = await vscode.window.showInputBox({ title: 'Filter Comments', value: view.filter, prompt: 'Matches targets, authors and text' });
      if (text !== undefined) {
        view.filter = text;
        await view.rebuild();
      }
    },
    'sidestory.comments.markAllRead': async () => service.markRead(view.nodes().flatMap((n) => (n.kind === 'thread' ? [n.entry] : []))),
    'sidestory.comments.copyWaitingPrompt': async () => {
      await vscode.env.clipboard.writeText(ANSWER_WAITING_PROMPT);
      vscode.window.setStatusBarMessage('Prompt copied: paste it into Claude Code', 4000);
    },
    'sidestory.comments.view.copyPrompt': viewAction('copyPrompt'),
    'sidestory.comments.view.resolve': viewAction('resolve'),
    'sidestory.comments.view.reopen': viewAction('reopen'),
    'sidestory.comments.view.share': viewAction('share'),
    'sidestory.comments.view.makeLocal': viewAction('local'),
    'sidestory.comments.view.delete': viewAction('delete'),
    'sidestory.comments.view.stopWaiting': async (n?: unknown) => {
      const t = threadNode(n);
      if (t) await service.stopWaiting(t.entry.thread.id);
    },
    'sidestory.nextComment': () => stepComment(1),
    'sidestory.previousComment': () => stepComment(-1),
    // The editor's Comments API (§7.1).
    'sidestory.comments.reply': (r?: unknown) => controller.reply(r as vscode.CommentReply, false).catch((e: unknown) => service.report(e, 'comment')),
    'sidestory.comments.replyAsk': (r?: unknown) => controller.reply(r as vscode.CommentReply, true).catch((e: unknown) => service.report(e, 'ask Claude')),
    'sidestory.comments.replyAskEdit': (r?: unknown) => controller.reply(r as vscode.CommentReply, true, 'edit').catch((e: unknown) => service.report(e, 'ask Claude')),
    'sidestory.comments.resolve': (t?: unknown) => controller.threadCommand(t as vscode.CommentThread, 'resolve', deps),
    'sidestory.comments.reopen': (t?: unknown) => controller.threadCommand(t as vscode.CommentThread, 'reopen', deps),
    'sidestory.comments.share': (t?: unknown) => controller.threadCommand(t as vscode.CommentThread, 'share', deps),
    'sidestory.comments.makeLocal': (t?: unknown) => controller.threadCommand(t as vscode.CommentThread, 'local', deps),
    'sidestory.comments.copyPrompt': (t?: unknown) => controller.threadCommand(t as vscode.CommentThread, 'copyPrompt', deps),
    'sidestory.comments.deleteThread': (t?: unknown) => controller.threadCommand(t as vscode.CommentThread, 'delete', deps),
    'sidestory.comments.editComment': (c?: unknown) => controller.commentCommand(c as vscode.Comment, 'edit'),
    'sidestory.comments.saveComment': (c?: unknown) => controller.commentCommand(c as vscode.Comment, 'save'),
    'sidestory.comments.cancelEdit': (c?: unknown) => controller.commentCommand(c as vscode.Comment, 'cancel'),
    'sidestory.comments.deleteComment': (c?: unknown) => controller.commentCommand(c as vscode.Comment, 'delete'),
    'sidestory.comments.sendAgain': (c?: unknown) => controller.commentCommand(c as vscode.Comment, 'sendAgain'),
  };

  const stepComment = async (delta: 1 | -1) => {
    await view.rebuild();
    const list = [...view.nodes('forYou'), ...view.nodes('open')];
    if (!list.length) {
      vscode.window.setStatusBarMessage('No comment threads for you', 3000);
      return;
    }
    const i = Math.max(0, Math.min(list.length - 1, delta === 1 ? 0 : list.length - 1));
    await openThread(list[i]);
  };

  return {
    commands,
    handle: (s, m) => panels.handle(s, m),
    onInit: (s) => panels.onInit(s),
    attach: (s) => panels.attach(s),
  };
}

/**
 * `<state>/bin/sidestory-mcp.cjs` for Codex, Cursor and other MCP clients (§10.2): requires the newest recorded
 * dist/mcp.cjs that still exists, so several installs (stable, Insiders, remote) don't overwrite each other.
 */
async function writeLauncher(context: vscode.ExtensionContext, state: string): Promise<void> {
  const bin = await mkdirsNoFollow(state, ['bin'], 0o700);
  const self = join(context.extensionUri.fsPath, 'dist', 'mcp.cjs');
  const version = String((context.extension.packageJSON as { version?: unknown }).version ?? '0');
  let installs: { path: string; version: string }[] = [];
  try {
    installs = JSON.parse((await readSmall(join(bin, 'installs.json'), 100_000)) ?? '[]') as typeof installs;
  } catch {
    installs = [];
  }
  installs = [...installs.filter((i) => i && typeof i.path === 'string' && i.path !== self), { path: self, version }].slice(-20);
  await writeReplace(bin, 'installs.json', JSON.stringify(installs, null, 2));
  const launcher = `// Sidestory comments MCP server launcher, written by the Sidestory VS Code extension.
const fs = require('fs'), path = require('path');
const cmp = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0); return 0; };
let list = [];
try { list = JSON.parse(fs.readFileSync(path.join(__dirname, 'installs.json'), 'utf8')); } catch {}
const ok = list.filter((i) => i && typeof i.path === 'string' && fs.existsSync(i.path)).sort((a, b) => cmp(String(b.version), String(a.version)));
if (!ok.length) { process.stderr.write('Sidestory comments: no installed Sidestory extension found; open VS Code with Sidestory once.\\n'); process.exit(1); }
require(ok[0].path);
`;
  await writeReplace(bin, 'sidestory-mcp.cjs', launcher, 0o644);
}

export type { ExplainerRef };
