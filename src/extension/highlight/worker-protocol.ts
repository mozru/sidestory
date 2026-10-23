// Messages between the extension host and the highlight worker.
import type { HighlightLang, HighlightStyle } from '../../shared/highlight-languages.ts';
import type { HighlightTheme } from './theme.ts';

export type WorkerRequest =
  /** Load (and warm) grammars. `theme`, when present, is loaded first. */
  | { id: number; type: 'load'; langs: HighlightLang[]; theme?: HighlightTheme }
  | { id: number; type: 'tokenize'; lang: HighlightLang; code: string; themeKey: string; theme?: HighlightTheme };

export type WorkerReply =
  | { id: number; ok: true; runs?: number[] | null; palette?: HighlightStyle[]; /** The grammars aren't loaded in this worker. */ cold?: boolean }
  | { id: number; ok: false; error: string };
