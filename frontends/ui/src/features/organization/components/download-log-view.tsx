'use client'

/**
 * Organisation -> Download-Protokoll: who took which document out, and who
 * opened one in a folder with its own access list (ADR-0085).
 *
 * Personal data about staff, so the page is plain about three things before it
 * shows a row: what the log is for (security and accountability, nothing like
 * an activity report), how long it is kept, and that reading it is itself
 * recorded. There is deliberately no total per person, no chart and no ranking:
 * a list of events, newest first, filtered by the three questions an admin has
 * (who, which document, when) and nothing that aggregates.
 *
 * The server is the authority: it refuses anyone without `org:downloads:view`,
 * and it refuses to answer when it cannot record the read, in which case this
 * page shows the failure and no rows.
 */

import { type FC, useCallback, useEffect, useRef, useState } from 'react'
import { History, ScrollText } from 'lucide-react'

import {
  fetchDownloadLog,
  NO_FILTERS,
  type DownloadLogEntry,
  type DownloadLogFilters,
} from '@/adapters/api/download-log-client'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { ProjectClosedChip } from '@/components/projects/project-status'
import { EmptyState } from '@/components/ui/empty-state'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useLocale, useTranslations } from '@/i18n'
import { DOWNLOAD_LOG_KINDS } from '@/lib/download-log/kinds'
import { formatAbsoluteTime } from '@/lib/format'

export interface DownloadLogPerson {
  id: string
  name: string | null
  email: string
}

interface DownloadLogViewProps {
  /** The organization's members, for the person filter. Empty when WorkOS could not be asked. */
  people: readonly DownloadLogPerson[]
}

/** Radix Select cannot hold an empty value, so "no filter" has its own. */
const ANY = '__any__'

export const DownloadLogView: FC<DownloadLogViewProps> = ({ people }) => {
  const t = useTranslations('organization')
  const { locale } = useLocale()
  const [draft, setDraft] = useState<DownloadLogFilters>(NO_FILTERS)
  const [applied, setApplied] = useState<DownloadLogFilters>(NO_FILTERS)
  const [entries, setEntries] = useState<DownloadLogEntry[] | null>(null)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [retentionDays, setRetentionDays] = useState<number | null>(null)
  const [loading, setLoading] = useState(false)
  const [failed, setFailed] = useState(false)
  // The newest request wins: a slow first page must not overwrite a newer filter's rows.
  const requestRef = useRef(0)

  const load = useCallback(async (filters: DownloadLogFilters, cursor: string | null) => {
    const request = ++requestRef.current
    setLoading(true)
    setFailed(false)
    try {
      const page = await fetchDownloadLog(filters, cursor)
      if (request !== requestRef.current) return
      setEntries((previous) => (cursor && previous ? [...previous, ...page.entries] : page.entries))
      setNextCursor(page.nextCursor)
      setRetentionDays(page.retentionDays)
    } catch {
      if (request !== requestRef.current) return
      setFailed(true)
      if (!cursor) setEntries(null)
    } finally {
      if (request === requestRef.current) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load(NO_FILTERS, null)
  }, [load])

  const apply = (): void => {
    setApplied(draft)
    setEntries(null)
    void load(draft, null)
  }
  const reset = (): void => {
    setDraft(NO_FILTERS)
    setApplied(NO_FILTERS)
    setEntries(null)
    void load(NO_FILTERS, null)
  }

  const personLabel = (entry: DownloadLogEntry): string =>
    entry.person ? `${entry.person.name}${entry.person.email ? ` (${entry.person.email})` : ''}` : entry.userId

  const placeLabel = (entry: DownloadLogEntry): string => {
    if (entry.scope === 'archiv') return t('downloadLog.place.archiv')
    if (entry.scope === 'session') return t('downloadLog.place.session')
    const project = entry.projectName ?? t('downloadLog.place.projectGone')
    if (!entry.folderId) return `${project} · ${t('downloadLog.place.root')}`
    return `${project} · ${entry.folderPath ?? t('downloadLog.place.folderGone')}`
  }

  const filtered = Object.values(applied).some((value) => value !== '')

  return (
    <div className="flex flex-col gap-4" data-testid="download-log">
      <div className="text-muted-foreground flex flex-col gap-1 text-sm">
        <p>{t('downloadLog.purpose')}</p>
        <p>
          {retentionDays !== null ? t('downloadLog.retention', { days: retentionDays }) : null}{' '}
          {t('downloadLog.readRecorded')}
        </p>
      </div>

      <form
        className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-6"
        aria-label={t('downloadLog.filters.label')}
        onSubmit={(event) => {
          event.preventDefault()
          apply()
        }}
      >
        <Field className="lg:col-span-2">
          <FieldLabel>{t('downloadLog.filters.person')}</FieldLabel>
          <Select
            value={draft.userId || ANY}
            onValueChange={(value) => setDraft({ ...draft, userId: value === ANY ? '' : value })}
          >
            <SelectTrigger className="w-full" aria-label={t('downloadLog.filters.person')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('downloadLog.filters.allPeople')}</SelectItem>
              {people.map((person) => (
                <SelectItem key={person.id} value={person.id}>
                  {person.name ? `${person.name} (${person.email})` : person.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field className="lg:col-span-2">
          <FieldLabel htmlFor="download-log-document">{t('downloadLog.filters.document')}</FieldLabel>
          <Input
            id="download-log-document"
            value={draft.document}
            maxLength={200}
            placeholder={t('downloadLog.filters.documentPlaceholder')}
            onChange={(event) => setDraft({ ...draft, document: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="download-log-from">{t('downloadLog.filters.from')}</FieldLabel>
          <Input
            id="download-log-from"
            type="date"
            value={draft.from}
            max={draft.to || undefined}
            onChange={(event) => setDraft({ ...draft, from: event.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="download-log-to">{t('downloadLog.filters.to')}</FieldLabel>
          <Input
            id="download-log-to"
            type="date"
            value={draft.to}
            min={draft.from || undefined}
            onChange={(event) => setDraft({ ...draft, to: event.target.value })}
          />
        </Field>
        <Field className="lg:col-span-2">
          <FieldLabel>{t('downloadLog.filters.kind')}</FieldLabel>
          <Select
            value={draft.kind || ANY}
            onValueChange={(value) => setDraft({ ...draft, kind: value === ANY ? '' : value })}
          >
            <SelectTrigger className="w-full" aria-label={t('downloadLog.filters.kind')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>{t('downloadLog.filters.allKinds')}</SelectItem>
              {DOWNLOAD_LOG_KINDS.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {t(`downloadLog.kinds.${kind}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <div className="flex items-end gap-2 lg:col-span-2">
          <Button type="submit" disabled={loading}>
            {t('downloadLog.filters.apply')}
          </Button>
          <Button type="button" variant="ghost" onClick={reset} disabled={loading || (!filtered && JSON.stringify(draft) === JSON.stringify(NO_FILTERS))}>
            {t('downloadLog.filters.reset')}
          </Button>
        </div>
      </form>

      {failed && entries === null ? (
        <EmptyState
          title={t('downloadLog.loadError')}
          action={
            <Button variant="outline" size="sm" onClick={() => void load(applied, null)}>
              {t('downloadLog.retry')}
            </Button>
          }
        />
      ) : entries === null ? (
        <div className="flex flex-col gap-2" aria-busy="true" aria-label={t('downloadLog.loading')}>
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : entries.length === 0 ? (
        <EmptyState
          icon={ScrollText}
          title={t('downloadLog.empty')}
          description={t('downloadLog.emptyHint')}
          data-testid="download-log-empty"
        />
      ) : (
        <>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('downloadLog.columns.when')}</TableHead>
                <TableHead>{t('downloadLog.columns.person')}</TableHead>
                <TableHead>{t('downloadLog.columns.action')}</TableHead>
                <TableHead>{t('downloadLog.columns.document')}</TableHead>
                <TableHead>{t('downloadLog.columns.place')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {entries.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell className="whitespace-nowrap">
                    <time dateTime={entry.occurredAt}>{formatAbsoluteTime(entry.occurredAt, locale)}</time>
                  </TableCell>
                  <TableCell className="font-medium">
                    {personLabel(entry)}
                    {!entry.person && <span className="text-muted-foreground block text-xs font-normal">{t('downloadLog.unknownPerson')}</span>}
                  </TableCell>
                  <TableCell>
                    <Chip variant={entry.access === 'download' ? 'info' : 'muted'} size="sm">
                      {t(`downloadLog.kinds.${entry.kind}`)}
                    </Chip>
                  </TableCell>
                  <TableCell>
                    <span className="break-words">{entry.documentName}</span>
                    {entry.versionId && (
                      <span className="text-muted-foreground block text-xs">
                        {t('downloadLog.version', { id: entry.versionId.slice(0, 8) })}
                      </span>
                    )}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {placeLabel(entry)}
                    {entry.projectStatus === 'closed' && (
                      <ProjectClosedChip projectName={entry.projectName} className="ml-2" />
                    )}
                    {entry.ownList && (
                      <Chip variant="warning" size="sm" className="ml-2">
                        {t('downloadLog.place.ownList')}
                      </Chip>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {failed && <p role="alert" className="text-error text-sm">{t('downloadLog.loadError')}</p>}
          {nextCursor && (
            <div>
              <Button variant="outline" onClick={() => void load(applied, nextCursor)} disabled={loading}>
                <History aria-hidden />
                {loading ? t('downloadLog.loading') : t('downloadLog.loadMore')}
              </Button>
            </div>
          )}
        </>
      )}
    </div>
  )
}
