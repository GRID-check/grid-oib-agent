'use client'

/**
 * The margin of a Fundstelle excerpt: which document and which place `[N]`
 * is, and the way into it.
 *
 * An answer quotes a passage as a plain blockquote that ends in its citation
 * (`> „…" [3]`); the renderer draws it as an excerpt and asks the surface for
 * its source (`ExcerptSourceProvider`). The answer already resolved `[3]` for
 * its chip, so this reads the same `CitationScope` the chip reads, and opens
 * the document the way the chip's peek does: resolved first
 * (`resolveCitationTarget`), offered only when there is something to open, and
 * in the app at the cited page (`SourceDocumentDialog`). One click here where
 * the chip takes two, because an excerpt is the one place the reader has
 * already decided they want the source.
 */

import { useState, type FC } from 'react'
import { ExcerptMargin } from '@/shared/components/MarkdownRenderer/answer-atoms'
import type { ExcerptSourceProps } from '@/shared/components/MarkdownRenderer/answer-block-context'
import type { CitationRef } from '../lib/citations'
import { resolveCitationTarget } from '../lib/citations/target'
import { useChatStore } from '../store'
import { CitationOpenButton, LocusLine } from './CitationPeek'
import { useCitationScope } from './CitationScope'
import { SourceDocumentDialog, useSourcePreviewIndex } from './SourcePreview'

export const CitationExcerptSource: FC<ExcerptSourceProps> = ({ number }) => {
  const scope = useCitationScope()
  const ref = scope?.referenceFor(number)
  if (!ref) return null
  return <ResolvedExcerptSource citation={ref} />
}

const ResolvedExcerptSource: FC<{ citation: CitationRef }> = ({ citation }) => {
  const [open, setOpen] = useState(false)
  const projectId = useChatStore((s) => s.projectId)
  const conversationId = useChatStore((s) => s.currentConversation?.id ?? null)
  const url = citation.document.url
  const previewIndex = useSourcePreviewIndex(projectId, conversationId, !url)
  const target = resolveCitationTarget(citation.document, {
    locus: citation.locus,
    storedDocuments: previewIndex?.storedDocuments,
    baseCorpusFiles: previewIndex?.baseCorpusFiles,
  })
  const openable = target.kind === 'document' || target.kind === 'ris'
  return (
    <>
      <ExcerptMargin
        title={citation.document.title}
        locus={<LocusLine citation={citation} />}
        action={openable ? <CitationOpenButton tint={citation.document.tint} onOpen={() => setOpen(true)} /> : undefined}
      />
      {open && <SourceDocumentDialog citation={citation} onClose={() => setOpen(false)} />}
    </>
  )
}
