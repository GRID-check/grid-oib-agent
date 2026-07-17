'use client'

/**
 * The always-visible GRID template gallery at the top of the Workflows page.
 *
 * Each card: an icon in its provenance tint (spec §4 `--source-*` tokens —
 * law-blue for regulation-flavored briefs, project-green for the
 * documentation-driven check), the template name, an honest one-two-line
 * description, a cadence hint derived from the template's REAL cron, and a
 * "Set up" action that opens the builder PRE-FILLED. Selecting a card never
 * creates or runs a workflow — the user reviews the brief and saves it.
 * A dashed "More coming" placeholder closes the grid.
 */

import { Archive, CalendarClock, FileCheck2, Globe, Hand, Plus, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useTranslations, type Translator } from '@/i18n'
import { cn } from '@/lib/utils'
import { presetForCron } from '../lib/schedule'
import {
  resolveAllTemplates,
  type ResolvedTemplate,
  type TemplateProvenance,
} from '../lib/templates'

interface TemplateCardsProps {
  onUse: (template: ResolvedTemplate) => void
}

/** Provenance tint + text classes for the icon tile (tokens only, both modes). */
const PROVENANCE_TILE: Record<TemplateProvenance, string> = {
  law: 'bg-source-law-tint text-source-law-text',
  project: 'bg-source-project-tint text-source-project-text',
  office: 'bg-source-office-tint text-source-office-text',
  auto: 'bg-source-auto-tint text-source-auto-text',
}

/** The signal icon per provenance — law is the "§" glyph per the design spec. */
function ProvenanceGlyph({ provenance }: { provenance: TemplateProvenance }): JSX.Element {
  if (provenance === 'law') {
    return <span className="text-lg font-semibold leading-none">§</span>
  }
  const Icon = provenance === 'project' ? FileCheck2 : provenance === 'office' ? Archive : Globe
  return <Icon className="size-4" />
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
  const templates = resolveAllTemplates(t)

  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3" data-testid="workflow-templates">
      {templates.map((template) => {
        const scheduled = Boolean(template.scheduleCron)
        return (
          <Card key={template.id} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <span
                  className={cn(
                    'flex size-9 shrink-0 items-center justify-center rounded-lg',
                    PROVENANCE_TILE[template.provenance],
                  )}
                  aria-hidden
                >
                  <ProvenanceGlyph provenance={template.provenance} />
                </span>
                <Badge variant="info" className="shrink-0">
                  <Sparkles className="size-3" aria-hidden />
                  {t('templates.badge')}
                </Badge>
              </div>
              <h3 className="text-sm font-semibold text-foreground">{template.name}</h3>
              <p className="flex-1 text-sm text-muted-foreground">{template.description}</p>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {scheduled ? (
                  <CalendarClock className="size-3.5" aria-hidden />
                ) : (
                  <Hand className="size-3.5" aria-hidden />
                )}
                <span>{cadenceLabel(t, template.scheduleCron)}</span>
              </div>
              <Button
                size="sm"
                className="w-fit"
                aria-label={t('templates.setUpAria', { name: template.name })}
                onClick={() => onUse(template)}
              >
                {t('templates.setUp')}
              </Button>
            </CardContent>
          </Card>
        )
      })}

      {/* "More coming" placeholder — deliberately not interactive. */}
      <div
        className="flex min-h-44 flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border p-6 text-center"
        data-testid="workflow-templates-placeholder"
      >
        <span
          className="flex size-9 items-center justify-center rounded-lg bg-muted text-muted-foreground"
          aria-hidden
        >
          <Plus className="size-4" />
        </span>
        <p className="text-sm font-medium text-foreground">{t('templates.moreComing.title')}</p>
        <p className="text-xs text-muted-foreground">{t('templates.moreComing.hint')}</p>
      </div>
    </div>
  )
}
