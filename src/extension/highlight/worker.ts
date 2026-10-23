// The highlight worker (dist/highlight-worker.cjs): tokenizes explainer code blocks off the extension host's
// thread, so a slow grammar on hostile input can be cut off by terminating it (docs/HIGHLIGHT-PLAN.md §5).
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import type { LanguageRegistration } from '@shikijs/core';
import { EMBEDDED_GRAMMARS, HIGHLIGHT_LANGS } from '../../shared/highlight-languages.ts';
import { grammarsFor } from './grammars.ts';
import { Tokenizer } from './tokenize.ts';
import type { WorkerReply, WorkerRequest } from './worker-protocol.ts';

const SHIPPED = new Set<string>([...HIGHLIGHT_LANGS, ...EMBEDDED_GRAMMARS]);
const dir = (workerData as { grammarDir: string }).grammarDir;

const tokenizer = new Tokenizer((name) => {
  // Only fixed names reach a file name.
  if (!SHIPPED.has(name)) return undefined;
  try {
    return JSON.parse(readFileSync(join(dir, `${name}.json`), 'utf8')) as LanguageRegistration;
  } catch {
    return undefined;
  }
});

parentPort!.on('message', (m: WorkerRequest) => {
  let reply: WorkerReply;
  try {
    if (m.theme) tokenizer.setTheme(m.theme);
    if (m.type === 'load') {
      tokenizer.load(m.langs);
      reply = { id: m.id, ok: true };
    } else if (!tokenizer.isWarm(grammarsFor(m.lang, m.code)) || !tokenizer.hasTheme(m.themeKey)) {
      reply = { id: m.id, ok: true, cold: true };
    } else {
      const r = tokenizer.tokenize(m.code, m.lang, m.themeKey);
      reply = { id: m.id, ok: true, runs: r?.runs ?? null, palette: tokenizer.palette(m.themeKey) };
    }
  } catch (e) {
    reply = { id: m.id, ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
  }
  parentPort!.postMessage(reply);
});
