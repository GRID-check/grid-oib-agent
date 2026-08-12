/**
 * The MCP binding.
 *
 * Thin on purpose: everything the tools DO lives in `tools.ts`, which imports
 * no protocol. This file only translates between that and MCP's request shapes,
 * so a host embedding the library directly and an agent talking to the server
 * get identical answers rather than two implementations that drift.
 *
 * ## The low-level `Server`, not `McpServer`
 *
 * `McpServer.registerTool` wants a Zod shape and derives JSON Schema from it.
 * Our tool definitions already ARE JSON Schema, hand-written so the description
 * text — which is the part that decides whether an agent reaches for the right
 * operator — can be authored directly rather than squeezed through `.describe()`
 * calls. Handing that schema over unchanged keeps one source for it.
 *
 * ## What this server deliberately does not do
 *
 * No authentication, no tenancy, no rate limiting. A host that exposes it to
 * more than one customer's models owns those, and putting a half-measure here
 * would invite someone to trust it. The unit of isolation is the process: it
 * holds only the models it was handed.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { GraphCache } from '../cache.js'
import { createTools, type ToolDef } from './tools.js'

export interface ServerOptions {
  /** Share a cache across servers, or let each own one. */
  cache?: GraphCache
  name?: string
  version?: string
}

export function createSpatialServer(options: ServerOptions = {}): { server: Server; tools: ToolDef[] } {
  const cache = options.cache ?? new GraphCache()
  const tools = createTools(cache)
  const byName = new Map(tools.map((tool) => [tool.name, tool]))

  const server = new Server(
    { name: options.name ?? 'ifc-spatial', version: options.version ?? '0.1.0' },
    { capabilities: { tools: {} } }
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = byName.get(request.params.name)
    if (!tool) {
      return errorResult(`Unbekanntes Werkzeug "${request.params.name}". Verfügbar: ${[...byName.keys()].join(', ')}`)
    }
    try {
      const result = await tool.handler((request.params.arguments ?? {}) as Record<string, unknown>)
      return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
    } catch (error) {
      // `isError` rather than a thrown protocol error: the model has to SEE the
      // reason to correct itself, and a transport-level failure is reported to
      // the host instead. A wrong GlobalId is a fixable mistake, not an outage.
      return errorResult(error instanceof Error ? error.message : String(error))
    }
  })

  return { server, tools }
}

function errorResult(message: string) {
  return { content: [{ type: 'text' as const, text: message }], isError: true }
}
