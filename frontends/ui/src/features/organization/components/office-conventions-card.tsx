'use client'

/**
 * Organisation → what Piloti has learned about the office's conventions
 * (ADR-0129): each counted line in German, with the count behind it, and a
 * button to confirm or decline it. Confirmed lines are kept for Piloti even
 * when later counts fall short; declined lines never reach it again. Taking a
 * decision back is the same button on the decided line.
 *
 * The lines are the server's (`GET /api/organization/office-conventions`); a
 * decision is one POST that returns the updated list.
 */

import { type FC, useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslations } from '@/i18n'
import { tagLabel } from '@/lib/documents/tag-vocabulary'
import type {
  ConventionLine,
  ConventionLineView,
  OfficeConventionsView,
} from '@/lib/office-conventions/office-conventions-wire'

const ENDPOINT = '/api/organization/office-conventions'

type Translate = ReturnType<typeof useTranslations>

/**
 * One line as a sentence; the folder and shape are the office's own words. The
 * Dokumentart is a stored tag, read through `labelOf` (`tagLabel` with the
 * `files` translator) so a token such as `correspondence` reads as its label.
 */
export function conventionSentence(
  t: Translate,
  line: ConventionLine,
  labelOf: (tag: string) => string = (tag) => tag
): string {
  switch (line.kind) {
    case 'filing':
      return t('officeConventions.line.filing', { docType: labelOf(line.docType), path: line.path })
    case 'folder':
      return t('officeConventions.line.folder', { path: line.path })
    case 'document_number':
      return t('officeConventions.line.documentNumber', { shape: line.shape })
    case 'revision_style':
      return t(`officeConventions.line.revisionStyle.${line.style}`)
    case 'file_date':
      return t('officeConventions.line.fileDate', { format: line.format })
  }
}

interface LineRowProps {
  view: ConventionLineView
  busy: boolean
  onDecide: (lineKey: string, decision: 'confirmed' | 'declined' | 'undecided') => void
}

const LineRow: FC<LineRowProps> = ({ view, busy, onDecide }) => {
  const t = useTranslations('organization')
  const tFiles = useTranslations('files')
  const { line, decision } = view
  return (
    <li className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:gap-4" data-testid="office-convention-line">
      <div className="min-w-0 flex-1">
        <p className={decision === 'declined' ? 'text-sm text-muted-foreground line-through' : 'text-sm'}>
          {conventionSentence(t, line, (tag) => tagLabel(tag, tFiles))}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {view.counted
            ? t('officeConventions.support', { projects: line.projects, of: line.of })
            : t('officeConventions.supportWhenConfirmed', { projects: line.projects, of: line.of })}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {decision === 'confirmed' && <Badge variant="success">{t('officeConventions.confirmed')}</Badge>}
        {decision === 'declined' && <Badge variant="secondary">{t('officeConventions.declined')}</Badge>}
        {decision === null ? (
          <>
            <Button size="sm" variant="outline" disabled={busy} onClick={() => onDecide(line.key, 'confirmed')}>
              {t('officeConventions.confirm')}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(line.key, 'declined')}>
              {t('officeConventions.decline')}
            </Button>
          </>
        ) : (
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => onDecide(line.key, 'undecided')}>
            {t('officeConventions.undo')}
          </Button>
        )}
      </div>
    </li>
  )
}

export const OfficeConventionsCard: FC = () => {
  const t = useTranslations('organization')
  const [view, setView] = useState<OfficeConventionsView | null>(null)
  const [failed, setFailed] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let cancelled = false
    fetch(ENDPOINT)
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status))
        const body = (await res.json()) as OfficeConventionsView
        if (!cancelled) setView(body)
      })
      .catch(() => {
        if (!cancelled) setFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const decide = useCallback(
    async (lineKey: string, decision: 'confirmed' | 'declined' | 'undecided') => {
      setBusy(true)
      try {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ lineKey, decision }),
        })
        if (!res.ok) throw new Error(String(res.status))
        setView((await res.json()) as OfficeConventionsView)
      } catch {
        toast.error(t('officeConventions.saveError'))
      } finally {
        setBusy(false)
      }
    },
    [t]
  )

  if (failed) return <EmptyState variant="bare" title={t('officeConventions.loadError')} />
  if (!view) return <Skeleton className="h-24 w-full" />
  if (view.lines.length === 0) {
    return (
      <EmptyState
        variant="bare"
        title={view.enabled ? t('officeConventions.empty') : t('officeConventions.off')}
      />
    )
  }
  return (
    <ul className="divide-y divide-border">
      {view.lines.map((entry) => (
        <LineRow key={entry.line.key} view={entry} busy={busy} onDecide={(key, d) => void decide(key, d)} />
      ))}
    </ul>
  )
}
