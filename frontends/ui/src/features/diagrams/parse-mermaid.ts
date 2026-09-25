/**
 * A mermaid source, read by mermaid's own parser, as a typed model.
 *
 * Mermaid is the parser here and nothing else (`docs/design/answer-visuals.md`):
 * `getDiagramFromText` fills the grammar's database, `model.ts` reads it, and
 * this product draws the result. Loaded on demand like the renderer, and
 * queued behind the same lock, because the database is a module-level
 * singleton per grammar and a render in flight would read a half-parsed one.
 *
 * Returns null for a source the parser refuses and for a grammar this product
 * has no view for; the caller then falls back to mermaid's SVG.
 */

import { modelFromParsed, type DiagramModel } from './model'
import { withMermaid } from './render-diagram'

interface MermaidParserApi {
  initialize: (config: Record<string, unknown>) => void
  mermaidAPI: {
    getDiagramFromText: (text: string) => Promise<{ type: string; db: Record<string, unknown> }>
  }
}

export async function parseMermaid(source: string): Promise<DiagramModel | null> {
  return withMermaid(async () => {
    const mermaid = (await import('mermaid')).default as unknown as MermaidParserApi
    // The grammar detectors register on `initialize`; without it every source
    // is "No diagram type detected". Safe inside the lock: every render
    // initializes again with its own configuration.
    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' })
    try {
      const diagram = await mermaid.mermaidAPI.getDiagramFromText(source)
      return modelFromParsed(diagram)
    } catch {
      return null
    }
  })
}
