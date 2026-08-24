'use client'

/**
 * What the FILE is, when the file is a building — the model's own facts, in the
 * metadata rail of the Dateien preview.
 *
 * ## Why
 *
 * That rail answers "what did Grid make of this file", and for every other
 * format it does: pages, passages, detected type. For a model it answered with
 * the digest's numbers — *Passagen 6* — which are true of the paragraph of prose
 * written ABOUT the building and say nothing about the building. An architect
 * looking at 148 MB of their own model was told how many retrieval chunks its
 * summary produced.
 *
 * So the rail states the model: how many storeys, how many elements, how many
 * rooms, and the floor area IF the export published one. Every number here is
 * read from the model at extraction; nothing is inferred and nothing is summed
 * in the browser.
 *
 * ## Why an absent area is not a zero
 *
 * `quantityTotals` is null when the export published no such quantity — common
 * in IFC2X3, where Qto_* sets are frequently missing entirely. Printing 0 m²
 * would state that a building has no floor area. The row is omitted instead,
 * and the model page's Modellprüfung is where "your export publishes no
 * quantities" is said in full.
 */

import { useMemo } from 'react'
import { Boxes, Layers3, Ruler, ScrollText, Square } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useLocale, useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { useDocumentBimModel, useProjectBimModels } from '../hooks/use-bim-model'
import { formatMeasure } from '../lib/format-value'

interface IfcFileFactsProps {
  /** The document being previewed; its model carries the facts. */
  documentId: string
  /**
   * The project whose model list resolves this file, when the surface has one.
   * Absent in the org-wide Archiv, where the model is looked up by its document
   * instead — see {@link IfcFilePreview} for why that path exists at all.
   */
  projectId?: string | null
  className?: string
}

export function IfcFileFacts({ documentId, projectId, className }: IfcFileFactsProps): JSX.Element | null {
  const t = useTranslations('bim')
  const { locale } = useLocale()
  // Shares the in-flight request with the viewport beside it — the project list
  // (see `fetchProjectModels`) or the document lookup (`fetchDocumentModel`),
  // whichever the surface uses — so the rail costs nothing extra either way.
  const { data: models } = useProjectBimModels(projectId ?? null)
  const { data: documentModel } = useDocumentBimModel(projectId ? null : documentId)

  const model = useMemo(
    () =>
      projectId
        ? (models?.find((candidate) => candidate.documentId === documentId) ?? null)
        : documentModel,
    [projectId, models, documentModel, documentId]
  )
  const summary = model?.status === 'ready' ? model.summary : null

  const rows = useMemo(() => {
    if (!summary) return []
    const areaUnit = summary.units.area?.symbol ?? 'm²'
    // Grouped like the area beside them. `String(1842)` next to `1.240,5 m²`
    // reads as two different kinds of number, and four unbroken digits are
    // measurably slower to take in than `1.842`.
    const count = (value: number): string => value.toLocaleString(locale)
    const entries: Array<{ label: string; value: string; icon: LucideIcon }> = [
      { label: t('overview.storeys'), value: count(summary.totals.storeys), icon: Layers3 },
      { label: t('overview.elements'), value: count(summary.totals.elements), icon: Boxes },
      { label: t('overview.spaces'), value: count(summary.totals.spaces), icon: Square },
    ]
    // Only when the export actually published it — see the header note.
    if (summary.quantityTotals.netFloorAreaM2 !== null) {
      entries.push({
        label: t('overview.netFloorArea'),
        value: formatMeasure(summary.quantityTotals.netFloorAreaM2, areaUnit, locale),
        icon: Ruler,
      })
    }
    if (summary.schema) {
      entries.push({ label: t('overview.schema'), value: summary.schema, icon: ScrollText })
    }
    return entries
  }, [summary, t, locale])

  // Nothing read yet (extracting, failed, or another project's file): the
  // viewport in the same pane already says which of those it is, and a second
  // empty panel saying it again is noise.
  if (rows.length === 0) return null

  return (
    <section className={cn('space-y-3', className)} aria-label={t('facts.title')}>
      <p className="flex items-center gap-1.5 text-xs font-semibold tracking-wide text-muted-foreground">
        <Boxes className="size-3.5 shrink-0" aria-hidden />
        {t('facts.title')}
      </p>
      <div className="space-y-2">
        {rows.map((row) => (
          <div key={row.label} className="flex items-start justify-between gap-3">
            <span className="flex shrink-0 items-center gap-1.5 pt-px text-xs text-muted-foreground">
              <row.icon className="size-3.5 shrink-0 text-muted-foreground/70" aria-hidden />
              {row.label}
            </span>
            <span className="min-w-0 text-right text-xs font-medium tabular-nums text-foreground">
              {row.value}
            </span>
          </div>
        ))}
      </div>
      <p className="text-xs leading-relaxed text-muted-foreground/80">{t('facts.caption')}</p>
    </section>
  )
}

export default IfcFileFacts
