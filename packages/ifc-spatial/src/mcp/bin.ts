#!/usr/bin/env node
/**
 * `ifc-spatial-mcp` — the server over stdio.
 *
 * Stdio is the transport a desktop MCP client speaks, and it has one rule that
 * costs an afternoon when broken: **stdout belongs to the protocol**. The
 * parser this library sits on logs its phase timings, so anything it writes
 * would land in the middle of a JSON-RPC frame and the client would report a
 * malformed message rather than a noisy one. `console.log` is therefore
 * redirected to stderr for the life of the process, before anything is loaded
 * that might use it.
 */

export {}

console.log = console.info = console.debug = (...args: unknown[]) => {
  process.stderr.write(args.map(String).join(' ') + '\n')
}

const { StdioServerTransport } = await import('@modelcontextprotocol/sdk/server/stdio.js')
const { createSpatialServer } = await import('./server.js')

const { server } = createSpatialServer()
await server.connect(new StdioServerTransport())
process.stderr.write('ifc-spatial MCP server bereit (stdio)\n')
