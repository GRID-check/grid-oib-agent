/**
 * The Rechercheplan as controls: the sections as a checklist the reader can
 * strike and extend, the genre and depth as choices, the Unterlagen through
 * the picker. Fully controlled — every edit is `onChange` with the whole
 * shape — so the caller decides where an edit goes. On the run block it goes
 * to the plan primitive (ADR-0065); in the „Auftrag planen" dialog it stays
 * local until the plan is created.
 */

import { useState, type FC } from 'react'
import { BookOpen, Database, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { Input } from '@/components/ui/input'
import { UnterlagenDialog } from './UnterlagenDialog'
import {
  DEPTH_ICON,
  GENRE_ICON,
  OptionTile,
  OptionTiles,
  OutlineAddDisc,
  OutlineRail,
  PlanDocChip,
  PlanGroup,
  RowRemove,
  Segmented,
} from './plan-atoms'
import { useTranslations } from '@/i18n'
import {
  PLAN_DEPTHS,
  PLAN_GENRES,
  type PlanDepth,
  type PlanGenre,
  type ResearchPlan,
} from '@/lib/plans/plan-types'
import { planDocumentLabel, type PlanDocument } from '@/lib/runs/plan-documents'

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
  const docOf = (name: string): PlanDocument => {
    const key = name.trim().toLocaleLowerCase()
    return plan.unterlagen.find((row) => row.name.trim().toLocaleLowerCase() === key) ?? { name }
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
  const hasDocuments = plan.unterlagen.length > 0 || plan.grundlage.length > 0 || plan.ausgeschlossen.length > 0

  return (
    <div className="flex flex-col gap-5" data-testid="plan-checklist">
      <PlanGroup label={t('agentPrompt.plan.points')}>
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
            disabled ? undefined : (
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
      </PlanGroup>

      <PlanGroup label={t('agentPrompt.plan.genre')}>
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
      </PlanGroup>

      <PlanGroup label={t('agentPrompt.plan.depth')}>
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
      </PlanGroup>

      {/* The Unterlagen: what the run must read, and what it may not use. A
          picker over the thread names them; the chips here are the receipt of
          that choice, each one strikable. Shown whenever the plan has something
          to name, so the section is where the reader learns it can be done. */}
      {hasDocuments && (
        <PlanGroup label={t('agentPrompt.plan.unterlagen.label')} testId="plan-unterlagen">
          <DocRow
            label={t('agentPrompt.plan.unterlagen.grundlage')}
            names={plan.grundlage}
            docOf={docOf}
            disabled={disabled}
            removeLabel={(label) => t('agentPrompt.plan.unterlagen.removeRead', { name: label })}
            onRemove={(name) => dropName('grundlage', name)}
            testId="plan-grundlage"
          />
          <DocRow
            label={t('agentPrompt.plan.unterlagen.ausgeschlossen')}
            names={plan.ausgeschlossen}
            docOf={docOf}
            excluded
            disabled={disabled}
            removeLabel={(label) => t('agentPrompt.plan.unterlagen.removeExcluded', { name: label })}
            onRemove={(name) => dropName('ausgeschlossen', name)}
            testId="plan-ausgeschlossen"
          />
          {plan.grundlage.length === 0 && plan.ausgeschlossen.length === 0 && (
            <span className="text-muted-foreground text-xs">{t('agentPrompt.plan.unterlagen.none')}</span>
          )}
          {!disabled && plan.unterlagen.length > 0 && (
            <div>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 px-2.5 text-xs"
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
        </PlanGroup>
      )}

      {/* The Rahmen: read-only, because the run's tools were chosen by it when
          the run was commissioned. */}
      {rahmen && rahmen.labels.length > 0 && (
        <PlanGroup label={t('agentPrompt.plan.rahmen')} testId="plan-rahmen">
          <div className="flex flex-wrap gap-1.5">
            {rahmen.labels.map((label) => (
              <Chip key={label} size="sm" variant="secondary">
                <Database className="size-3" aria-hidden />
                {label}
              </Chip>
            ))}
          </div>
        </PlanGroup>
      )}
    </div>
  )
}

const DocRow: FC<{
  label: string
  names: readonly string[]
  docOf: (name: string) => PlanDocument
  excluded?: boolean
  disabled: boolean
  removeLabel: (label: string) => string
  onRemove: (name: string) => void
  testId: string
}> = ({ label, names, docOf, excluded = false, disabled, removeLabel, onRemove, testId }) => {
  if (names.length === 0) return null
  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid={testId}>
      <span className="text-muted-foreground text-xs">{label}</span>
      {names.map((name) => {
        const doc = docOf(name)
        return (
          <PlanDocChip
            key={name}
            doc={doc}
            excluded={excluded}
            removeLabel={removeLabel(planDocumentLabel(doc))}
            onRemove={disabled ? undefined : () => onRemove(name)}
          />
        )
      })}
    </div>
  )
}
