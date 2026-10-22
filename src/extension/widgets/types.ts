// Types shared by the widget compiler's host side (compile.ts) and its worker (compile-worker.ts).

/** A compile problem. `file` is relative to the explainer folder; line and column are 1-based. */
export interface Diag {
  file: string;
  line?: number;
  column?: number;
  message: string;
  code: string;
}

export interface CompileResult {
  /** The entry module's key in `modules` (the normalized `src`). */
  entry: string;
  /**
   * Relative path → CommonJS code, run by the widget runtime with (require, module, exports).
   * Relative imports are rewritten to these keys, and aliases (`framer-motion`, `d3-scale`, …) to the
   * specifier the library registers, so `require(x)` takes either a key of `modules` or a library specifier.
   */
  modules: Record<string, string>;
  /** Library ids in load order (dependencies first), always ending with 'tailwind', 'runtime'. */
  libraries: string[];
  /** lucide-react exports the widget imports (names as imported, aliases included) → icon data for lucide's createLucideIcon. */
  icons: Record<string, unknown>;
  warnings: Diag[];
  errors: Diag[];
  /** SHA-256 (hex) over every file read (the import closure), by path; '' when nothing was read. */
  hash: string;
  /** Relative paths read, sorted. */
  files: string[];
}

export interface CompileRequest {
  id: number;
  explainerDir: string;
  src: string;
}

export type WorkerReply = { id: number; result: CompileResult } | { id: number; failure: string };
