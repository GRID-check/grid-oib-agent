/**
 * The Rechercheplan card: the plan as controls, not as a list to say yes to.
 *
 * The backend's plan preview carries the plan as data beside its text
 * (`clarify.format_plan_for_user`, the `plan_json` fence). This renders the
 * sections as a checklist the reader can strike and extend, and the genre
 * and depth as choices, and hands the edited plan back to the approval
 * button: an approval without edits sends the bare keyword the backend has
 * always understood; an approval with edits sends the keyword and the edits
 * as JSON (`clarify.parse_plan_reply`).
 */

import { useState, type FC } from 'react'
import { BookOpen, Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { UnterlagenDialog } from '@/features/runs/components/UnterlagenDialog'
import { useTranslations } from '@/i18n'
import { planDocumentLabel, sanitizePlanDocuments, type PlanDocument } from '@/lib/runs/plan-documents'
import { cn } from '@/lib/utils'

export const PLAN_GENRES = [
  'pruefbericht',
  'aktenvermerk',
  'vergleich',
  'checkliste',
  'bericht',
] as const
export type PlanGenre = (typeof PLAN_GENRES)[number]
export const PLAN_DEPTHS = ['kurzpruefung', 'gutachten'] as const
export type PlanDepth = (typeof PLAN_DEPTHS)[number]

export interface PlanShape {
  title: string
  sections: string[]
  genre: PlanGenre
  depth: PlanDepth
  /** File names the run must read in full, from the inventory below. */
  grundlage: string[]
  /** File names the run may not use. */
  ausgeschlossen: string[]
  /** What the run can read: the turn's inventory, as the backend listed it. */
  unterlagen: PlanDocument[]
}

/** The source ids the composer shows: the Rahmen the run is approved under. */
export interface PlanRahmen {
  ids: string[]
  labels: string[]
}

const PLAN_FENCE_RE = /```plan_json\s*\n([\s\S]*?)\n```/

/** The plan the fence carries, or null when there is none or it is unreadable. */
export function parsePlanFence(content: string): PlanShape | null {
  const match = PLAN_FENCE_RE.exec(content)
  if (!match?.[1]) return null
  try {
    const raw = JSON.parse(match[1]) as Record<string, unknown>
    const sections = Array.isArray(raw.sections)
      ? raw.sections.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
      : []
    if (typeof raw.title !== 'string' || sections.length === 0) return null
    const genre = (PLAN_GENRES as readonly string[]).includes(String(raw.genre))
      ? (raw.genre as PlanGenre)
      : 'bericht'
    const depth = (PLAN_DEPTHS as readonly string[]).includes(String(raw.depth))
      ? (raw.depth as PlanDepth)
      : 'gutachten'
    const names = (value: unknown): string[] =>
      Array.isArray(value)
        ? value.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
        : []
    const unterlagen = sanitizePlanDocuments({ grundlage: raw.unterlagen })?.grundlage ?? []
    return {
      title: raw.title,
      sections,
      genre,
      depth,
      grundlage: names(raw.grundlage),
      ausgeschlossen: names(raw.ausgeschlossen),
      unterlagen,
    }
  } catch {
    return null
  }
}

/** The content without the fence, for the bubble's text. */
export const stripPlanFence = (content: string): string => content.replace(PLAN_FENCE_RE, '').trim()

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((item, index) => item === b[index])

/**
 * The reply for an approval: bare when nothing changed and no Rahmen is
 * known, with the edits otherwise. The Rahmen — the composer's sources at the
 * moment of approval — always travels when there is one, because the run
 * has to know what the composer showed; an empty selection sends nothing and
 * leaves the turn's own sources in force.
 */
export function approvalReply(
  original: PlanShape,
  edited: PlanShape,
  dataSources: readonly string[] = []
): string {
  const same =
    original.genre === edited.genre &&
    original.depth === edited.depth &&
    sameList(original.sections, edited.sections) &&
    sameList(original.grundlage, edited.grundlage) &&
    sameList(original.ausgeschlossen, edited.ausgeschlossen)
  if (same && dataSources.length === 0) return 'approve'
  return `approve ${JSON.stringify({
    sections: edited.sections,
    genre: edited.genre,
    depth: edited.depth,
    grundlage: edited.grundlage,
    ausgeschlossen: edited.ausgeschlossen,
    ...(dataSources.length > 0 ? { data_sources: [...dataSources] } : {}),
  })}`
}

export const PlanChecklist: FC<{
  plan: PlanShape
  disabled?: boolean
  /** The composer's sources, shown as the Rahmen the run is approved under. */
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
      {/* The Rahmen: read-only here, because it IS the composer's Datengrundlage
          — the same chips one row below the thread. Changing it there changes
          what the run gets; this only says so. */}
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
          {!disabled && (
            <span className="text-muted-foreground text-[11px]">
              {t('agentPrompt.plan.rahmenNote')}
            </span>
          )}
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
