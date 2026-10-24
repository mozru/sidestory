// The one way new code turns a URI into a path on disk (docs/CHANGES-PLAN.md §15): only a `file:` URI has one. A
// remote, virtual or git URI's `fsPath` is a made-up local path that node:fs would happily read or write, so this
// throws for any other scheme. test/unit/fs-path.test.ts keeps other `.fsPath` uses to a reviewed allowlist.
import type * as vscode from 'vscode';

export function localPath(uri: vscode.Uri): string {
  if (uri.scheme !== 'file') throw new Error(`Not a file on this machine (${uri.scheme}:)`);
  return uri.fsPath;
}
