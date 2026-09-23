/**
 * The Rechercheplan as controls: the sections as a checklist the reader can
 * strike and extend, the genre and depth as choices, the Unterlagen through
 * the picker. Fully controlled — every edit is `onChange` with the whole
 * shape — so the caller decides where an edit goes. On the run block it goes
 * to the plan primitive (ADR-0065); in the „Auftrag planen" dialog it stays
 * local until the plan is created.
 */

import { useState, type FC } from 'react'
import { BookOpen, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { UnterlagenDialog } from './UnterlagenDialog'
import { useTranslations } from '@/i18n'
import {
  PLAN_DEPTHS,
  PLAN_GENRES,
  type PlanDepth,
  type PlanGenre,
  type ResearchPlan,
} from '@/lib/plans/plan-types'
import { planDocumentLabel, type PlanDocument } from '@/lib/runs/plan-documents'
import { cn } from '@/lib/utils'

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
    // A named document the inventory no longer lists stays nameable.
    unterlagen: [...plan.unterlagen, ...plan.grundlage, ...plan.ausgeschlossen].filter(
      (doc, index, all) => all.findIndex((other) => other.name === doc.name) === index
    ),
  }
}

export const PlanChecklist: FC<{
  plan: PlanShape
  disabled?: boolean
  /** The sources the run searches, shown read-only. */
  rahmen?: PlanRahmen
  onChange: (plan: PlanShape) => void
}> = ({ plan, disabled = false, rahmen, onChange }) => {
  const t = useTranslations('chat')
  const [draft, setDraft] = useState('')
  const [picking, setPicking] = useState(false)
  const labelOf = (name: string): string => {
    const key = name.trim().toLocaleLowerCase()
    const doc = plan.unterlagen.find((row) => row.name.trim().toLocaleLowerCase() === key)
    return doc ? planDocumentLabel(doc) : name
  }
  const dropName = (list: 'grundlage' | 'ausgeschlossen', name: string): void =>
    onChange({ ...plan, [list]: plan[list].filter((item) => item !== name) })

  const remove = (index: number) =>
    onChange({ ...plan, sections: plan.sections.filter((_, i) => i !== index) })
  const add = () => {
    const text = draft.trim()
    if (!text) return
    onChange({ ...plan, sections: [...plan.sections, text] })
    setDraft('')
  }

  return (
    <div className="flex flex-col gap-3" data-testid="plan-checklist">
      <div className="flex flex-col gap-1.5">
        <span className="text-muted-foreground text-xs font-medium">
          {t('agentPrompt.plan.points')}
        </span>
        <ul className="flex flex-col gap-1" aria-label={t('agentPrompt.plan.points')}>
          {plan.sections.map((section, index) => (
            <li
              key={`${index}-${section}`}
              className="flex items-center gap-2 text-sm"
              data-testid="plan-point"
            >
              <span className="flex-1">{section}</span>
              {!disabled && plan.sections.length > 1 && (
                <button
                  type="button"
                  onClick={() => remove(index)}
                  aria-label={t('agentPrompt.plan.removePoint', { point: section })}
                  className="rounded-xs text-muted-foreground hover:text-foreground focus-visible:ring-ring/60 focus-visible:outline-none focus-visible:ring-2"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
              )}
            </li>
          ))}
        </ul>
        {!disabled && (
          <div className="flex items-center gap-2">
            <input
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
              className="border-border bg-background h-7 flex-1 rounded-md border px-2 text-sm"
            />
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-7 px-2"
              onClick={add}
              aria-label={t('agentPrompt.plan.addPoint')}
            >
              <Plus className="size-3.5" aria-hidden />
            </Button>
          </div>
        )}
      </div>
      <ChoiceRow
        label={t('agentPrompt.plan.genre')}
        options={PLAN_GENRES}
        value={plan.genre}
        disabled={disabled}
        labelFor={(genre) => t(`agentPrompt.plan.genres.${genre}`)}
        onPick={(genre) => onChange({ ...plan, genre })}
      />
      <ChoiceRow
        label={t('agentPrompt.plan.depth')}
        options={PLAN_DEPTHS}
        value={plan.depth}
        disabled={disabled}
        labelFor={(depth) => t(`agentPrompt.plan.depths.${depth}`)}
        onPick={(depth) => onChange({ ...plan, depth })}
      />
      {/* The Unterlagen: what the run must read, and what it may not use. A
          picker over the thread names them; the chips here are the receipt of
          that choice, each one strikable. Shown whenever the turn has something
          to name, so the section is where the reader learns it can be done. */}
      {(plan.unterlagen.length > 0 || plan.grundlage.length > 0 || plan.ausgeschlossen.length > 0) && (
        <div className="flex flex-col gap-1.5" data-testid="plan-unterlagen">
          <span className="text-muted-foreground text-xs font-medium">
            {t('agentPrompt.plan.unterlagen.label')}
          </span>
          <NamedRow
            label={t('agentPrompt.plan.unterlagen.grundlage')}
            names={plan.grundlage}
            labelOf={labelOf}
            disabled={disabled}
            variant="default"
            removeLabel={(name) => t('agentPrompt.plan.unterlagen.removeRead', { name })}
            onRemove={(name) => dropName('grundlage', name)}
            testId="plan-grundlage"
          />
          <NamedRow
            label={t('agentPrompt.plan.unterlagen.ausgeschlossen')}
            names={plan.ausgeschlossen}
            labelOf={labelOf}
            disabled={disabled}
            variant="destructive"
            removeLabel={(name) => t('agentPrompt.plan.unterlagen.removeExcluded', { name })}
            onRemove={(name) => dropName('ausgeschlossen', name)}
            testId="plan-ausgeschlossen"
          />
          {plan.grundlage.length === 0 && plan.ausgeschlossen.length === 0 && (
            <span className="text-muted-foreground text-xs">
              {t('agentPrompt.plan.unterlagen.none')}
            </span>
          )}
          {!disabled && plan.unterlagen.length > 0 && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 gap-1 px-2 text-xs"
                onClick={() => setPicking(true)}
                data-testid="plan-unterlagen-pick"
              >
                <BookOpen className="size-3.5" aria-hidden />
                {t('agentPrompt.plan.unterlagen.choose')}
              </Button>
              <UnterlagenDialog
                mode="pick"
                open={picking}
                onOpenChange={setPicking}
                documents={plan.unterlagen}
                grundlage={plan.grundlage}
                ausgeschlossen={plan.ausgeschlossen}
                onChange={(next) => onChange({ ...plan, ...next })}
              />
            </div>
          )}
        </div>
      )}
      {/* The Rahmen: read-only, because the run's tools were chosen by it when
          the run was commissioned. */}
      {rahmen && rahmen.labels.length > 0 && (
        <div className="flex flex-col gap-1.5" data-testid="plan-rahmen">
          <span className="text-muted-foreground text-xs font-medium">
            {t('agentPrompt.plan.rahmen')}
          </span>
          <div className="flex flex-wrap gap-1.5">
            {rahmen.labels.map((label) => (
              <Chip key={label} size="sm" variant="secondary">
                {label}
              </Chip>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

const NamedRow: FC<{
  label: string
  names: readonly string[]
  labelOf: (name: string) => string
  disabled: boolean
  variant: 'default' | 'destructive'
  removeLabel: (name: string) => string
  onRemove: (name: string) => void
  testId: string
}> = ({ label, names, labelOf, disabled, variant, removeLabel, onRemove, testId }) => {
  if (names.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <span className="text-muted-foreground text-[11px]">{label}</span>
      {names.map((name) => (
        <Chip key={name} size="sm" variant={variant} title={name}>
          {labelOf(name)}
          {!disabled && (
            <button
              type="button"
              onClick={() => onRemove(name)}
              aria-label={removeLabel(labelOf(name))}
              className="rounded-xs ml-0.5 opacity-70 hover:opacity-100 focus-visible:outline-none"
            >
              <X className="size-3" aria-hidden />
            </button>
          )}
        </Chip>
      ))}
    </div>
  )
}

function ChoiceRow<T extends string>({
  label,
  options,
  value,
  disabled,
  labelFor,
  onPick,
}: {
  label: string
  options: readonly T[]
  value: T
  disabled: boolean
  labelFor: (option: T) => string
  onPick: (option: T) => void
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-muted-foreground text-xs font-medium">{label}</span>
      <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={label}>
        {options.map((option) => {
          const selected = option === value
          return (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={selected}
              disabled={disabled}
              onClick={() => onPick(option)}
              className={cn(
                'focus-visible:ring-ring/60 rounded-md focus-visible:outline-none focus-visible:ring-2',
                disabled && 'cursor-default'
              )}
            >
              <Chip size="md" variant={selected ? 'default' : 'outline'}>
                {labelFor(option)}
              </Chip>
            </button>
          )
        })}
      </div>
    </div>
  )
}
