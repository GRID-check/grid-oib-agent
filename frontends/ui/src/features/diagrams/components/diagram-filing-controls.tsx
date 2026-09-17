'use client'

/**
 * What filing a diagram LOOKS like — once, for the fence and for the card.
 *
 * The state machine is `../use-diagram-filing.ts`; this is its five sentences
 * and its two controls. Shared for the same reason the hook is: „Das Bild wurde
 * abgelegt, das PDF nicht." and „PDF ergänzen" are a matched pair of claims
 * about one outcome, and two hand-rolled copies of that pair drift into saying
 * different things about the same 201.
 *
 * It renders INLINE, with no chrome of its own, so each surface keeps its own
 * caption layout: the fence puts it beside „Schematisch — ohne Maßangabe." in a
 * figcaption, the card under its own doctrine line. Nothing here is a Button —
 * a filled control in a caption would compete with the drawing and, on the
 * card, with the Fundstelle underneath it. Quiet ink text that behaves like a
 * link is what the rest of this product uses for a secondary action in a meta
 * row, and it is what these already were.
 */

import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { documentFilesHref } from '@/features/documents/lib/document-question'
import { openFiledDocument } from '@/features/documents/lib/open-filed-document'
import { cn } from '@/lib/utils'
import type { DiagramFiling } from '../use-diagram-filing'

/**
 * A 12px line of text is a 16px-tall target, and the design language's reading
 * of Fitts is that a control has to survive a thumb. `min-h-11` (44px) with the
 * label vertically centred gives the pointer the area without giving the
 * caption row a button's visual weight — it stays a line of quiet text, which
 * is what it should look like beside „Schematisch — ohne Maßangabe.".
 */
const CONTROL =
  'inline-flex min-h-11 items-center rounded-sm font-medium text-primary underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring'

export function DiagramFilingControls({ filing, className }: { filing: DiagramFiling; className?: string }) {
  const t = useTranslations('diagrams')
  const isMobile = useIsMobile()
  const { state, target, documentId } = filing

  if (!target) return null
  const href = documentId ? documentFilesHref(target.projectId, documentId) : null

  return (
    <span className={cn('inline-flex flex-wrap items-center gap-x-3', className)} data-testid="diagram-filing">
      {state.kind === 'filing' ? <span>{t('file.pending')}</span> : null}
      {/* What landed, in words, before any action: „das PDF fehlt" is the fact,
          and the controls after it are what to do about it. A partial filing
          says the smaller true thing rather than „abgelegt". */}
      {state.kind === 'filed' ? <span>{t('file.done')}</span> : null}
      {state.kind === 'partial' ? <span>{t('file.partial')}</span> : null}
      {href && documentId ? (
        <a
          href={href}
          className={CONTROL}
          data-testid="diagram-open-filed"
          // A real link, intercepted — not a button dressed as one. Middle
          // click, "copy link address" and a phone all still get the Files
          // route; a desktop click gets the pane beside the conversation
          // instead. `isMobile` is the honest gate: `FilePreviewHost` refuses to
          // peek below the `md` breakpoint, so on a phone the interception
          // would be a click that did nothing.
          onClick={(event) => {
            if (isMobile || event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return
            event.preventDefault()
            void openFiledDocument({ documentId, projectId: target.projectId }).then((opened) => {
              // The peek could not read the row. Never a dead control: fall
              // through to the destination the link already names.
              if (!opened) window.location.assign(href)
            })
          }}
        >
          {t('file.open')}
        </a>
      ) : null}
      {/* The same call, and deliberately: `fileGeneratedDocument` is idempotent
          per (run, producer), so pressing this after a partial filing finds the
          SVG already filed and files only the PDF. That is why the label is
          „PDF ergänzen" and not „nochmals ablegen" — the button does the smaller
          thing, and saying otherwise would invite the reader to expect a second
          copy of the drawing.
          A `failed` state offers no retry: a refusal is a 400 about the bytes
          themselves, and the same bytes will be refused again. */}
      {state.kind === 'idle' || state.kind === 'partial' ? (
        <button
          type="button"
          onClick={() => void filing.file()}
          // Disabled until the paper copy exists: in dark mode it lands a beat
          // after the picture, and a press before then would file nothing.
          disabled={!filing.canFile}
          className={cn(CONTROL, 'disabled:cursor-not-allowed disabled:opacity-60')}
        >
          {state.kind === 'partial' ? t('file.completePdf') : t('file.action')}
        </button>
      ) : null}
      {state.kind === 'failed' ? <span className="text-destructive">{state.message}</span> : null}
    </span>
  )
}
