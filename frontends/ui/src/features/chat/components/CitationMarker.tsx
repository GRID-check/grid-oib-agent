/**
 * The inline `[3]` in an answer, as a first-class citation.
 *
 * It used to be a scroll link: click it and the page moved, leaving the reader
 * to work out which of the chips below they had just been sent to. That is the
 * wrong division of labour — the marker knows exactly which citation it is, and
 * should say so.
 *
 * Now it:
 *  - previews on hover / focus / tap ({@link CitationPeek}) — what document,
 *    how authoritative, which page, and the passage itself;
 *  - marks its chip when activated, so the connection between the claim in the
 *    prose and the source under it is something you SEE rather than infer;
 *  - opens the document at the cited page without leaving the answer.
 *
 * `CitationScope` is what makes that possible: the answer already built the
 * citation model for its provenance row, so the marker reads the same objects
 * instead of a second lookup that could disagree.
 */

'use client'

import { type FC, type ReactNode, useState } from 'react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { scrollToAnchor } from '@/shared/components/MarkdownRenderer/anchor-context'
import { citationSnippet, type CitationRef } from '../lib/citations'
import { useHoverPopover } from '@/hooks/use-hover-popover'
import { useCitationScope } from './CitationScope'
import { CitationPeek } from './CitationPeek'
import { SourceDocumentDialog } from './SourcePreview'

/**
 * An in-page anchor that the answer recognises as one of its own citations.
 *
 * Anything else (a heading link the model wrote) falls through to `fallback`,
 * so this never swallows an anchor it does not understand.
 */
export const CitationMarker: FC<{ href: string; fallback: ReactNode }> = ({ href, fallback }) => {
  const scope = useCitationScope()
  const t = useTranslations('chat')
  const [openDocument, setOpenDocument] = useState<CitationRef | null>(null)
  const peek = useHoverPopover()

  const number = scope ? numberFromHref(href, scope.anchorPrefix) : null
  const ref = number != null ? scope?.referenceFor(number) : undefined
  if (!scope || number == null || !ref) return <>{fallback}</>

  const snippet = ref.locus?.snippet ?? citationSnippet({ content: ref.document.snippet ?? '' })

  return (
    <>
      <Popover open={peek.open} onOpenChange={peek.onOpenChange}>
        <PopoverAnchor asChild>
          <button
            type="button"
            // The visual registry needs a handle to open a peek before
            // capturing, so the popover state is a committed screenshot too.
            data-citation-marker={number}
            {...peek.triggerProps}
            onClick={() => {
              peek.triggerProps.onClick()
              // Still goes where it always went — but the chip now says so.
              scope.focus(number)
              scrollToAnchor(`${scope.anchorPrefix}${number}`)
            }}
            aria-label={t('citationPeek.markerAria', {
              number,
              label: ref.document.title,
            })}
            // A tinted pill carrying the bare NUMBER, not the literal "[1]".
            // The pill shape already says "this is a reference", so the
            // brackets only widened it — enough that the sentence's own
            // punctuation was pushed off ("erforderlich [1] ."). The number
            // alone also matches how the chip below lists its markers ("1, 2,
            // 3"), so the same citation reads the same in both places.
            className={cn(
              'inline-flex min-w-[1.05rem] items-center justify-center rounded-[4px] px-[3px]',
              'relative -top-[0.15em] text-[0.68em] font-semibold leading-[1.45] tabular-nums',
              // `transform` joins the transition list and `active:scale-95` matches
              // the Button primitive exactly. A citation marker is one of the most
              // pressed things in a read answer, and it was one of the raw
              // `<button>`s that gave no press response at all — so half the chat's
              // controls acknowledged a tap and half sat inert.
              'transition-[filter,box-shadow,transform] duration-200 ease-out active:scale-95 motion-reduce:transition-none motion-reduce:active:scale-100',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
              'hover:brightness-95 dark:hover:brightness-125'
            )}
            style={{
              backgroundColor: `var(--source-${ref.document.tint}-tint, var(--muted))`,
              color: `var(--source-${ref.document.tint}-text, var(--muted-foreground))`,
            }}
          >
            {number}
          </button>
        </PopoverAnchor>
        <PopoverContent align="start" className="w-80 p-3" {...peek.contentProps}>
          <CitationPeek
            citation={ref}
            snippet={snippet}
            url={ref.document.url}
            onOpen={
              ref.document.url
                ? undefined
                : () => {
                    // The peek asked a question the document now answers in
                    // full; leaving it hanging over the dialog would be two
                    // views of one citation arguing for the same attention.
                    peek.dismiss()
                    setOpenDocument(ref)
                  }
            }
          />
        </PopoverContent>
      </Popover>
      {/* Mounted only once opened, so a page of markers costs no fetches. */}
      {/* The reference carries the page, so the dialog needs nothing else. */}
      {openDocument && (
        <SourceDocumentDialog citation={openDocument} onClose={() => setOpenDocument(null)} />
      )}
    </>
  )
}

/** The `[N]` an anchor points at, when it belongs to this answer's citations. */
const numberFromHref = (href: string, anchorPrefix: string): number | null => {
  const id = href.startsWith('#') ? href.slice(1) : href
  if (!id.startsWith(anchorPrefix)) return null
  const number = Number(id.slice(anchorPrefix.length))
  return Number.isInteger(number) && number > 0 ? number : null
}
