'use client'

/**
 * The typed model of a mermaid source, for the views in `views/`.
 *
 * `undefined` while parsing, `null` when this product has no view for it (the
 * caller then draws mermaid's SVG), the model otherwise. Parsing starts only
 * when `enabled` — a fence still streaming in would parse a half-written graph
 * on every token.
 *
 * ## Parsed once per source, not once per mount
 *
 * A parse is not free: it loads mermaid's grammar and waits its turn behind the
 * one mermaid lock every render and parse on the page shares
 * (`withMermaid`). And a mount is not rare: a streamed answer re-renders on
 * every token, and anything that makes React replace the fence (a new
 * component identity upstream, a list re-keyed) starts this hook from nothing.
 * Without a cache that was a drawn diagram going back to its skeleton and
 * queuing a fresh parse of text it had already read, once per token.
 *
 * So the result is held at module level, keyed by the source text: the model
 * is a pure function of it. A remount of a source already read returns its
 * model on the first render, with no skeleton frame in between; two fences with
 * the same text share one parse.
 */

import { useEffect, useState } from 'react'

import type { DiagramModel } from './model'
import { parseMermaid } from './parse-mermaid'

/** Enough for every diagram on a long conversation page; oldest out first. */
const MODEL_CACHE_LIMIT = 64

/** Settled parses. `null` is a real answer ("no view"), so `has` decides, not truthiness. */
const settled = new Map<string, DiagramModel | null>()
/** Parses in flight, so two mounts of one source wait on the same one. */
const inFlight = new Map<string, Promise<DiagramModel | null>>()

function remember(source: string, model: DiagramModel | null): void {
  settled.delete(source)
  settled.set(source, model)
  if (settled.size <= MODEL_CACHE_LIMIT) return
  const oldest = settled.keys().next().value
  if (oldest !== undefined) settled.delete(oldest)
}

function parseOnce(source: string): Promise<DiagramModel | null> {
  const pending = inFlight.get(source)
  if (pending) return pending
  // Any failure is "no view": the caller falls back to mermaid's SVG. A
  // rejected promise left unhandled here kept the drawing on its skeleton.
  const parse = parseMermaid(source)
    .catch(() => null)
    .then((model) => {
      remember(source, model)
      inFlight.delete(source)
      return model
    })
  inFlight.set(source, parse)
  return parse
}

/** Test seam: forget every parse, so one spec's sources do not answer another's. */
export function clearDiagramModelCache(): void {
  settled.clear()
  inFlight.clear()
}

export function useDiagramModel(source: string, enabled = true): DiagramModel | null | undefined {
  const [state, setState] = useState<{ source: string; model: DiagramModel | null } | null>(null)
  const known = enabled && settled.has(source)
  useEffect(() => {
    if (!enabled || settled.has(source)) return
    let cancelled = false
    void parseOnce(source).then((model) => {
      if (!cancelled) setState({ source, model })
    })
    return () => {
      cancelled = true
    }
  }, [source, enabled])
  if (known) return settled.get(source) ?? null
  return state?.source === source ? state.model : undefined
}
