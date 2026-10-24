// Stands in for the MCP SDK's Ajv validator in the server bundle (scripts/mcp-build.mjs): the SDK's server uses it
// only to check what a client sends back for elicitation, which this server never asks for. Keeps Ajv (about
// 70 KB minified) out of the bundle. Tool inputs are validated with zod in server.ts.
export class AjvJsonSchemaValidator {
  getValidator(): (input: unknown) => { valid: false; data: undefined; errorMessage: string } {
    return () => ({ valid: false, data: undefined, errorMessage: 'not supported by this server' });
  }
}
