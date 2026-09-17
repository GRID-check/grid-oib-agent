'use client'

/**
 * The chip under the composer that says a skill is attached to this message.
 *
 * The `/name` token in the textarea is the invocation, but a token in a sentence
 * is easy to lose track of once the message grows past a line. So the chip
 * restates that a skill is attached, and carries the description, which is the
 * only thing that tells the user whether the skill they picked is the one they
 * meant.
 *
 * What it must NOT say is that the instructions will load. It did say that, and
 * it was true when a named skill was forced onto the turn. ADR-0060 deleted
 * forcing: the token is TEXT, Piloti reads the name among the words and decides
 * whether to reach for the skill, exactly as it decides about every other one in
 * its catalog. A chip promising the load is the interface asserting an
 * affordance the product no longer has — and the reader finds out it was wrong
 * only from an answer that did not use the skill they thought they had picked.
 *
 * Removing it edits the token out of the text rather than tracking a separate
 * "cancelled" flag: the text is the record of the invocation, so the chip and
 * the message can never disagree about whether a skill is attached.
 */

import { X } from 'lucide-react'
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
      className="border-primary/20 bg-primary/5 animate-in fade-in-0 mt-2 flex items-start gap-2.5 rounded-lg border px-2.5 py-2 duration-base ease-out motion-reduce:animate-none"
    >
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        {/* The name in the form the user typed it. No icon: there is exactly one
            of these at a time and the line already says what it is, so a glyph
            would decorate rather than distinguish — the same reason the picker
            rows carry none. */}
        <span className="text-foreground truncate text-xs">
          <span className="text-muted-foreground">{t('composer.invoked.label')}</span>{' '}
          <span className="font-mono">/{name}</span>
        </span>
        {/* The description first — it is what confirms the right skill was
            picked — then the mechanism, which is the same for every skill and so
            reads as a footnote rather than as news. */}
        <span className="text-muted-foreground line-clamp-2 text-xs leading-snug">
          {description}
        </span>
        <span className="text-muted-foreground/80 text-xs leading-snug">
          {t('composer.invoked.hint')}
        </span>
      </span>

      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label={t('composer.invoked.remove', { name })}
          // The only way to take a wrongly-invoked skill back off a message,
          // at 22px. It is the last thing in its row with the composer edge
          // beside it, so the box grows into space that was padding anyway.
          className="focus-visible:ring-ring/60 text-muted-foreground hover:text-foreground shrink-0 rounded-md p-1 transition-colors duration-quick ease-out focus-visible:outline-none focus-visible:ring-2 pointer-coarse:inline-flex pointer-coarse:size-11 pointer-coarse:items-center pointer-coarse:justify-center pointer-coarse:p-0"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  )
}
