'use client'

import type { JSX } from 'react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { History } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { SectionLabel } from '@/components/ui/section-label'
import { useTranslations } from '@/i18n'
import type { FassungFacts } from '@/lib/documents/fassung'
import type { FileItem } from '../file-types'
import { setFassungLink } from '../lib/fassung-request'

/**
 * Where this document stands among its Fassungen, and Piloti's suggestion when
 * it thinks the document replaces another.
 *
 * feld72 asked for exactly this (Jour fixe, 2026-10-09): „nur der aktuellste
 * Planstand ist Grundlage, ältere nur auf Wunsch“ — and „Automatik nur als
 * Vorschlag mit Rückfrage und manueller Bestätigung“, also when a new state
 * does NOT carry the old file name. So Piloti suggests (from the name, or from
 * reading both documents) and a person confirms. Once confirmed, the older
 * document stays where it is and stays readable, but answers come from the
 * newer one, and Piloti says what changed between the two.
 *
 * Every name shown here is one the reader may see: the BFF drops a reference
 * to a document held from them (`lib/documents/fassung.ts`).
 */
export function FassungPanel({
  file,
  canManage,
  onFassungChanged,
}: {
  file: FileItem
  canManage: boolean
  onFassungChanged?: (fileId: string, fassung: FassungFacts) => void
}): JSX.Element | null {
  const t = useTranslations('files')
  // The rail is reused across files; a decision just made belongs to one.
  const [facts, setFacts] = useState<FassungFacts | null>(file.fassung ?? null)
  const [busy, setBusy] = useState(false)
  // A decision answered after the rail moved to another file belongs to the old one.
  const currentId = useRef(file.id)
  currentId.current = file.id
  useEffect(() => setFacts(file.fassung ?? null), [file.id, file.fassung])

  if (!facts) return null
  const { supersededBy, supersedes, suggestion, changeSummary } = facts
  if (!supersededBy && supersedes.length === 0 && !suggestion && !changeSummary) return null

  const decide = async (olderId: string, linked: boolean) => {
    const fileId = file.id
    setBusy(true)
    try {
      const next = await setFassungLink(fileId, olderId, linked)
      onFassungChanged?.(fileId, next)
      if (currentId.current === fileId) setFacts(next)
    } catch {
      if (currentId.current === fileId) toast.error(t('preview.fassung.saveError'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="space-y-2.5" aria-label={t('preview.fassung.title')} data-testid="fassung-panel">
      <SectionLabel as="p" icon={History} className="font-semibold tracking-[0.05em]">
        {t('preview.fassung.title')}
      </SectionLabel>

      {supersededBy && (
        <div className="bg-muted/60 flex flex-col gap-1.5 rounded-md px-3 py-2.5" data-testid="fassung-superseded">
          <p className="text-foreground text-[13px] leading-snug">
            {t('preview.fassung.supersededBy', { name: supersededBy.filename })}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">{t('preview.fassung.supersededHint')}</p>
        </div>
      )}

      {supersedes.length > 0 && (
        <ul className="flex flex-col gap-1" data-testid="fassung-supersedes">
          {supersedes.map((ref) => (
            <li key={ref.id} className="text-foreground text-[13px] leading-snug">
              {t('preview.fassung.supersedes', { names: ref.filename })}
              {canManage && (
                <Button
                  type="button"
                  variant="link"
                  size="sm"
                  disabled={busy}
                  className="text-muted-foreground hover:text-foreground ml-1 h-auto px-1 py-0 text-xs"
                  onClick={() => void decide(ref.id, false)}
                >
                  {t('preview.fassung.unlink')}
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {changeSummary && (
        <div className="flex flex-col gap-1" data-testid="fassung-change">
          <p className="text-muted-foreground text-xs">
            {changeSummary.basis === 'previous'
              ? t('preview.fassung.changedSincePrevious')
              : t('preview.fassung.changedSince', { name: changeSummary.basis.filename })}
          </p>
          <ul className="text-foreground flex flex-col gap-0.5 text-[13px] leading-snug">
            {changeLines(changeSummary.text).map((line, index) => (
              <li key={index} className="before:text-muted-foreground flex gap-1.5 before:content-['–']">
                {line}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs leading-relaxed">{t('preview.fassung.changeHint')}</p>
        </div>
      )}

      {suggestion && (
        <div className="flex flex-col gap-2 rounded-md border border-dashed px-3 py-2.5" data-testid="fassung-suggestion">
          <p className="text-foreground text-[13px] leading-snug">
            {t('preview.fassung.suggestion', { name: suggestion.of.filename })}
          </p>
          <p className="text-muted-foreground text-xs leading-relaxed">
            {t(suggestion.basis === 'name' ? 'preview.fassung.basisName' : 'preview.fassung.basisContent')}
            {suggestion.reason ? ` ${suggestion.reason}` : ''}
          </p>
          {canManage ? (
            <div className="flex flex-wrap gap-1.5">
              <Button type="button" size="sm" className="h-7" disabled={busy} onClick={() => void decide(suggestion.of.id, true)}>
                {t('preview.fassung.confirm')}
              </Button>
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="h-7"
                disabled={busy}
                onClick={() => void decide(suggestion.of.id, false)}
              >
                {t('preview.fassung.dismiss')}
              </Button>
            </div>
          ) : (
            <p className="text-muted-foreground text-xs">{t('preview.fassung.askEditor')}</p>
          )}
        </div>
      )}
    </section>
  )
}

/** The model writes bullet lines; a stray marker or blank line is not content. */
export function changeLines(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-–—•*]|\d+[.)])\s*/, '').trim())
    .filter(Boolean)
}
