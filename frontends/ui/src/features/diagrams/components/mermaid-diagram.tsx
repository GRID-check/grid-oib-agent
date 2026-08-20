'use client'

/**
 * A mermaid fence in an answer, drawn.
 *
 * ## The three states, and why the fallback is the source
 *
 *   - **streaming** — the fence is still arriving, so nothing is drawn. The
 *     stabiliser in `MarkdownRenderer` appends a synthetic closing fence to
 *     half-arrived markdown, which means an in-flight mermaid block LOOKS
 *     complete on every token. Handing that to mermaid renders a parse error
 *     per token, so the rule is simply: while the answer is streaming, a
 *     mermaid fence is a code block. It becomes a diagram once, when the answer
 *     is finished and the text has stopped changing.
 *   - **failed** — the model writes broken mermaid regularly, and that must
 *     cost the reader nothing they did not already have. A failure renders the
 *     source, exactly as it rendered before this component existed, plus one
 *     quiet line saying the drawing did not work. Never a red box, never a
 *     thrown error inside somebody's answer.
 *   - **drawn** — the SVG, one line saying it claims no dimensions, and (only
 *     where a surface supplied a filing target) the button that files it.
 *
 * ## Why the drawing is on a light surface in BOTH themes
 *
 * A diagram here is a preview of a DOCUMENT, and the document is a drawing on
 * paper: it is filed as an SVG, converted to a PDF and attached to an
 * Einreichung, all of which happen on white. The Files pane already previews a
 * PDF as white pages in dark mode for exactly this reason.
 *
 * Rendering it in the reader's theme instead would buy a slightly calmer thread
 * and cost the thing this feature is for: what the reader looked at would stop
 * being what got filed. It would also mean re-rendering the whole diagram on
 * every theme flip, and a diagram that is briefly the WRONG theme is a worse
 * artifact than one that is deliberately, consistently paper.
 *
 * ## Why the drawn SVG is injected as markup
 *
 * `mermaid.render` returns a string, and there is no way to mount a string of
 * SVG without setting markup. What makes that safe is not mermaid's
 * `securityLevel: 'strict'` alone — it is that the string was put through the
 * SERVER'S validator and re-serialised from its allow-list before it got here
 * (`renderMermaid` in `../render-diagram.ts`). So the markup below contains
 * only elements and attributes `lib/diagrams/svg.ts` writes, and it is
 * byte-for-byte what the filing button will send.
 */

import { useCallback, useState } from 'react'
import { CodeBlock } from '@/shared/components/CodeBlock'
import { useTranslations } from '@/i18n'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { useRenderedDiagram } from '../use-rendered-diagram'
import { diagramRunId, useDiagramFilingTarget } from '../diagram-filing-context'

/** `--- title: X ---` front matter, which is the only title a source can carry. */
function titleFromSource(source: string): string | null {
  const match = source.match(/^\s*---\s*\n([\s\S]*?)\n\s*---/)
  const title = match?.[1].match(/^\s*title:\s*(.+?)\s*$/m)?.[1]
  return title ? title.slice(0, 200) : null
}

type FilingState =
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

/** The `documentId` of one half of the route's answer, or null if it has none. */
function documentIdOf(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('documentId' in value)) return null
  const { documentId } = value
  return typeof documentId === 'string' && documentId.length > 0 ? documentId : null
}

/**
 * Read which halves landed out of a 2xx body.
 *
 * `null` means the answer was not one this component understands — which the
 * route does not produce, and which is exactly why it must not be mistaken for
 * a partial filing. That confusion was the previous shape of this code: a 2xx
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

export interface MermaidDiagramProps {
  source: string
  /** True while the answer is still arriving; see the header. */
  isStreaming?: boolean
}

export function MermaidDiagram({ source, isStreaming = false }: MermaidDiagramProps) {
  const t = useTranslations('diagrams')
  const target = useDiagramFilingTarget()
  // The render itself is `useRenderedDiagram` — shared with the `diagram` card,
  // which draws the same sources through the same renderer. One drive, so the
  // fresh id, the cancellation and the "a failure is not a throw" rule cannot
  // come out different on the two surfaces.
  const { svg, failed } = useRenderedDiagram(source, !isStreaming)
  const [filing, setFiling] = useState<FilingState>({ kind: 'idle' })

  const file = useCallback(async () => {
    if (!target || !svg) return
    setFiling({ kind: 'filing' })
    try {
      const response = await fetch(`/api/projects/${encodeURIComponent(target.projectId)}/diagrams`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          runId: diagramRunId(target.answerId, source),
          title: titleFromSource(source) ?? target.title ?? t('defaultTitle'),
          sourceKind: 'mermaid',
          source,
          // The bytes on screen. Not a re-render: a second render is a second
          // chance for the file to disagree with the picture, and nobody can
          // spot that before signing.
          svg,
        }),
      })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => null)
        const message =
          body && typeof body === 'object' && 'error' in body && typeof body.error === 'string'
            ? body.error
            : t('file.failed')
        setFiling({ kind: 'failed', message })
        return
      }
      const body: unknown = await response.json()
      // The SVG row is the one a reader opens; the PDF is the one they attach.
      // Both ids come back, and a missing PDF is a smaller success rather than
      // a failure — the route answers 201 with `pdf: null` when only the SVG
      // landed, because the SVG is filed and quota-charged either way.
      const halves = filedHalves(body)
      if (!halves) {
        setFiling({ kind: 'failed', message: t('file.failed') })
        return
      }
      setFiling({
        kind: halves.pdfFiled ? 'filed' : 'partial',
        documentId: halves.svgDocumentId,
      })
    } catch (error) {
      console.debug('[diagrams] filing failed', error)
      setFiling({ kind: 'failed', message: t('file.failed') })
    }
  }, [target, svg, source, t])

  // Streaming, or drawn nothing yet, or refused to draw: the source, which is
  // what the reader saw before this component existed.
  if (isStreaming || !svg) {
    const lineCount = source.split('\n').length
    return (
      <div data-testid="mermaid-diagram" data-state={failed ? 'failed' : isStreaming ? 'streaming' : 'drawing'}>
        <CodeBlock value={source} language="mermaid" collapsible={lineCount > 15} maxLines={15} />
        {failed ? <p className="mt-1 text-xs text-muted-foreground">{t('fallback')}</p> : null}
      </div>
    )
  }

  return (
    <figure data-testid="mermaid-diagram" data-state="drawn" className="my-4">
      <div
        className="overflow-x-auto rounded-lg border border-border bg-white p-3 [&_svg]:h-auto [&_svg]:max-w-full"
        // Safe because of what produced the string, not because of where it is
        // used: `renderMermaid` re-serialises mermaid's output through
        // `lib/diagrams/svg.ts`, so only allow-listed elements and attributes
        // survive — no script, no foreignObject, no external reference.
        dangerouslySetInnerHTML={{ __html: svg }}
      />
      <figcaption className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        {/* The doctrine, where the reader is. Fifteen schematic cards in this
            product compute their geometry so they cannot disagree with their
            own numbers; a model-authored diagram has no such guarantee, so it
            says out loud that it is not claiming a measurement. */}
        <span>{t('schematicOnly')}</span>
        {filing.kind === 'filing' ? <span>{t('file.pending')}</span> : null}
        {/* What landed, in words, before any action: „das PDF fehlt" is the
            fact, and the two controls under it are what to do about it. A
            partial filing says the smaller true thing rather than „abgelegt". */}
        {filing.kind === 'filed' ? <span>{t('file.done')}</span> : null}
        {filing.kind === 'partial' ? <span>{t('file.partial')}</span> : null}
        {target && (filing.kind === 'filed' || filing.kind === 'partial') ? (
          <a
            href={documentFilesHref(target.projectId, filing.documentId)}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('file.open')}
          </a>
        ) : null}
        {/* The same call, and deliberately: `fileGeneratedDocument` is
            idempotent per (run, producer), so pressing this after a partial
            filing finds the SVG already filed and files only the PDF. That is
            why the label is „PDF ergänzen" and not „nochmals ablegen" — the
            button does the smaller thing, and saying otherwise would invite the
            reader to expect a second copy of the drawing.
            A `failed` state offers no retry: a refusal is a 400 about the bytes
            themselves, and the same bytes will be refused again. */}
        {target && (filing.kind === 'idle' || filing.kind === 'partial') ? (
          <button
            type="button"
            onClick={file}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {filing.kind === 'partial' ? t('file.completePdf') : t('file.action')}
          </button>
        ) : null}
        {filing.kind === 'failed' ? <span className="text-destructive">{filing.message}</span> : null}
      </figcaption>
    </figure>
  )
}
