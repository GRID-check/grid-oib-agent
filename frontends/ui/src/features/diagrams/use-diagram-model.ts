'use client'

/**
 * The typed model of a mermaid source, for the views in `views/`.
 *
 * `undefined` while parsing, `null` when this product has no view for it (the
 * caller then draws mermaid's SVG), the model otherwise. Parsing starts only
 * when `enabled` — a fence still streaming in would parse a half-written graph
 * on every token.
 */

import { useEffect, useState } from 'react'

import type { DiagramModel } from './model'
import { parseMermaid } from './parse-mermaid'

export function useDiagramModel(source: string, enabled = true): DiagramModel | null | undefined {
  const [state, setState] = useState<{ source: string; model: DiagramModel | null } | null>(null)
  useEffect(() => {
    if (!enabled) return
    let cancelled = false
    // Any failure is "no view": the caller falls back to mermaid's SVG. A
    // rejected promise left unhandled here kept the drawing on its skeleton.
    void parseMermaid(source)
      .catch(() => null)
      .then((model) => {
        if (!cancelled) setState({ source, model })
      })
    return () => {
      cancelled = true
    }
  }, [source, enabled])
  return state?.source === source ? state.model : undefined
}
