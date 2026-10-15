'use client'

/**
 * The viewer around „Im Büro behandelt": the document on the stage, the rail
 * of similar passages beside it.
 *
 * - {@link openedPassageView}: what the stage shows while a similar passage
 *   the reader opened from the rail is on it — its document, at the passage,
 *   marked, under its provenance chip. Props for the ONE `PdfViewerDialog` a
 *   host already renders, not a second dialog: swapping dialogs would remount
 *   the rail (and search again) and drop the reader's focus. The citation
 *   viewer (`CitationDocumentDialog`) and the dialog below both use it, so a
 *   hit looks the same from either.
 * - {@link SimilarPassagesDialog}: a passage selected in a stored document
 *   outside a citation (the Files preview), opened large on the selection.
 *
 * {@link useSimilarPassagesViewer} decides which document is on the stage.
 */

import { useEffect, type FC } from 'react'
import { PdfViewerDialog, type PdfViewerDialogProps } from '@/features/knowledge/components/pdf-viewer-dialog'
import { SourceSignalChip } from '@/features/layout/components/SourceSignalChip'
import type { SimilarPassagesRequest } from '@/lib/similar-passages/types'
import {
  stageOf,
  useSimilarPassagesViewer,
  type DocumentSrcOf,
  type OpenedPassage,
  type SimilarPassagesLoader,
} from '../lib/use-similar-passages'
import { SimilarPassagesPanel } from './similar-passages-panel'

/** The provenance signal of a similar passage: the Büroablage's, or a project's. */
const signalOf = (opened: OpenedPassage): 'office' | 'project' => (opened.groupKind === 'archiv' ? 'office' : 'project')

/** The viewer's props while `opened` is on the stage: its document at the passage, marked. */
export function openedPassageView(
  opened: OpenedPassage,
  srcOf?: DocumentSrcOf
): Pick<
  PdfViewerDialogProps,
  'fileName' | 'src' | 'title' | 'isImage' | 'page' | 'highlight' | 'highlightColor' | 'headerChip'
> {
  const stage = stageOf(opened, srcOf)
  return {
    fileName: stage.fileName,
    src: stage.src,
    title: stage.title,
    isImage: stage.isImage,
    page: stage.page,
    highlight: stage.highlight,
    highlightColor: `var(--source-${signalOf(opened)})`,
    headerChip: <SourceSignalChip signal={signalOf(opened)}>{opened.groupLabel}</SourceSignalChip>,
  }
}

export interface SimilarPassagesDialogProps {
  /** The ask that opens the dialog; null keeps it closed. */
  request: SimilarPassagesRequest | null
  /** The document the passage was selected in: how the stage shows it. */
  source: { src: string; fileName: string; title: string }
  onClose: () => void
  load?: SimilarPassagesLoader
  /** Where an opened passage's bytes stream from: the same-origin stream unless a preview passes fixtures. */
  srcOf?: DocumentSrcOf
}

export const SimilarPassagesDialog: FC<SimilarPassagesDialogProps> = ({ request, source, onClose, load, srcOf }) => {
  const similar = useSimilarPassagesViewer()
  const { start, close } = similar

  // A new ask from the host (another selection in the preview) starts over.
  useEffect(() => {
    if (request) start(request)
    else close()
  }, [request, start, close])

  const shown = similar.request ?? request
  if (!shown) return null
  const view = similar.opened
    ? openedPassageView(similar.opened, srcOf)
    : {
        fileName: source.fileName,
        src: source.src,
        title: source.title,
        page: shown.passage.page ?? null,
        // The selection is marked on the source, as a Fundstelle is in a citation.
        highlight: shown.passage.text,
        highlightColor: 'var(--source-project)',
      }

  return (
    <PdfViewerDialog
      open={request !== null}
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
      {...view}
      // Another selection in the source searches again from it; the rail is
      // about the source, so a passage opened from it offers no search of its own.
      onFindSimilar={
        similar.opened ? undefined : ({ text, page }) => start({ ...shown, passage: { text, page, cited: false } })
      }
      aside={
        <SimilarPassagesPanel
          request={shown}
          opened={similar.opened}
          onOpen={similar.open}
          onBackToSource={similar.backToSource}
          onClose={onClose}
          load={load}
        />
      }
    />
  )
}
