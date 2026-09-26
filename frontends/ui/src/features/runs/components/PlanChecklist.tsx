/**
 * The Rechercheplan as controls, in three steps: what the report covers, what
 * it looks like, and which Unterlagen it reads (optional — the sources it
 * searches close that step's sentence, fixed when the run was commissioned).
 * Each step says in one line what deciding it does, so a reader who has never
 * seen a plan needs no manual.
 *
 * Fully controlled — every edit is `onChange` with the whole shape — so the
 * caller decides where an edit goes. On the run block it goes to the plan
 * primitive (ADR-0068); in „Recherche planen" it stays local until the plan
 * is created.
 */

import { useMemo, useState, type FC } from 'react'
import { Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ChoiceCard, ChoiceCards } from '@/components/ui/choice-card'
import { Input } from '@/components/ui/input'
import type { PickerDocument } from '@/features/documents/components/document-picker/DocumentPickerDialog'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { useDocumentLibrary } from '@/features/documents/hooks/use-document-library'
import { PlanUnterlagen } from './PlanUnterlagen'
import {
  DEPTH_ICON,
  GENRE_ICON,
  OutlineAddDisc,
  OutlineRail,
  PlanEmptyOutline,
  PlanStep,
  PlanSuggestions,
  RowRemove,
  Segmented,
  SuggestionChip,
} from './plan-atoms'
import { useTranslations } from '@/i18n'
import {
  MAX_PLAN_SECTIONS,
  PLAN_DEPTHS,
  PLAN_GENRES,
  type PlanDepth,
  type PlanGenre,
  type ResearchPlan,
} from '@/lib/plans/plan-types'
import type { PlanDocument } from '@/lib/runs/plan-documents'
import { foldName } from '@/lib/text/fold'

export { PLAN_DEPTHS, PLAN_GENRES, type PlanDepth, type PlanGenre }

/** The plan as the checklist edits it: documents by name, resolved on the BFF. */
export interface PlanShape {
  title: string
  sections: string[]
  genre: PlanGenre
  depth: PlanDepth
  /** File names the run must read in full, from the inventory below. */
  grundlage: string[]
  /** File names the run may not use. */
  ausgeschlossen: string[]
  /** „Nur diese": of the reader's own documents, only the Grundlage. Off, it is the run's focus. */
  nurGrundlage: boolean
  /** What the run can read: the inventory the plan was drafted against. */
  unterlagen: PlanDocument[]
}

/** The sources the run searches, shown read-only: fixed when the run was commissioned. */
export interface PlanRahmen {
  labels: string[]
}

/** A stored plan, as the checklist edits it. */
export function planShapeOf(plan: ResearchPlan): PlanShape {
  return {
    title: plan.title,
    sections: [...plan.sections],
    genre: plan.genre,
    depth: plan.depth,
    grundlage: plan.grundlage.map((doc) => doc.name),
    ausgeschlossen: plan.ausgeschlossen.map((doc) => doc.name),
    nurGrundlage: plan.nurGrundlage,
    // A named document the inventory no longer lists stays nameable.
    unterlagen: [...plan.unterlagen, ...plan.grundlage, ...plan.ausgeschlossen].filter(
      (doc, index, all) => all.findIndex((other) => other.name === doc.name) === index
    ),
  }
}

/** How many section templates each genre offers. */
const TEMPLATE_COUNT = 5
/** Suggestions shown beside a plan that already has sections. */
const SUGGESTION_LIMIT = 4

/** Two inventories as one, the first one's rows winning a name both hold. */
export function mergeDocuments<T extends PlanDocument>(first: readonly T[], second: readonly T[]): T[] {
  const seen = new Set<string>()
  return [...first, ...second].filter((doc) => {
    const key = foldName(doc.name)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const PlanChecklist: FC<{
  plan: PlanShape
  disabled?: boolean
  /** The sources the run searches, shown read-only. */
  rahmen?: PlanRahmen
  /** The project whose listing the document picker offers, loaded when it first opens. */
  projectId?: string | null
  /** A listing the caller already holds; the checklist then loads none of its own. */
  inventory?: { documents: readonly PickerDocument[]; folders?: readonly FolderItem[]; loading: boolean }
  onChange: (plan: PlanShape) => void
}> = ({ plan, disabled = false, rahmen, projectId = null, inventory, onChange }) => {
  const t = useTranslations('chat')
  const [draft, setDraft] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const library = useDocumentLibrary(inventory ? null : projectId, browsing)
  // The picker offers the listing; a document only the plan's own inventory
  // names still shows under its title in the chips.
  const listing = useMemo(
    () => inventory?.documents ?? library.documents ?? [],
    [inventory?.documents, library.documents]
  )

  const remove = (index: number) =>
    onChange({ ...plan, sections: plan.sections.filter((_, i) => i !== index) })
  const addSection = (text: string) => {
    const section = text.trim()
    if (!section || plan.sections.length >= MAX_PLAN_SECTIONS) return
    onChange({ ...plan, sections: [...plan.sections, section] })
  }
  const add = () => {
    addSection(draft)
    setDraft('')
  }

  const templates = Array.from({ length: TEMPLATE_COUNT }, (_, index) =>
    t(`agentPrompt.plan.sectionTemplates.${plan.genre}.s${index + 1}`)
  )
  // A suggestion whose first word an existing section already opens with is a
  // near-duplicate („Rechtsrahmen und Einstufung" beside „Rechtsrahmen und
  // Gebäudeklasse"), and offering it reads as the plan not having been read.
  const openingWord = (text: string): string => foldName(text).split(/\s+/)[0] ?? ''
  const taken = new Set(plan.sections.map(foldName))
  const openings = new Set(plan.sections.map(openingWord))
  const suggestions = templates
    .filter((template) => !taken.has(foldName(template)) && !openings.has(openingWord(template)))
    .slice(0, SUGGESTION_LIMIT)
  const full = plan.sections.length >= MAX_PLAN_SECTIONS
  const genreLabel = t(`agentPrompt.plan.genres.${plan.genre}`)

  return (
    <div className="flex flex-col gap-6" data-testid="plan-checklist">
      <PlanStep
        title={t('agentPrompt.plan.steps.sections.title')}
        hint={t('agentPrompt.plan.steps.sections.hint')}
        aside={
          <span className="text-muted-foreground text-xs tabular-nums">
            {plan.sections.length}/{MAX_PLAN_SECTIONS}
          </span>
        }
        testId="plan-step-sections"
      >
        <div className="flex flex-col gap-2.5">
          <PlanEmptyOutline
            show={plan.sections.length === 0 && !disabled}
            title={t('agentPrompt.plan.emptySectionsTitle')}
            hint={t('agentPrompt.plan.emptySections')}
          >
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="gap-1.5"
              onClick={() => onChange({ ...plan, sections: templates })}
              data-testid="plan-use-template"
            >
              <Sparkles className="size-3.5" aria-hidden />
              {t('agentPrompt.plan.useTemplate', { genre: genreLabel })}
            </Button>
          </PlanEmptyOutline>
          <OutlineRail
            label={t('agentPrompt.plan.points')}
            items={plan.sections}
            itemTestId="plan-point"
            action={
              !disabled && plan.sections.length > 1
                ? (index, section) => (
                    <RowRemove
                      label={t('agentPrompt.plan.removePoint', { point: section })}
                      onClick={() => remove(index)}
                    />
                  )
                : undefined
            }
            footer={
              disabled || full ? undefined : (
                <>
                  <OutlineAddDisc />
                  <Input
                    value={draft}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        add()
                      }
                    }}
                    placeholder={t('agentPrompt.plan.addPlaceholder')}
                    aria-label={t('agentPrompt.plan.addPoint')}
                    className="h-8 flex-1 text-sm"
                  />
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="h-8 px-2"
                    onClick={add}
                    disabled={!draft.trim()}
                    aria-label={t('agentPrompt.plan.addPoint')}
                  >
                    <Plus className="size-3.5" aria-hidden />
                  </Button>
                </>
              )
            }
          />
          <PlanSuggestions
            label={t('agentPrompt.plan.suggestions', { genre: genreLabel })}
            show={!disabled && !full && plan.sections.length > 0 && suggestions.length > 0}
          >
            {suggestions.map((suggestion) => (
              <SuggestionChip
                key={suggestion}
                label={suggestion}
                ariaLabel={t('agentPrompt.plan.suggest', { point: suggestion })}
                onClick={() => addSection(suggestion)}
              />
            ))}
          </PlanSuggestions>
        </div>
      </PlanStep>

      <PlanStep
        title={t('agentPrompt.plan.steps.form.title')}
        hint={t('agentPrompt.plan.steps.form.hint')}
        testId="plan-step-form"
      >
        <div className="flex flex-col gap-3">
          <ChoiceCards
            value={plan.genre}
            onValueChange={(genre) => onChange({ ...plan, genre: genre as PlanGenre })}
            disabled={disabled}
            aria-label={t('agentPrompt.plan.genre')}
          >
            {PLAN_GENRES.map((genre) => (
              <ChoiceCard
                key={genre}
                value={genre}
                icon={GENRE_ICON[genre]}
                label={t(`agentPrompt.plan.genres.${genre}`)}
                hint={t(`agentPrompt.plan.genreHints.${genre}`)}
              />
            ))}
          </ChoiceCards>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <Segmented
              label={t('agentPrompt.plan.depth')}
              options={PLAN_DEPTHS.map((depth) => ({
                value: depth,
                label: t(`agentPrompt.plan.depths.${depth}`),
                icon: DEPTH_ICON[depth],
              }))}
              value={plan.depth}
              disabled={disabled}
              onPick={(depth) => onChange({ ...plan, depth })}
            />
            <span className="text-muted-foreground text-xs">{t(`agentPrompt.plan.depthHints.${plan.depth}`)}</span>
          </div>
        </div>
      </PlanStep>

      <PlanStep
        title={t('agentPrompt.plan.steps.documents.title')}
        tag={t('agentPrompt.plan.optional')}
        testId="plan-step-documents"
      >
        <PlanUnterlagen
          library={listing}
          known={plan.unterlagen}
          folders={inventory?.folders ?? library.folders}
          loading={inventory?.loading ?? library.loading}
          grundlage={plan.grundlage}
          ausgeschlossen={plan.ausgeschlossen}
          nurGrundlage={plan.nurGrundlage}
          sources={rahmen?.labels}
          disabled={disabled}
          onBrowse={() => setBrowsing(true)}
          onChange={({ picked, ...choice }) =>
            onChange({ ...plan, ...choice, unterlagen: mergeDocuments(plan.unterlagen, picked) })
          }
        />
      </PlanStep>
    </div>
  )
}
