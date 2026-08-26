'use client'

/**
 * Filing one drawing into the project — the whole write, once.
 *
 * Two surfaces draw model-authored mermaid and both must be able to save it:
 * the ```mermaid FENCE inside an answer, and the `diagram` CARD. Which one a
 * reader gets is not their choice and not a property of the drawing — it is
 * whichever shape the model happened to emit — so „Im Projekt ablegen" existing
 * on one and not the other made the same Verfahrensablauf filable or not by
 * accident.
 *
 * This is the half neither surface may own. The POST, the run id, the title
 * resolution, the five states and — the part that would actually have drifted —
 * what a 201 with `pdf: null` means are one implementation, because two copies
 * of a `partial` branch will disagree about an error message inside a month and
 * the disagreement is invisible until someone files a half-broken diagram.
 *
 * ## Why no `CardInteraction`
 *
 * The card is `presentational` in `CARD_INTERACTIVITY` (ADR-0030) and STAYS
 * presentational with this button, which sounds like a contradiction and is
 * not. That classification governs whether a decision is PERSISTED, and the
 * reason not to persist this one is unchanged and good: a `CardInteraction` is
 * a `CardDecision` plus a timestamp and nothing else, so storing `filed` would
 * record that it happened and lose the document id — the answer's only pointer
 * into the Files pane — while also removing the button that could give it back.
 *
 * What that argues against is the STORAGE, and the button never needed it.
 * Filing keys on (answer, source hash, producer) — `diagramRunId` and migration
 * 0065's index — so pressing it after a reload finds the same document and
 * hands the reader the same link. Nothing to remember, nothing to be annoyed to
 * do twice, no persisted decision. `card-decision.ts` records this reasoning at
 * the `diagram` entry.
 *
 * ## Two drawings with one identity
 *
 * `diagramRunId(answerId, source)` is a hash of the SOURCE, so a card and a
 * fence carrying byte-identical mermaid in one answer collide on purpose. That
 * is the right outcome — it is one picture and the office wants one file — and
 * it is the same rule two identical fences already follow. The visible
 * consequence is that the title of whichever was filed FIRST is the name in the
 * Files pane; the second press finds the document already there and files only
 * what is missing rather than renaming it. Naming a file twice would be the
 * worse behaviour: it would make the Files pane disagree with itself depending
 * on which control a reader last touched.
 */

import { useCallback, useState } from 'react'
import { useTranslations } from '@/i18n'
import { diagramRunId, useDiagramFilingTarget, type DiagramFilingTarget } from './diagram-filing-context'

export type DiagramFilingState =
  | { kind: 'idle' }
  | { kind: 'filing' }
  | { kind: 'filed'; documentId: string }
  /**
   * The SVG landed and the PDF did not (`pdf: null`, 201).
   *
   * It carries the SVG's document id for the same reason `filed` does: the half
   * that IS in the project is the half the reader most needs to open, and a
   * state that says "half of it is filed" without saying where sends them to
   * hunt through Berichte for a file they are not sure exists.
   */
  | { kind: 'partial'; documentId: string }
  | { kind: 'failed'; message: string }

export interface DiagramFiling {
  state: DiagramFilingState
  /** Where this drawing may be filed, or `null` — then the surface offers nothing. */
  target: DiagramFilingTarget | null
  /** The document once one exists, for the „Im Projekt öffnen" affordance. */
  documentId: string | null
  /** The paper bytes exist and there is somewhere to put them. */
  canFile: boolean
  file: () => Promise<void>
}

/** `--- title: X ---` front matter, which is the only title a SOURCE can carry. */
export function titleFromSource(source: string): string | null {
  const match = source.match(/^\s*---\s*\n([\s\S]*?)\n\s*---/)
  const title = match?.[1].match(/^\s*title:\s*(.+?)\s*$/m)?.[1]
  return title ? title.slice(0, 200) : null
}

/** The `documentId` of one half of the route's answer, or null if it has none. */
function documentIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('documentId' in value)) return null
  const { documentId } = value
  return typeof documentId === 'string' && documentId.length > 0 ? documentId : null
}

/**
 * Read which halves landed out of a 2xx body.
 *
 * `null` means the answer was not one this hook understands — which the route
 * does not produce, and which is exactly why it must not be mistaken for a
 * partial filing. That confusion was the previous shape of this code: a 2xx
 * body without `svg.documentId` was rendered as „das Bild wurde abgelegt", a
 * sentence about a file nothing had said existed, while the real partial case
 * arrived as a 500 and read „Internal server error".
 */
function filedHalves(body: unknown): { svgDocumentId: string; pdfFiled: boolean } | null {
  if (typeof body !== 'object' || body === null || !('svg' in body)) return null
  const svgDocumentId = documentIdOf(body.svg)
  if (!svgDocumentId) return null
  return { svgDocumentId, pdfFiled: 'pdf' in body && documentIdOf(body.pdf) !== null }
}

export interface DiagramFilingOptions {
  source: string
  /**
   * The PAPER render — `fileSvg` from `useRenderedDiagram`, never `svg`. The
   * bytes that go into the project are the ones a document is printed in,
   * whatever theme the reader is in, and passing the themed copy here is the
   * regression that puts a charcoal drawing on a white page.
   */
  fileSvg: string | null
  /**
   * A title the SURFACE knows and the source does not. The `diagram` card has a
   * real one the model wrote for this drawing; a fence has only whatever front
   * matter the source carries. Better provenance wins, so this is checked first.
   */
  title?: string | null
}

export function useDiagramFiling({ source, fileSvg, title }: DiagramFilingOptions): DiagramFiling {
  const t = useTranslations('diagrams')
  const target = useDiagramFilingTarget()
  const [state, setState] = useState<DiagramFilingState>({ kind: 'idle' })

  const file = useCallback(async () => {
    if (!target || !fileSvg) return
    // Feedback inside 100ms: this lands synchronously, before the network is
    // touched, so the control the reader pressed is replaced by „Wird abgelegt …"
    // in the same frame as the press.
    setState({ kind: 'filing' })
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(target.projectId)}/diagrams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: diagramRunId(target.answerId, source),
          title: title?.trim() || titleFromSource(source) || target.title || t('defaultTitle'),
          sourceKind: 'mermaid',
          source,
          // The drawing on screen, in the colours a document is printed in.
          // Same source, same fonts, same layout — only the palette differs, and
          // the reason it has to is in `./diagram-palette.ts`.
          svg: fileSvg,
        }),
      })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : t('file.failed')
        setState({ kind: 'failed', message })
        return
      }
      const body: unknown = await response.json()
      // The SVG row is the one a reader opens; the PDF is the one they attach.
      // Both ids come back, and a missing PDF is a smaller success rather than
      // a failure — the route answers 201 with `pdf: null` when only the SVG
      // landed, because the SVG is filed and quota-charged either way.
      const halves = filedHalves(body)
      if (!halves) {
        setState({ kind: 'failed', message: t('file.failed') })
        return
      }
      setState({ kind: halves.pdfFiled ? 'filed' : 'partial', documentId: halves.svgDocumentId })
    } catch (error) {
      console.debug('[diagrams] filing failed', error)
      setState({ kind: 'failed', message: t('file.failed') })
    }
  }, [target, fileSvg, source, title, t])

  return {
    state,
    target,
    documentId: state.kind === 'filed' || state.kind === 'partial' ? state.documentId : null,
    canFile: Boolean(target && fileSvg),
    file,
  }
}
