'use client'

/**
 * The always-visible GRID template gallery at the top of the Workflows page.
 *
 * Card anatomy mirrors the click dummy exactly: an outer subtle-surface shell
 * (radius 12, 0.5px hairline, soft card shadow) wrapping an inner white block
 * (bg-card, hairline divider, radius 0 0 10px, pad 16). The inner block holds
 * an icon tile in the template's provenance tint (spec §4 `--source-*` tokens —
 * law-blue for the regulation briefs, project-green for the documentation
 * check), a right-aligned uppercase category pill, the template name and an
 * honest one-two-line description. A footer strip on the subtle surface carries
 * the honest, cron-derived cadence hint on the left and the primary action on
 * the right. Selecting a card never creates or runs a workflow — it opens the
 * builder PRE-FILLED so the user reviews the brief and saves it. A dashed
 * "More coming" placeholder closes the grid.
 */

import { useEffect, useState, type JSX } from 'react'
import { ArrowRight, Clock, FileCheck2, Plus, ShieldCheck, type LucideIcon } from 'lucide-react'
import { useLocale, useTranslations, type Translator } from '@/i18n'
import { listGalleryTemplates } from '@/adapters/api/platform-workflow-templates-client'
import { presetForCron } from '../lib/schedule'
import {
  resolveAllTemplates,
  resolveGalleryTemplate,
  type ResolvedTemplate,
  type TemplateProvenance,
} from '../lib/templates'

interface TemplateCardsProps {
  onUse: (template: ResolvedTemplate) => void
}

/** The strong hairline (ink-border .16) the dummy uses for card + dashed edges. */
const HAIRLINE = 'color-mix(in oklch, var(--ink-border) 16%, transparent)'

/** Provenance tint + base + text CSS vars (tokens only, both modes). */
const PROVENANCE: Record<TemplateProvenance, { tint: string; base: string; text: string }> = {
  law: {
    tint: 'var(--source-law-tint)',
    base: 'var(--source-law)',
    text: 'var(--source-law-text)',
  },
  project: {
    tint: 'var(--source-project-tint)',
    base: 'var(--source-project)',
    text: 'var(--source-project-text)',
  },
  office: {
    tint: 'var(--source-office-tint)',
    base: 'var(--source-office)',
    text: 'var(--source-office-text)',
  },
  auto: {
    tint: 'var(--source-auto-tint)',
    base: 'var(--source-auto)',
    text: 'var(--source-auto-text)',
  },
}

/** The signal icon per template (falls back by provenance). */
const TILE_ICON: Record<string, LucideIcon> = {
  'submission-precheck': FileCheck2,
  'regulatory-watch': Clock,
  'compliance-gap-check': ShieldCheck,
}

function tileIcon(template: ResolvedTemplate): LucideIcon {
  return (
    TILE_ICON[template.id] ??
    (template.provenance === 'project' ? ShieldCheck : FileCheck2)
  )
}

/**
 * Honest cadence hint derived from the template's real cron (no fake duration
 * claims): a preset maps to its localized "Runs weekly"-style label, anything
 * else shows the cron itself, and no cron means on-demand.
 */
function cadenceLabel(t: Translator, cron: string | undefined): string {
  if (!cron) return t('templates.cadence.manual')
  const preset = presetForCron(cron)
  if (preset === 'custom') return t('templates.cadence.custom', { cron })
  return t(`templates.cadence.${preset}`)
}

export function TemplateCards({ onUse }: TemplateCardsProps): JSX.Element {
  const t = useTranslations('workflows')
  const { locale } = useLocale()
  const builtins = resolveAllTemplates(t)

  // Platform-published templates (ADR-0027) are additive: they merge in after
  // the built-ins once fetched. A failure leaves the built-in gallery intact —
  // it must never block the always-available defaults, so errors are swallowed.
  const [platform, setPlatform] = useState<ResolvedTemplate[]>([])
  useEffect(() => {
    let cancelled = false
    listGalleryTemplates()
      .then((rows) => {
        if (!cancelled) setPlatform(rows.map((row) => resolveGalleryTemplate(row, locale)))
      })
      .catch(() => {
        if (!cancelled) setPlatform([])
      })
    return () => {
      cancelled = true
    }
  }, [locale])

  const templates = [...builtins, ...platform]

  return (
    <div
      className="grid gap-[18px] sm:grid-cols-2 lg:grid-cols-3"
      data-testid="workflow-templates"
    >
      {templates.map((template) => {
        const prov = PROVENANCE[template.provenance]
        const Icon = tileIcon(template)
        return (
          <div
            key={template.id}
            className="flex flex-col overflow-hidden rounded-xl"
            style={{
              background: 'var(--input-background)',
              border: `0.5px solid ${HAIRLINE}`,
              boxShadow: '0 2px 4px -1px color-mix(in oklch, var(--ink-border) 8%, transparent)',
            }}
          >
            {/* Inner white block. */}
            <div
              className="flex-1 rounded-b-[10px] bg-card p-4"
              style={{
                boxShadow: '0 0.5px 0 color-mix(in oklch, var(--ink-border) 18%, transparent)',
              }}
            >
              <div className="flex items-center gap-2.5">
                <span
                  className="flex size-9 shrink-0 items-center justify-center rounded-[10px]"
                  style={{ background: prov.tint, color: prov.base }}
                  aria-hidden
                >
                  <Icon className="size-[17px]" strokeWidth={1.8} />
                </span>
                <span
                  className="ml-auto inline-flex shrink-0 items-center gap-[5px] rounded-[7px] px-[9px] py-1 text-[10.5px] font-semibold uppercase tracking-[0.04em]"
                  style={{ background: prov.tint, color: prov.text }}
                >
                  {template.provenance === 'law' && (
                    <span className="font-bold leading-none" style={{ color: prov.base }}>
                      §
                    </span>
                  )}
                  {template.category}
                </span>
              </div>
              <h3 className="mt-[14px] text-sm font-medium text-foreground">{template.name}</h3>
              <p className="mt-1 text-[12.5px] leading-[1.55] text-muted-foreground">
                {template.description}
              </p>
            </div>

            {/* Footer strip on the subtle surface. */}
            <div className="flex items-center gap-2 px-4 pb-[10px] pt-[9px]">
              <span className="text-xs" style={{ color: 'var(--text-color-placeholder)' }}>
                {cadenceLabel(t, template.scheduleCron)}
              </span>
              <button
                type="button"
                onClick={() => onUse(template)}
                aria-label={t('templates.setUpAria', { name: template.name })}
                className="ml-auto inline-flex h-[30px] shrink-0 items-center gap-1.5 rounded-[10px] bg-primary px-[13px] text-[12.5px] font-medium text-primary-foreground shadow-xs transition-colors hover:bg-interaction-primary-hover"
              >
                {t('templates.setUp')}
                <ArrowRight className="size-[13px]" strokeWidth={2.2} aria-hidden />
              </button>
            </div>
          </div>
        )
      })}

      {/* "More coming" placeholder — deliberately not interactive. */}
      <div
        className="flex min-h-[200px] flex-col items-center justify-center gap-2 rounded-xl p-5 text-center"
        style={{ border: `1.5px dashed ${HAIRLINE}` }}
        data-testid="workflow-templates-placeholder"
      >
        <span
          className="flex size-9 items-center justify-center rounded-[10px]"
          style={{ border: `1.5px dashed ${HAIRLINE}`, color: 'var(--text-color-placeholder)' }}
          aria-hidden
        >
          <Plus className="size-4" />
        </span>
        <p className="text-[13px] font-medium" style={{ color: 'var(--text-color-placeholder)' }}>
          {t('templates.moreComing.title')}
        </p>
        <p
          className="max-w-[220px] text-xs leading-[1.5]"
          style={{ color: 'var(--text-color-placeholder)' }}
        >
          {t('templates.moreComing.hint')}
        </p>
      </div>
    </div>
  )
}
