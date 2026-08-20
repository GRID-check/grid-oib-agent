'use client'

/**
 * One mermaid render, for every surface that shows a diagram.
 *
 * Two components draw model-authored mermaid now — the fence in an answer
 * (`components/mermaid-diagram.tsx`) and the `diagram` CARD
 * (`features/grid-cards/components/DiagramCard.tsx`) — and the render is the
 * half they must not each own. `render-diagram.ts` is already the single
 * mermaid path; this is the single way of DRIVING it, which is a different
 * thing and the one that would have drifted: the fresh id per render, the
 * cancellation on unmount, the `debug`-not-`error` console channel and the
 * rule that a failure resolves to "no svg" rather than throwing are four
 * decisions, all invisible in the output, all easy to get subtly different the
 * second time.
 *
 * It deliberately returns no chrome and no state machine. What a caller does
 * with `failed` is a design decision belonging to the surface — the fence falls
 * back to a code block inside the prose, the card falls back to one inside its
 * own frame — and a hook that decided that for them would have to grow a prop
 * for every difference.
 */

import { useEffect, useState } from 'react'
import { diagramRendererFor } from './render-diagram'

export interface RenderedDiagram {
  /**
   * The drawing, validated: mermaid's output with the cascade flattened onto
   * the elements and re-serialised through the SERVER'S own SVG allow-list
   * (`renderMermaid` in `./render-diagram.ts`). `null` until it exists.
   */
  svg: string | null
  /**
   * Mermaid refused the source. An EXPECTED outcome of this feature, not a
   * fault in it: the model writes broken mermaid regularly, so every caller
   * must degrade to something the reader already had.
   */
  failed: boolean
}

/**
 * Draw `source`, unless `enabled` is false.
 *
 * `enabled` exists for the streaming fence: `MarkdownRenderer` auto-closes a
 * half-arrived fence, so an in-flight diagram LOOKS complete on every token and
 * handing it to mermaid renders one parse error per token. A card never
 * streams — its payload arrives whole or not at all — so it passes `true`.
 */
export function useRenderedDiagram(source: string, enabled = true): RenderedDiagram {
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const renderer = diagramRendererFor('mermaid')
    if (!renderer) return
    let cancelled = false
    // A fresh id per render: mermaid mints element ids from it, and reusing one
    // across a theme switch would leave two definitions of the same marker in
    // the document with the first one winning.
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    // Always the light theme. The diagram is a preview of a DOCUMENT, and the
    // document is filed, converted to PDF and attached on white — see the
    // header of `render-diagram.ts`.
    renderer({ source, id, theme: 'light' })
      .then((rendered) => {
        if (!cancelled) {
          setSvg(rendered)
          setFailed(false)
        }
      })
      .catch((error: unknown) => {
        if (cancelled) return
        // `debug` and not `error`: broken mermaid from a model is an expected
        // outcome of this feature, not a fault in it, and a console full of red
        // trains everyone to ignore the console.
        console.debug('[diagrams] mermaid did not render', error)
        setSvg(null)
        setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [source, enabled])

  return { svg, failed }
}
