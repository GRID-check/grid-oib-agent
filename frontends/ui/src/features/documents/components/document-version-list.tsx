'use client'

/**
 * A document's versions: what state each is in, who moved it and when, the
 * reviewer's words, a way to open the bytes, and a side-by-side comparison.
 *
 * ## Why the comparison is not a diff
 *
 * The route hands back BOTH contents and does not diff (`versions/diff`): word
 * or line granularity, whitespace, and whether a moved paragraph is a move or a
 * delete-plus-insert are rendering decisions. Rendering them properly needs a
 * diff implementation, and this repository has none — no `diff`, no
 * `diff-match-patch`, in `package.json` or in `node_modules`. So this shows the
 * two texts beside each other and says so; it does not fake alignment by
 * colouring rows that happen to share an index, which is wrong the moment a line
 * is inserted and is worse than no marking at all. Adding the dependency is a
 * decision with its own PR (the "buy, don't build" rule cuts that way here — the
 * library exists, we simply have not adopted one).
 *
 * ## Names
 *
 * A version row carries WorkOS user ids. The reader gets „Sie" for themselves, a
 * resolved name where the surface already knows one (the document's assignees),
 * and „Jemand" otherwise — never the raw id, which is an identifier leaking into
 * copy (the inbox's own rule).
 */

import { useState } from 'react'
import { ExternalLink, GitCompare } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { Spinner } from '@/components/ui/spinner'
import { useLocale, useTranslations } from '@/i18n'
import { formatAbsoluteTime } from '@/lib/format'
import { cn } from '@/lib/utils'
import type {
  DocumentVersionDiffResponse,
  DocumentVersionView,
} from '@/lib/documents/lifecycle-types'
import { DocumentVersionStateBadge } from './document-version-badge'

export interface DocumentVersionListProps {
  documentId: string
  versions: readonly DocumentVersionView[]
  publishedVersionId: string | null
  /** The reader, so their own acts read as „Sie" rather than as a name. */
  viewerUserId?: string | null
  /** Names the surface already knows, by user id. */
  names?: Readonly<Record<string, string>>
  /** Load both contents for a comparison. The panel passes the typed client's. */
  onCompare: (fromId: string, toId: string) => Promise<DocumentVersionDiffResponse>
  className?: string
}

/** The three acts a version row reports, in the order they happen. */
const MILESTONES = [
  { key: 'submitted', by: 'submittedBy', at: 'submittedAt' },
  { key: 'approved', by: 'approvedBy', at: 'approvedAt' },
  { key: 'published', by: 'publishedBy', at: 'publishedAt' },
] as const satisfies readonly {
  key: string
  by: keyof DocumentVersionView
  at: keyof DocumentVersionView
}[]

export function DocumentVersionList({
  documentId,
  versions,
  publishedVersionId,
  viewerUserId,
  names,
  onCompare,
  className,
}: DocumentVersionListProps): JSX.Element | null {
  const t = useTranslations('files')
  const { locale } = useLocale()
  const [comparison, setComparison] = useState<DocumentVersionDiffResponse | null>(null)
  const [comparing, setComparing] = useState(false)
  const [compareFailed, setCompareFailed] = useState(false)

  if (versions.length === 0) return null

  const nameOf = (userId: string | null): string => {
    if (!userId) return t('lifecycle.versions.someone')
    if (userId === viewerUserId) return t('lifecycle.versions.you')
    return names?.[userId] ?? t('lifecycle.versions.someone')
  }

  // Newest first: „was ist gerade los" is the question a version list is opened
  // with, and the answer is at the top of the table in the database.
  const ordered = [...versions].sort((a, b) => b.versionNumber - a.versionNumber)

  const compare = async (from: DocumentVersionView, to: DocumentVersionView) => {
    setComparing(true)
    setCompareFailed(false)
    try {
      setComparison(await onCompare(from.id, to.id))
    } catch {
      // One failed comparison is a line under the list, never a thrown render:
      // the version list itself is still the useful half of this panel.
      setCompareFailed(true)
      setComparison(null)
    } finally {
      setComparing(false)
    }
  }

  return (
    <section className={cn('space-y-2', className)} data-testid="document-version-list">
      <SectionLabel as="h3">{t('lifecycle.versions.title')}</SectionLabel>
      <ol className="space-y-1.5">
        {ordered.map((version, index) => {
          const previous = ordered[index + 1]
          return (
            <li
              key={version.id}
              className="rounded-lg border px-2.5 py-2"
              data-testid="document-version-row"
              data-version={version.versionNumber}
              data-state={version.state}
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="text-foreground shrink-0 text-xs font-medium tabular-nums">
                  {t('lifecycle.versions.number', { number: version.versionNumber })}
                </span>
                <DocumentVersionStateBadge versionState={version.state} always />
                {version.id === publishedVersionId && (
                  <span className="text-muted-foreground shrink-0 text-[11px]">
                    {t('lifecycle.versions.live')}
                  </span>
                )}
                <span className="flex-1" />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="h-7 gap-1.5 px-2 text-xs"
                  asChild
                >
                  <a
                    // The published version's bytes ARE the document's bytes —
                    // the item's storage columns mirror them — so it opens
                    // through the ordinary file route, which knows the content
                    // type. Every other version has only its text.
                    href={
                      version.id === publishedVersionId
                        ? `/api/documents/${documentId}/file`
                        : `/api/documents/${documentId}/versions/${version.id}/content`
                    }
                    target="_blank"
                    rel="noreferrer"
                    data-testid="document-version-open"
                  >
                    <ExternalLink className="size-3.5" aria-hidden />
                    {t('lifecycle.versions.open')}
                  </a>
                </Button>
                {previous && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="h-7 gap-1.5 px-2 text-xs"
                    disabled={comparing}
                    data-testid="document-version-compare"
                    onClick={() => void compare(previous, version)}
                  >
                    <GitCompare className="size-3.5" aria-hidden />
                    {t('lifecycle.versions.compare', { number: previous.versionNumber })}
                  </Button>
                )}
              </div>

              <dl className="mt-1 space-y-0.5">
                {MILESTONES.map(({ key, by, at }) => {
                  const actor = version[by]
                  const when = version[at]
                  if (typeof actor !== 'string' || typeof when !== 'string') return null
                  return (
                    <div key={key} className="text-muted-foreground flex gap-1.5 text-[11px]">
                      <dt className="shrink-0">{t(`lifecycle.versions.${key}`)}</dt>
                      <dd className="min-w-0 truncate">
                        {t('lifecycle.versions.byAt', {
                          name: nameOf(actor),
                          time: formatAbsoluteTime(when, locale),
                        })}
                      </dd>
                    </div>
                  )
                })}
              </dl>

              {version.reviewComment && (
                /* The reviewer's words, quoted on the version they are about —
                   which is what makes „was ist noch offen" answerable by reading
                   the row rather than by a state that has to be cleared. */
                <p
                  className="text-foreground mt-1.5 border-l-2 pl-2 text-[11px] leading-[1.5]"
                  data-testid="document-version-comment"
                >
                  {version.reviewComment}
                </p>
              )}
            </li>
          )
        })}
      </ol>

      {comparing && (
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Spinner className="size-3.5" />
          {t('lifecycle.versions.comparing')}
        </p>
      )}
      {compareFailed && (
        <p className="text-destructive text-xs" data-testid="document-version-compare-failed">
          {t('lifecycle.versions.compareFailed')}
        </p>
      )}
      {comparison && (
        <div className="space-y-1.5" data-testid="document-version-comparison">
          <p className="text-muted-foreground text-[11px]">
            {t('lifecycle.versions.comparisonNote')}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {[comparison.from, comparison.to].map((side) => (
              <figure key={side.version.id} className="min-w-0 space-y-1">
                <figcaption className="text-muted-foreground text-[11px]">
                  {t('lifecycle.versions.number', { number: side.version.versionNumber })}
                </figcaption>
                <pre className="bg-surface-sunken max-h-64 overflow-auto rounded-lg border p-2 text-[11px] leading-[1.5] whitespace-pre-wrap">
                  {side.content}
                </pre>
              </figure>
            ))}
          </div>
        </div>
      )}
    </section>
  )
}
