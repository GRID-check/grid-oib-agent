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

import { useCallback, useEffect, useState } from 'react'
import { CodeBlock } from '@/shared/components/CodeBlock'
import { useTranslations } from '@/i18n'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { diagramRendererFor } from '../render-diagram'
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
  | { kind: 'partial' }
  | { kind: 'failed'; message: string }

export interface MermaidDiagramProps {
  source: string
  /** True while the answer is still arriving; see the header. */
  isStreaming?: boolean
}

export function MermaidDiagram({ source, isStreaming = false }: MermaidDiagramProps) {
  const t = useTranslations('diagrams')
  const target = useDiagramFilingTarget()
  const [svg, setSvg] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const [filing, setFiling] = useState<FilingState>({ kind: 'idle' })

  useEffect(() => {
    if (isStreaming) return
    const renderer = diagramRendererFor('mermaid')
    if (!renderer) return
    let cancelled = false
    // A fresh id per render: mermaid mints element ids from it, and reusing one
    // across a theme switch would leave two definitions of the same marker in
    // the document with the first one winning.
    const id = `mermaid-${Math.random().toString(36).slice(2)}`
    // Always the light theme — see the header. One render, and it is the one
    // that gets filed.
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
  }, [source, isStreaming])

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
      const documentId =
        body && typeof body === 'object' && 'svg' in body && body.svg && typeof body.svg === 'object'
          ? // The SVG row is the one a reader opens; the PDF is the one they attach.
            ((body.svg as { documentId?: unknown }).documentId ?? null)
          : null
      setFiling(
        typeof documentId === 'string' ? { kind: 'filed', documentId } : { kind: 'partial' }
      )
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
        {target && filing.kind === 'idle' ? (
          <button
            type="button"
            onClick={file}
            className="font-medium text-primary underline-offset-2 hover:underline"
          >
            {t('file.action')}
          </button>
        ) : null}
        {filing.kind === 'filing' ? <span>{t('file.pending')}</span> : null}
        {filing.kind === 'filed' && target ? (
          <>
            <span>{t('file.done')}</span>
            <a
              href={documentFilesHref(target.projectId, filing.documentId)}
              className="font-medium text-primary underline-offset-2 hover:underline"
            >
              {t('file.open')}
            </a>
          </>
        ) : null}
        {filing.kind === 'partial' ? <span>{t('file.partial')}</span> : null}
        {filing.kind === 'failed' ? <span className="text-destructive">{filing.message}</span> : null}
      </figcaption>
    </figure>
  )
}
