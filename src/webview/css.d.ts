// CSS imported as text (bundled by esbuild's text loader).
declare module '*.css' {
  const text: string;
  export default text;
}
