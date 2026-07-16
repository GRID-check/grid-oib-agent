'use client'

/**
 * GRID-authored default template cards. Shown prominently in the empty state
 * (no workflows yet) and reachable via the "From template" affordance once
 * workflows exist. Selecting a card opens the builder PRE-FILLED — it never
 * creates a workflow directly (the user reviews and saves).
 */

import { CalendarClock, Hand, Sparkles } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { useTranslations } from '@/i18n'
import { resolveAllTemplates, type ResolvedTemplate } from '../lib/templates'

interface TemplateCardsProps {
  onUse: (template: ResolvedTemplate) => void
}

export function TemplateCards({ onUse }: TemplateCardsProps): JSX.Element {
  const t = useTranslations('workflows')
  const templates = resolveAllTemplates(t)

  return (
    <div className="grid gap-4 sm:grid-cols-2" data-testid="workflow-templates">
      {templates.map((template) => {
        const scheduled = Boolean(template.scheduleCron)
        return (
          <Card key={template.id} className="flex flex-col">
            <CardContent className="flex flex-1 flex-col gap-3 p-4 sm:p-5">
              <div className="flex items-start justify-between gap-2">
                <h3 className="text-sm font-semibold text-foreground">{template.name}</h3>
                <Badge variant="info" className="shrink-0">
                  <Sparkles className="size-3" aria-hidden />
                  {t('templates.badge')}
                </Badge>
              </div>
              <p className="flex-1 text-sm text-muted-foreground">{template.description}</p>
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                {scheduled ? (
                  <CalendarClock className="size-3.5" aria-hidden />
                ) : (
                  <Hand className="size-3.5" aria-hidden />
                )}
                <span>{scheduled ? t('templates.scheduleWeekly') : t('templates.scheduleManual')}</span>
              </div>
              <Button size="sm" className="w-fit" onClick={() => onUse(template)}>
                {t('templates.useTemplate')}
              </Button>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
