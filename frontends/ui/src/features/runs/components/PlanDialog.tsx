'use client'

/**
 * „Recherche planen": a research plan written by a person, from nothing
 * (ADR-0065). The same steps the run block shows for an agent's plan, over
 * the same inventory, beside a preview of the brief as the block will show
 * it, and one button that creates the plan and the run that waits on it. A
 * plan a person wrote is approved as it is written, so the run starts at
 * once; its block appears in the thread like any other.
 *
 * The footer says what is still missing rather than leaving a grey button to
 * be puzzled over: a question, and one section.
 */

import { useState, type FC } from 'react'
import { ListOrdered, Play } from 'lucide-react'
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
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { foldName } from '@/lib/text/fold'
import { cn } from '@/lib/utils'
import { useDocumentLibrary } from '@/features/documents/hooks/use-document-library'
import { PlanBrief } from './PlanBrief'
import { PlanChecklist, type PlanShape } from './PlanChecklist'
import {
  DEPTH_ICON,
  GENRE_ICON,
  GenreWell,
  PlanFacts,
  PlanNote,
  PlanPreviewFrame,
  PlanRequirement,
  PlanStep,
} from './plan-atoms'

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
  nurGrundlage: false,
  unterlagen: [],
}

export const PlanDialog: FC<PlanDialogProps> = ({ open, onOpenChange, projectId, conversationId }) => {
  const t = useTranslations('runs')
  const tc = useTranslations('chat')
  const [question, setQuestion] = useState('')
  const [shape, setShape] = useState<PlanShape>(EMPTY)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const library = useDocumentLibrary(projectId, open)
  const hydrate = useChatStore((state) => state.hydrateConversationMessages)
  const enabledSources = useLayoutStore((state) => state.enabledDataSourceIds)
  const availableSources = useLayoutStore((state) => state.availableDataSources)
  // The sources the plan will search are the ones the composer has on: named
  // in the document step's sentence, fixed once the plan is created.
  const rahmen =
    enabledSources.length > 0
      ? {
          labels: enabledSources.map(
            (id) => (availableSources ?? []).find((source) => source.id === id)?.name ?? id
          ),
        }
      : undefined
  const unterlagen: PlanDocument[] = (library.documents ?? []).map(({ name, title, shelf }) => ({
    name,
    ...(title ? { title } : {}),
    ...(shelf ? { shelf } : {}),
  }))
  const hasQuestion = question.trim().length > 0
  const hasSections = shape.sections.length > 0
  const ready = hasQuestion && hasSections && !pending

  const named = (names: readonly string[]): PlanDocument[] =>
    names.flatMap((name) => unterlagen.filter((doc) => foldName(doc.name) === foldName(name)).slice(0, 1))

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
        nurGrundlage: shape.nurGrundlage && shape.grundlage.length > 0,
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
      <DialogContent className="sm:max-w-4xl" data-testid="plan-dialog">
        <DialogHeader>
          <DialogTitle>{t('plan.dialogTitle')}</DialogTitle>
          <DialogDescription>{t('plan.dialogDescription')}</DialogDescription>
        </DialogHeader>

        <div className="grid gap-6 md:grid-cols-[minmax(0,1fr)_17rem]">
          <div className="flex min-w-0 flex-col gap-6">
            <PlanStep title={t('plan.question')} hint={t('plan.questionHint')} testId="plan-step-question">
              <Textarea
                value={question}
                maxLength={MAX_PLAN_QUESTION_CHARS}
                onChange={(event) => setQuestion(event.target.value)}
                placeholder={t('plan.questionPlaceholder')}
                aria-label={t('plan.question')}
                rows={2}
                data-testid="plan-dialog-question"
              />
            </PlanStep>
            <PlanChecklist
              plan={{ ...shape, unterlagen }}
              disabled={pending}
              inventory={{ documents: library.documents ?? [], folders: library.folders, loading: library.loading }}
              rahmen={rahmen}
              onChange={setShape}
            />
          </div>

          {/* The brief as the block will show it, beside the controls that make it. */}
          <PlanPreviewFrame label={t('plan.preview')}>
            <div className="flex items-start gap-2.5">
              <GenreWell genre={shape.genre} />
              <div className="flex min-w-0 flex-col gap-0.5">
                <span
                  className={cn(
                    'line-clamp-3 text-sm font-semibold leading-snug',
                    hasQuestion ? 'text-foreground' : 'text-muted-foreground italic font-normal'
                  )}
                >
                  {hasQuestion ? question.trim() : t('plan.previewQuestion')}
                </span>
                <PlanFacts
                  facts={[
                    { icon: GENRE_ICON[shape.genre], label: tc(`agentPrompt.plan.genres.${shape.genre}`) },
                    { icon: DEPTH_ICON[shape.depth], label: tc(`agentPrompt.plan.depths.${shape.depth}`) },
                    { icon: ListOrdered, label: t('plan.sections', { count: shape.sections.length }) },
                  ]}
                />
              </div>
            </div>
            <PlanBrief
              sections={shape.sections}
              grundlage={named(shape.grundlage)}
              ausgeschlossen={named(shape.ausgeschlossen)}
              nurGrundlage={shape.nurGrundlage}
              emptyLabel={t('plan.previewSections')}
            />
            <PlanNote ruled>{t('plan.previewNext')}</PlanNote>
          </PlanPreviewFrame>
        </div>

        {failed && (
          <p className="text-destructive text-sm" role="alert">
            {t('plan.createFailed')}
          </p>
        )}
        <DialogFooter className="items-center gap-3 sm:justify-between">
          <ul className="text-muted-foreground flex flex-wrap gap-x-3 gap-y-1 text-xs" data-testid="plan-dialog-missing">
            <PlanRequirement met={hasQuestion} label={t('plan.needQuestion')} />
            <PlanRequirement met={hasSections} label={t('plan.needSection')} />
          </ul>
          <span className="flex gap-2">
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              {t('plan.cancel')}
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={!ready}
              onClick={() => void submit()}
              data-testid="plan-dialog-submit"
            >
              <Play className="size-3.5" aria-hidden />
              {t('plan.create')}
            </Button>
          </span>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
