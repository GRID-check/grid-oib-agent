'use client'

import { useEffect, useMemo, useRef, type FC } from 'react'
import { useLocale, useTranslations } from '@/i18n'
import { FileCard } from '@/features/documents/components/file-card'
import { FileGrid, FileCardSkeleton } from '@/features/documents/components/file-grid'
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
 * Files the assistant asked the user to look at.
 *
 * Visual: the same raised {@link FileCard} (thumbnail well, name, snippet)
 * the Files grid uses. One file is that card plus an automatic peek.
 * Several close matches are a short FileGrid — never a text list.
 */
export const DocumentGridCard: FC<DocumentGridCardProps> = ({ title, query: _query, documents, projectId }) => {
  const t = useTranslations('chat')
  const { locale } = useLocale()
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
        <FileGrid className="max-w-[220px]">
          {Array.from({ length: Math.min(documents.length, 3) }).map((_, i) => (
            <FileCardSkeleton key={i} />
          ))}
        </FileGrid>
      ) : error ? (
        <ResolveErrorState onRetry={retry} />
      ) : (
        <>
          {!single && cells.length > 1 && (
            <p className="text-muted-foreground mb-2 px-0.5 text-[11px] font-medium tracking-[-0.01em]">
              {title || t('documentGrid.choose')}
            </p>
          )}
          <FileGrid className={single ? 'max-w-[220px]' : undefined}>
            {cells.map(({ entry, file }) =>
              file ? (
                <FileCard
                  key={entry.key}
                  file={file}
                  isSelected={false}
                  locale={locale}
                  onSelect={() => peekFile(file, entry.docSource, projectId)}
                  source={entry.docSource}
                  sourceLabel={entry.docSource ? t(`documentGrid.source.${entry.docSource}`) : undefined}
                  hideStatusWhenReady
                  ariaLabel={t('documentGrid.openAria', { label: file.filename })}
                  match={
                    entry.surfaced.snippet
                      ? {
                          snippet: entry.surfaced.snippet,
                          page: entry.surfaced.page ?? null,
                          score: entry.surfaced.score ?? 0,
                        }
                      : undefined
                  }
                />
              ) : (
                <UnresolvedCard key={entry.key} entry={entry} projectId={projectId} />
              ),
            )}
          </FileGrid>
        </>
      )}
    </section>
  )
}
