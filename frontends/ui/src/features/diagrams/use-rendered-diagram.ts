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
 *
 * ## Two copies, and why that is not two pictures
 *
 * This hook runs only where mermaid's SVG IS the picture: a source this
 * product has no view for (`use-diagram-model.ts` answered null). Where a view
 * draws the diagram, nothing here runs on mount; the file is drawn by
 * {@link renderPaperDiagram} when the reader files it, and not before.
 *
 * The drawing on screen is drawn in the READER'S theme, so it sits on the card
 * rather than on a white slab punched into a charcoal page. The drawing that
 * gets FILED is drawn on paper, always, because it becomes an SVG previewed on
 * a paper surface, a PDF page, and an attachment to an Einreichung — a file
 * that only reads correctly inside the dark app is a broken file.
 *
 * Those two cannot be the same bytes: `diagram-palette.ts` shows why no single
 * ink is a legible label against both white and `#232120`. So in dark mode this
 * hook draws twice. What makes that safe is everything it holds constant — the
 * same source, the same renderer, the same font family and size, the same
 * `htmlLabels: false` — so mermaid's layout is a pure function of inputs that
 * did not change and only the palette moves. The reader who presses „Im Projekt
 * ablegen" files the drawing they are looking at, in the colours a document is
 * printed in.
 *
 * In light mode there is one render and `fileSvg === svg`, literally the same
 * string, because there is nothing to reconcile.
 *
 * The screen copy is rendered FIRST and published on its own. The paper copy
 * follows a beat later and the filing affordance waits for it, so a theme most
 * readers are not in cannot slow down the picture everybody is.
 */

import { useEffect, useState } from 'react'
import { parseDiagramSvg, serializeDiagramSvg } from '@/lib/diagrams/svg'
import { diagramThemeVariables } from './diagram-palette'
import { canvasTextMeasure, mapSvg } from './map-svg'
import type { DiagramModel } from './model'
import { diagramRendererFor } from './render-diagram'
import { useDiagramTheme } from './use-diagram-theme'

export interface RenderedDiagram {
  /**
   * The drawing, validated: mermaid's output with the cascade flattened onto
   * the elements and re-serialised through the SERVER'S own SVG allow-list
   * (`renderMermaid` in `./render-diagram.ts`). `null` until it exists.
   *
   * Drawn in the reader's current theme, and re-drawn when that changes — a
   * diagram left in the previous theme after a toggle is a stale artifact, not
   * a cached one.
   */
  svg: string | null
  /**
   * The same drawing on paper — the bytes a filing action must send, whatever
   * theme the reader is in. `null` until it exists; identical to `svg` in light
   * mode. A surface with no filing affordance can ignore it entirely.
   */
  fileSvg: string | null
  /**
   * Mermaid refused the source. An EXPECTED outcome of this feature, not a
   * fault in it: the model writes broken mermaid regularly, so every caller
   * must degrade to something the reader already had.
   */
  failed: boolean
}

/** Mermaid mints element ids from this; a stale one collides across renders. */
function freshId(): string {
  return `mermaid-${Math.random().toString(36).slice(2)}`
}

/**
 * The paper copy of `source` alone, for a surface that draws the diagram with
 * its own view and needs an SVG only as the FILE. Called when the reader files,
 * so a diagram nobody files costs no layout at all. Rejects when the drawing
 * cannot be made; the filing hook reports that as a failed filing.
 *
 * A map is drawn from its model (`map-svg.ts`), so the file is the tree the
 * answer shows rather than mermaid's mindmap, which keeps a bare branch's
 * quotes and clips the root's label. Every other kind is mermaid's render.
 */
export async function renderPaperDiagram(source: string, model?: DiagramModel | null): Promise<string> {
  if (model?.kind === 'map') {
    const paper = diagramThemeVariables('light')
    if (paper) {
      const ink = { ink: String(paper.primaryTextColor), line: String(paper.lineColor), fill: String(paper.mainBkg) }
      // Through the server's validator, like every drawing mermaid makes.
      return serializeDiagramSvg(parseDiagramSvg(mapSvg(model, ink, canvasTextMeasure())).root)
    }
  }
  const renderer = diagramRendererFor('mermaid')
  if (!renderer) throw new Error('no mermaid renderer')
  return renderer({ source, id: freshId(), theme: 'light' })
}

/**
 * Draw `source`, unless `enabled` is false.
 *
 * `enabled` exists for the streaming fence, and for a surface whose own view
 * draws the diagram: a half-arrived fence is parsed to the end of the text, so
 * an in-flight diagram LOOKS complete on every token and handing it to mermaid
 * renders one parse error per token; and a diagram a view draws needs no
 * mermaid picture at all. Both surfaces pass `model === null` for the latter.
 */
export function useRenderedDiagram(source: string, enabled = true): RenderedDiagram {
  const theme = useDiagramTheme()
  const [svg, setSvg] = useState<string | null>(null)
  const [fileSvg, setFileSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const renderer = diagramRendererFor('mermaid')
    if (!renderer) return
    let cancelled = false

    const draw = async (): Promise<void> => {
      // A fresh id per render: mermaid mints element ids from it, and reusing
      // one across a theme switch would leave two definitions of the same
      // marker in the document with the first one winning.
      const screen = await renderer({ source, id: freshId(), theme })
      if (cancelled) return
      setSvg(screen)
      setFailed(false)
      if (theme === 'light') {
        // Not a copy and not a second render: the same string, so nothing can
        // make the file disagree with the picture in the theme most readers
        // are in.
        setFileSvg(screen)
        return
      }
      const paper = await renderer({ source, id: freshId(), theme: 'light' })
      if (cancelled) return
      setFileSvg(paper)
    }

    void draw().catch((error: unknown) => {
      if (cancelled) return
      // `debug` and not `error`: broken mermaid from a model is an expected
      // outcome of this feature, not a fault in it, and a console full of red
      // trains everyone to ignore the console.
      console.debug('[diagrams] mermaid did not render', error)
      setSvg(null)
      setFileSvg(null)
      setFailed(true)
    })

    return () => {
      cancelled = true
    }
  }, [source, enabled, theme])

  return { svg, fileSvg, failed }
}
