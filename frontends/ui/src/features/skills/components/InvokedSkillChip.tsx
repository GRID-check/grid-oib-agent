'use client'

/**
 * The chip under the composer that says a skill is attached to this message.
 *
 * The `/name` token in the textarea is the invocation, but a token in a sentence
 * is easy to lose track of once the message grows past a line — and unlike an
 * `@` mention, whose consequence (a person is asked) is obvious from the word
 * itself, "this skill's instructions will be loaded" is a mechanism the reader
 * cannot see. So the chip states the consequence rather than restating the name,
 * and it carries the description, which is the only thing that tells the user
 * whether the skill they picked is the one they meant.
 *
 * Removing it edits the token out of the text rather than tracking a separate
 * "cancelled" flag: the text is the record of the invocation, so the chip and
 * the message can never disagree about whether a skill is attached.
 */

import { Sparkles, X } from 'lucide-react'
import { useTranslations } from '@/i18n'

export interface InvokedSkillChipProps {
  name: string
  description: string
  /** Omitted where the composer is read-only — nothing there is removable. */
  onRemove?: () => void
}

export function InvokedSkillChip({
  name,
  description,
  onRemove,
}: InvokedSkillChipProps): JSX.Element {
  const t = useTranslations('skills')

  return (
    <div
      data-testid="invoked-skill-chip"
      className="border-primary/20 bg-primary/5 mt-2 flex items-start gap-2.5 rounded-lg border px-2.5 py-2"
    >
      <span
        aria-hidden
        className="bg-primary/10 text-primary mt-px flex size-5 shrink-0 items-center justify-center rounded-md"
      >
        <Sparkles className="size-3" />
      </span>

      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="text-foreground truncate text-xs font-medium">
          {t('composer.invoked.label', { name })}
        </span>
        {/* The description first — it is what confirms the right skill was
            picked — then the mechanism, which is the same for every skill and so
            reads as a footnote rather than as news. */}
        <span className="text-muted-foreground line-clamp-2 text-[11px] leading-snug">
          {description}
        </span>
        <span className="text-muted-foreground/80 text-[11px] leading-snug">
          {t('composer.invoked.hint')}
        </span>
      </span>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('composer.invoked.remove', { name })}
          className="focus-visible:ring-ring/60 text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1 transition-colors duration-200 ease-out focus-visible:outline-none focus-visible:ring-2"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}
