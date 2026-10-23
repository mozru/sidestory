// Sucrase's TokenProcessor module, which its package doesn't type at this path (analyze.ts reads the token a
// transformer error was thrown at).
declare module 'sucrase/dist/TokenProcessor.js' {
  const TokenProcessor: unknown;
  export default TokenProcessor;
}
