// One file watcher for everything under `.sidestory/` folders (docs/NAVIGATION-PLAN.md §6.4), shared by the
// widget host and the workspace index. Each event is parsed once into the sidestory it belongs to.
import * as vscode from 'vscode';
import type { ExplainerRef } from '../explainers.ts';
import { refFromDir } from '../explainers.ts';

export type WatchKind = 'change' | 'create' | 'delete';

export interface SidestoryEvent {
  kind: WatchKind;
  uri: vscode.Uri;
  /** The sidestory the path is in (or is), when it is laid out as one. */
  ref?: ExplainerRef;
  /** The path inside the sidestory folder ('' for the folder itself). */
  rel: string;
  /** The path is a Sidestory folder itself (`<root>/.sidestory`). */
  sidestoryFolder?: boolean;
}

/** Parses `<root>/.sidestory/<name>/<rel>`: the last `.sidestory` segment counts. */
export function parseSidestoryPath(uri: vscode.Uri): Omit<SidestoryEvent, 'kind'> | undefined {
  const parts = uri.path.split('/');
  const at = parts.lastIndexOf('.sidestory');
  if (at < 0) return undefined;
  if (at === parts.length - 1) return { uri, rel: '', sidestoryFolder: true };
  const dir = uri.with({ path: parts.slice(0, at + 2).join('/') });
  const ref = refFromDir(dir);
  if (!ref) return undefined;
  return { uri, ref, rel: parts.slice(at + 2).join('/') };
}

export class SidestoryWatcher implements vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<SidestoryEvent>();
  readonly onDidChange = this.emitter.event;
  private readonly subscriptions: vscode.Disposable[] = [];

  constructor() {
    const w = vscode.workspace.createFileSystemWatcher('**/.sidestory/**');
    const on = (kind: WatchKind) => (uri: vscode.Uri) => {
      const parsed = parseSidestoryPath(uri);
      if (parsed) this.emitter.fire({ kind, ...parsed });
    };
    this.subscriptions.push(w, w.onDidChange(on('change')), w.onDidCreate(on('create')), w.onDidDelete(on('delete')), this.emitter);
  }

  dispose(): void {
    for (const d of this.subscriptions) d.dispose();
  }
}
