// Small helpers shared by the host and the worker (no vscode-textmate here: the host imports this without
// loading the tokenizer).

export function countLines(s: string): number {
  let n = 1;
  for (let i = s.indexOf('\n'); i >= 0; i = s.indexOf('\n', i + 1)) n++;
  return n;
}
