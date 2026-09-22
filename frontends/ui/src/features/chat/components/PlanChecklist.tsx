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
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Chip } from '@/components/ui/chip'
import { useTranslations } from '@/i18n'
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
    return { title: raw.title, sections, genre, depth }
  } catch {
    return null
  }
}

/** The content without the fence, for the bubble's text. */
export const stripPlanFence = (content: string): string => content.replace(PLAN_FENCE_RE, '').trim()

/** The reply for an approval: bare when nothing changed, with the edits otherwise. */
export function approvalReply(original: PlanShape, edited: PlanShape): string {
  const same =
    original.genre === edited.genre &&
    original.depth === edited.depth &&
    original.sections.length === edited.sections.length &&
    original.sections.every((section, index) => section === edited.sections[index])
  if (same) return 'approve'
  return `approve ${JSON.stringify({ sections: edited.sections, genre: edited.genre, depth: edited.depth })}`
}

export const PlanChecklist: FC<{
  plan: PlanShape
  disabled?: boolean
  onChange: (plan: PlanShape) => void
}> = ({ plan, disabled = false, onChange }) => {
  const t = useTranslations('chat')
  const [draft, setDraft] = useState('')

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
