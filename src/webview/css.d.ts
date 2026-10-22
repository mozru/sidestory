// CSS imported as text (bundled by esbuild's text loader).
declare module '*.css' {
  const text: string;
  export default text;
}

/** `sha256-…` of the widget bootstrap, defined at build time (scripts/build.mjs). */
declare const __CX_BOOTSTRAP_HASH__: string;
