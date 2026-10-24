// Texts the comments commands copy or show (docs/COMMENTS-PLAN.md §9.2, §10.1, §10.2).
import * as vscode from 'vscode';
import { claudeCommand } from '../../core/threads/prompt.ts';
import { authorLabel } from '../../core/threads/reduce.ts';
import { stripJoiners } from '../../core/threads/markdown.ts';
import type { Entry } from './service.ts';
import { codeAnchorLabel, HOW_TO_URL } from './service.ts';

export function claudeCommandText(): string {
  const flag = vscode.workspace.getConfiguration('sidestory.claude').get<string>('channelFlag') === 'channels' ? 'channels' : 'dev';
  return claudeCommand(flag);
}

/** Copy Thread as Markdown: who wrote what, plain text (joiners stripped so pasted URLs work). */
export function copyThreadMarkdown(e: Entry): string {
  const a = e.thread.anchor;
  const where = a.kind === 'code' ? `\`${codeAnchorLabel(a)}\`` : `${e.location.scope.kind === 'sidestory' ? e.location.scope.name : ''} › ${a.step}`;
  const lines = [`**Thread on ${where}** (${e.thread.state})`, ''];
  for (const c of e.thread.comments) {
    if (c.retracted) continue;
    lines.push(`**${authorLabel(c)}**${c.trust === 'repository' ? ' (from the repository)' : ''}:`, '', stripJoiners(c.body), '');
  }
  return lines.join('\n');
}

export async function showHowTo(): Promise<void> {
  const copy = 'Copy Claude Command';
  const guide = 'Open the Guide';
  const choice = await vscode.window.showInformationMessage(
    "Ask Claude sends your comment to a Claude Code session started with Sidestory's channel. Install the plugin with /plugin install sidestory-comments@sidestory, then start Claude Code in this folder's terminal with the copied command.",
    copy,
    guide,
  );
  if (choice === copy) {
    await vscode.env.clipboard.writeText(claudeCommandText());
    vscode.window.setStatusBarMessage('Claude command copied', 3000);
  } else if (choice === guide) await vscode.env.openExternal(vscode.Uri.parse(HOW_TO_URL));
}
