/**
 * The Rechercheplan as controls, walked as numbered steps: what the report
 * covers, what it looks like, which Unterlagen it reads (optional), and where
 * it searches (fixed, shown for the record). Each step says in one line what
 * deciding it does, so a reader who has never seen a plan needs no manual.
 *
 * Fully controlled — every edit is `onChange` with the whole shape — so the
 * caller decides where an edit goes. On the run block it goes to the plan
 * primitive (ADR-0065); in „Recherche planen" it stays local until the plan
 * is created.
 */

import { useMemo, useState, type FC } from 'react'
import { Database, Lock, Plus, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import type { PickerDocument } from '@/features/documents/components/document-picker/DocumentPickerDialog'
import type { FolderItem } from '@/features/documents/components/project-file-workspace'
import { useDocumentLibrary } from '@/features/documents/hooks/use-document-library'
import { PlanUnterlagen } from './PlanUnterlagen'
import {
  DEPTH_ICON,
  GENRE_ICON,
  OptionTile,
  OptionTiles,
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

const fold = (name: string): string => name.trim().toLocaleLowerCase()

/** Two inventories as one, the first one's rows winning a name both hold. */
export function mergeDocuments<T extends PlanDocument>(first: readonly T[], second: readonly T[]): T[] {
  const seen = new Set<string>()
  return [...first, ...second].filter((doc) => {
    const key = fold(doc.name)
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
  /** The numeral of the first step, when the caller puts one of its own above. */
  firstStep?: number
  onChange: (plan: PlanShape) => void
}> = ({ plan, disabled = false, rahmen, projectId = null, inventory, firstStep = 1, onChange }) => {
  const t = useTranslations('chat')
  const [draft, setDraft] = useState('')
  const [browsing, setBrowsing] = useState(false)
  const library = useDocumentLibrary(inventory ? null : projectId, browsing)
  // The listing's rows first: they carry the file a picker's columns and
  // preview read. A document only the plan's inventory names stays nameable.
  const documents = useMemo(
    () => mergeDocuments<PickerDocument>(inventory?.documents ?? library.documents ?? [], plan.unterlagen),
    [plan.unterlagen, inventory?.documents, library.documents]
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
  const taken = new Set(plan.sections.map(fold))
  const suggestions = templates.filter((template) => !taken.has(fold(template))).slice(0, SUGGESTION_LIMIT)
  const full = plan.sections.length >= MAX_PLAN_SECTIONS
  const genreLabel = t(`agentPrompt.plan.genres.${plan.genre}`)

  let step = firstStep

  return (
    <div className="flex flex-col gap-6" data-testid="plan-checklist">
      <PlanStep
        n={step++}
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
          <PlanEmptyOutline show={plan.sections.length === 0 && !disabled} hint={t('agentPrompt.plan.emptySections')}>
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="h-8 gap-1.5 px-2.5 text-xs"
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
        n={step++}
        title={t('agentPrompt.plan.steps.form.title')}
        hint={t('agentPrompt.plan.steps.form.hint')}
        testId="plan-step-form"
      >
        <div className="flex flex-col gap-3">
          <OptionTiles label={t('agentPrompt.plan.genre')}>
            {PLAN_GENRES.map((genre) => (
              <OptionTile
                key={genre}
                icon={GENRE_ICON[genre]}
                label={t(`agentPrompt.plan.genres.${genre}`)}
                hint={t(`agentPrompt.plan.genreHints.${genre}`)}
                selected={plan.genre === genre}
                disabled={disabled}
                onSelect={() => onChange({ ...plan, genre })}
              />
            ))}
          </OptionTiles>
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
        n={step++}
        title={t('agentPrompt.plan.steps.documents.title')}
        hint={t('agentPrompt.plan.steps.documents.hint')}
        tag={t('agentPrompt.plan.optional')}
        testId="plan-step-documents"
      >
        <PlanUnterlagen
          documents={documents}
          folders={inventory?.folders ?? library.folders}
          loading={inventory?.loading ?? library.loading}
          grundlage={plan.grundlage}
          ausgeschlossen={plan.ausgeschlossen}
          nurGrundlage={plan.nurGrundlage}
          disabled={disabled}
          onBrowse={() => setBrowsing(true)}
          onChange={({ picked, ...choice }) =>
            onChange({ ...plan, ...choice, unterlagen: mergeDocuments(plan.unterlagen, picked) })
          }
        />
      </PlanStep>

      {/* The Rahmen: read-only, because the run's tools were chosen by it when
          the run was commissioned. */}
      {rahmen && rahmen.labels.length > 0 && (
        <PlanStep
          n={step++}
          title={t('agentPrompt.plan.steps.rahmen.title')}
          hint={t('agentPrompt.plan.steps.rahmen.hint')}
          aside={<Lock className="text-muted-foreground size-3.5" aria-hidden />}
          testId="plan-rahmen"
        >
          <div className="flex flex-wrap gap-1.5">
            {rahmen.labels.map((label) => (
              <Chip key={label} size="sm" variant="secondary">
                <Database className="size-3" aria-hidden />
                {label}
              </Chip>
            ))}
          </div>
        </PlanStep>
      )}
    </div>
  )
}
