'use client'

/**
 * „Auftrag planen": a research plan written by a person, from nothing
 * (ADR-0065). The same controls the run block shows for an agent's plan, over
 * the same inventory, and one button that creates the plan and the run that
 * waits on it. A plan a person wrote is approved as it is written, so the run
 * starts at once; its block appears in the thread like any other.
 */

import { useState, type FC } from 'react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Textarea } from '@/components/ui/textarea'
import { useChatStore } from '@/features/chat/store'
import { useLayoutStore } from '@/features/layout/store'
import { useTranslations } from '@/i18n'
import { createPlan } from '@/lib/plans/plan-client'
import { MAX_PLAN_QUESTION_CHARS } from '@/lib/plans/plan-types'
import { useProjectInventory } from '../hooks/use-project-inventory'
import { PlanChecklist, type PlanShape } from './PlanChecklist'

export interface PlanDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  projectId: string
  conversationId: string
}

const EMPTY: PlanShape = {
  title: '',
  sections: [],
  genre: 'bericht',
  depth: 'gutachten',
  grundlage: [],
  ausgeschlossen: [],
  unterlagen: [],
}

export const PlanDialog: FC<PlanDialogProps> = ({ open, onOpenChange, projectId, conversationId }) => {
  const t = useTranslations('runs')
  const [question, setQuestion] = useState('')
  const [shape, setShape] = useState<PlanShape>(EMPTY)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const inventory = useProjectInventory(projectId, open)
  const hydrate = useChatStore((state) => state.hydrateConversationMessages)
  const enabledSources = useLayoutStore((state) => state.enabledDataSourceIds)
  const unterlagen = (inventory.documents ?? []).map(({ name, title, shelf }) => ({
    name,
    ...(title ? { title } : {}),
    ...(shelf ? { shelf } : {}),
  }))
  const ready = question.trim().length > 0 && shape.sections.length > 0 && !pending

  const submit = async (): Promise<void> => {
    setPending(true)
    setFailed(false)
    try {
      await createPlan(projectId, {
        conversationId,
        question: question.trim(),
        sections: shape.sections,
        genre: shape.genre,
        depth: shape.depth,
        grundlage: shape.grundlage,
        ausgeschlossen: shape.ausgeschlossen,
        dataSources: enabledSources.length > 0 ? [...enabledSources] : null,
        unterlagen,
      })
      await hydrate(conversationId)
      setQuestion('')
      setShape(EMPTY)
      onOpenChange(false)
    } catch {
      setFailed(true)
    } finally {
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl" data-testid="plan-dialog">
        <DialogHeader>
          <DialogTitle>{t('plan.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('plan.dialogDescription')}</DialogDescription>
        </DialogHeader>
        <label className="flex flex-col gap-1.5">
          <span className="text-foreground text-sm font-medium">{t('plan.question')}</span>
          <Textarea
            value={question}
            maxLength={MAX_PLAN_QUESTION_CHARS}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t('plan.questionPlaceholder')}
            rows={2}
            data-testid="plan-dialog-question"
          />
        </label>
        <PlanChecklist plan={{ ...shape, unterlagen }} disabled={pending} onChange={setShape} />
        {failed && (
          <p className="text-destructive text-sm" role="alert">
            {t('plan.createFailed')}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('plan.cancel')}
          </Button>
          <Button size="sm" disabled={!ready} onClick={() => void submit()} data-testid="plan-dialog-submit">
            {t('plan.create')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
