'use client'

/**
 * What one upload brought in (ADR-0086; ticket „Übersicht"): the counts at a
 * glance, where it went, what kinds of documents arrived, what the office's
 * screening kept on the uploader's machine, and every file by folder with how
 * it ended.
 *
 * {@link UploadSummaryView} draws a summary it is handed, so the preview route
 * and the specs render the real thing; {@link UploadSummaryDialog} is the
 * route-backed modal an inbox row opens, which loads it and keeps it current
 * while Piloti is still reading.
 */

import type { JSX } from 'react'
import { useMemo } from 'react'
import Link from 'next/link'
import { Clock3, FileX, SearchX } from 'lucide-react'

import type { UploadSummary } from '@/adapters/api/upload-batches-client'
import { RouteDialog } from '@/components/shell/route-dialog'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { ItemList } from '@/components/ui/item'
import { SectionLabel } from '@/components/ui/section-label'
import { Skeleton } from '@/components/ui/skeleton'
import { TimeAgo } from '@/components/ui/time-ago'
import { useLocale, useTranslations } from '@/i18n'
import { useProjectName, useUploadSummary, type UploadSummaryState } from '../hooks/use-upload-summary'
import {
  documentHref,
  documentTypeCounts,
  formatFolderPath,
  groupByFolder,
  isSettling,
  placeHref,
  tallySummary,
  visibleTally,
} from '../lib/upload-summary'
import { FolderHeading, NamedCount, TallyTile, useTallyLabel } from './upload-atoms'
import { UploadedFileRow } from './uploaded-file-row'

/** The summary's sections. Each opens with the design language's eyebrow. */
function Section({ label, testId, children }: { label: string; testId: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3" aria-label={label} data-testid={testId}>
      <SectionLabel as="h3">{label}</SectionLabel>
      {children}
    </section>
  )
}

export function UploadSummaryView({ summary }: { summary: UploadSummary }): JSX.Element {
  const t = useTranslations('uploadBatches')
  const tallyLabel = useTallyLabel()
  const tally = useMemo(() => tallySummary(summary), [summary])
  const groups = useMemo(() => groupByFolder(summary.documents), [summary.documents])
  const types = useMemo(() => documentTypeCounts(summary.documents), [summary.documents])

  return (
    <div className="space-y-7" data-testid="upload-summary">
      <Section label={t('summary.counts.label')} testId="upload-summary-counts">
        <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          {visibleTally(tally).map(({ key, count }) => (
            <TallyTile key={key} tally={key} count={count} label={tallyLabel(key)} />
          ))}
        </ul>
        {summary.failedCount > 0 && (
          <p className="text-error text-sm" data-testid="upload-summary-upload-failed">
            {t('summary.uploadFailed', { count: summary.failedCount })}
          </p>
        )}
      </Section>

      {types.length > 0 && (
        <Section label={t('summary.types.title')} testId="upload-summary-types">
          <ul className="flex flex-wrap gap-1.5">
            {types.map(({ type, count }) => (
              <li key={type} className="max-w-full">
                <NamedCount name={type} count={count} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      {summary.excluded.length > 0 && (
        <Section label={t('summary.excluded.title')} testId="upload-summary-excluded">
          <p className="text-muted-foreground text-sm leading-relaxed">{t('summary.excluded.description')}</p>
          <ul className="flex flex-wrap gap-1.5" aria-label={t('summary.excluded.listLabel')}>
            {summary.excluded.map(({ term, count }) => (
              <li key={term} className="max-w-full">
                <NamedCount name={term} count={count} />
              </li>
            ))}
          </ul>
        </Section>
      )}

      <Section label={t('summary.files.title')} testId="upload-summary-files">
        {groups.length === 0 ? (
          <EmptyState variant="bare" size="sm" icon={FileX} title={t('summary.files.empty')} className="py-6" />
        ) : (
          <div className="space-y-4">
            {groups.map((group) => (
              <div key={group.path ?? ''} className="space-y-2" data-testid={`upload-folder-${group.path ?? 'root'}`}>
                <FolderHeading
                  label={group.path ? formatFolderPath(group.path) : t(`summary.files.root.${summary.scope}`)}
                  count={group.documents.length}
                />
                <ItemList as="ul">
                  {group.documents.map((document) => (
                    <UploadedFileRow
                      key={document.id}
                      document={document}
                      href={documentHref(summary, document.id)}
                      shelf={summary.scope}
                    />
                  ))}
                </ItemList>
              </div>
            ))}
          </div>
        )}
      </Section>
    </div>
  )
}

/** Where the upload went, when, and whether it is still moving: the dialog's description. */
export function UploadSummaryMeta({
  summary,
  projectName,
}: {
  summary: UploadSummary
  projectName: string | null
}): JSX.Element {
  const t = useTranslations('uploadBatches')
  const { locale } = useLocale()
  const place = summary.scope === 'project' ? (projectName ?? t('summary.place.project')) : t(`summary.place.${summary.scope}`)
  const href = placeHref(summary)
  const state = !summary.sealedAt ? 'sending' : isSettling(summary) ? 'reading' : 'done'

  return (
    <div className="space-y-1" data-testid="upload-summary-meta">
      <p className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-1.5 text-sm">
        {href ? (
          <Link
            href={href}
            title={t(`summary.open.${summary.scope}`)}
            className="text-foreground focus-visible:ring-ring/50 min-w-0 truncate rounded-sm font-medium underline-offset-2 hover:underline focus-visible:ring-2 focus-visible:outline-none"
          >
            {place}
          </Link>
        ) : (
          <span className="text-foreground min-w-0 truncate font-medium">{place}</span>
        )}
        <span aria-hidden>·</span>
        <TimeAgo date={summary.createdAt} locale={locale} />
      </p>
      <p className="text-muted-foreground flex items-center gap-1.5 text-xs" data-testid="upload-summary-state">
        {state !== 'done' && <Clock3 className="size-3.5 shrink-0" aria-hidden />}
        {t(`summary.state.${state}`)}
      </p>
    </div>
  )
}

function UploadSummarySkeleton(): JSX.Element {
  const t = useTranslations('uploadBatches')
  return (
    <div className="space-y-7" aria-busy="true" aria-label={t('summary.loading')} data-testid="upload-summary-loading">
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {Array.from({ length: 3 }, (_, index) => (
          <Skeleton key={index} className="h-[3.25rem]" />
        ))}
      </div>
      <div className="space-y-2">
        {Array.from({ length: 4 }, (_, index) => (
          <Skeleton key={index} className="h-16" />
        ))}
      </div>
    </div>
  )
}

/** Whatever the summary's state calls for: the summary, its skeleton, the not-found answer, or a retry. */
export function UploadSummaryBody({ state, retry }: { state: UploadSummaryState; retry: () => void }): JSX.Element {
  const t = useTranslations('uploadBatches')
  const tCommon = useTranslations('common')
  switch (state.status) {
    case 'loading':
      return <UploadSummarySkeleton />
    case 'not-found':
      return (
        <EmptyState
          variant="bare"
          icon={SearchX}
          title={t('summary.notFound.title')}
          description={t('summary.notFound.description')}
          data-testid="upload-summary-not-found"
        />
      )
    case 'error':
      return (
        <Alert variant="destructive" data-testid="upload-summary-error">
          <AlertTitle>{t('summary.error.title')}</AlertTitle>
          <AlertDescription className="flex flex-col items-start gap-3">
            {t('summary.error.description')}
            <Button variant="outline" size="sm" onClick={retry}>
              {tCommon('actions.retry')}
            </Button>
          </AlertDescription>
        </Alert>
      )
    case 'ready':
      return <UploadSummaryView summary={state.summary} />
  }
}

/**
 * The summary as a route-backed modal. `standalone` is the hard load of
 * `/app/uploads/<id>`; closing it then lands where the upload went.
 */
export function UploadSummaryDialog({ batchId, standalone }: { batchId: string; standalone: boolean }): JSX.Element {
  const t = useTranslations('uploadBatches')
  const tCommon = useTranslations('common')
  const { state, retry } = useUploadSummary(batchId)
  const summary = state.status === 'ready' ? state.summary : null
  const projectName = useProjectName(summary?.scope === 'project' ? summary.projectId : null)

  return (
    <RouteDialog
      title={t('summary.title')}
      description={summary ? <UploadSummaryMeta summary={summary} projectName={projectName} /> : undefined}
      closeLabel={tCommon('actions.close')}
      standalone={standalone}
      fallbackHref={(summary && placeHref(summary)) ?? '/app/projects'}
      testId="upload-summary-dialog"
    >
      <UploadSummaryBody state={state} retry={retry} />
    </RouteDialog>
  )
}
