'use client'

import { useEffect, useMemo, useRef, type FC } from 'react'
import { useTranslations } from '@/i18n'
import { documentDisplayName } from '@/lib/documents/display-name'
import { extChipTint, fileExtensionLabel } from '@/features/documents/document-kind'
import {
  useSurfacedDocuments,
  type SurfacedDocument,
} from '@/features/documents/hooks/use-surfaced-documents'
import { peekFile, ResolveErrorState, UnresolvedCard } from './document-surface'

interface DocumentGridCardProps {
  title: string
  query?: string | null
  documents: SurfacedDocument[]
  projectId?: string | null
}

/**
 * Files the assistant asked the user to look at. One file peeks beside
 * chat (the card is a receipt). Several files are a short choice. Same
 * card, same payload — the list length is the only difference.
 */
export const DocumentGridCard: FC<DocumentGridCardProps> = ({ title, query: _query, documents, projectId }) => {
  const t = useTranslations('chat')
  const { resolved, isLoading, error, retry } = useSurfacedDocuments(documents, projectId ?? null)
  const peekedOnce = useRef<string | null>(null)

  const cells = useMemo(
    () =>
      resolved.map((entry) => ({
        entry,
        file: entry.file
          ? {
              ...entry.file,
              summary: entry.file.summary ?? entry.surfaced.summary ?? entry.surfaced.snippet ?? null,
            }
          : null,
      })),
    [resolved],
  )

  const ready = cells.filter((cell) => cell.file)
  const single = !isLoading && !error && ready.length === 1 && cells.length === 1 ? ready[0] : null

  useEffect(() => {
    if (!single?.file) return
    if (peekedOnce.current === single.file.id) return
    peekedOnce.current = single.file.id
    peekFile(single.file, single.entry.docSource, projectId)
  }, [single, projectId])

  if (documents.length === 0) return null

  return (
    <section
      data-testid="document-grid-card"
      data-layout={single ? 'receipt' : 'choice'}
      className="w-full"
    >
      {isLoading ? (
        <div className="bg-muted/40 h-14 animate-pulse rounded-xl border" />
      ) : error ? (
        <ResolveErrorState onRetry={retry} />
      ) : single?.file ? (
        <button
          type="button"
          onClick={() => peekFile(single.file!, single.entry.docSource, projectId)}
          aria-label={t('documentGrid.openAria', { label: documentDisplayName(single.file) })}
          className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1.5 px-0.5 py-0.5 text-left text-[12px]"
        >
          <span
            className="flex size-5 shrink-0 items-center justify-center rounded text-[8px] font-bold uppercase"
            style={extChipTint(fileExtensionLabel(single.file.filename))}
          >
            {fileExtensionLabel(single.file.filename)}
          </span>
          <span className="truncate">{t('documentGrid.showing', { label: documentDisplayName(single.file) })}</span>
        </button>
      ) : (
        <div className="space-y-1.5">
          {cells.length > 1 && (
            <p className="text-muted-foreground px-0.5 text-[11px] font-medium tracking-[-0.01em]">
              {title || t('documentGrid.choose')}
            </p>
          )}
          {cells.map(({ entry, file }) =>
            file ? (
              <button
                key={entry.key}
                type="button"
                onClick={() => peekFile(file, entry.docSource, projectId)}
                aria-label={t('documentGrid.openAria', { label: documentDisplayName(file) })}
                className="border-base bg-card/80 hover:bg-accent/60 flex w-full items-center gap-2.5 rounded-xl border px-2.5 py-2 text-left shadow-xs"
              >
                <span
                  className="flex size-8 shrink-0 items-center justify-center rounded-md text-[9px] font-bold uppercase"
                  style={extChipTint(fileExtensionLabel(file.filename))}
                >
                  {fileExtensionLabel(file.filename)}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13px] font-medium tracking-[-0.01em]">
                    {documentDisplayName(file)}
                  </span>
                  {(file.summary || entry.surfaced.snippet) && (
                    <span className="text-muted-foreground mt-0.5 line-clamp-1 block text-[11.5px]">
                      {file.summary || entry.surfaced.snippet}
                    </span>
                  )}
                </span>
                {entry.docSource && (
                  <span className="text-muted-foreground shrink-0 text-[11px]">
                    {t(`documentGrid.source.${entry.docSource}`)}
                  </span>
                )}
              </button>
            ) : (
              <UnresolvedCard key={entry.key} entry={entry} projectId={projectId} />
            ),
          )}
        </div>
      )}
    </section>
  )
}
