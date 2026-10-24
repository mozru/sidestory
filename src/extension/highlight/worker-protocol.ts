// Messages between the extension host and the highlight worker.
import type { HighlightStyle } from '../../shared/highlight-languages.ts';
import type { GrammarSet } from './catalog.ts';
import type { HighlightTheme } from './theme.ts';
import type { EngineName } from './tokenize.ts';

export type WorkerRequest =
  /** Load (and warm) a scope's grammar from the files the host read. `theme`, when present, is loaded first. */
  | { id: number; type: 'load'; scope: string; set: GrammarSet; theme?: HighlightTheme }
  | { id: number; type: 'tokenize'; scope: string; code: string; themeKey: string; theme?: HighlightTheme };

export type WorkerReply =
  | {
    id: number;
    ok: true;
    runs?: number[] | null;
    palette?: HighlightStyle[];
    /** The grammar isn't loaded in this worker. */
    cold?: boolean;
    /** `load`: whether the grammar loaded, and the regex engine in use. */
    loaded?: boolean;
    engine?: EngineName;
    /** `load`: why VS Code's wasm wasn't used, when it wasn't. */
    engineNote?: string;
  }
  | { id: number; ok: false; error: string };
