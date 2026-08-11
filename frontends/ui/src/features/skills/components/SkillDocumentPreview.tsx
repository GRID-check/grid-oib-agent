'use client'

/**
 * The SKILL.md this form is writing, shown as the document it actually is.
 *
 * A skill authored through four fields and two switches looks like a database
 * record; it is in fact a file with YAML frontmatter and Markdown instructions,
 * and almost everything surprising about how skills behave follows from the
 * seam between those two halves. So the preview does not merely echo the
 * document — it labels the seam:
 *
 *   - the frontmatter is in the agent's context for EVERY turn, which is why the
 *     description has to say when the skill applies and why it is capped;
 *   - the body is loaded only if the agent activates the skill, which is why it
 *     can be long without costing anything.
 *
 * Seeing those two bands next to the fields that produce them is the fastest
 * way to understand why a vague description makes a skill that never triggers,
 * which is the single most common way a hand-written skill fails.
 *
 * Deterministic by construction (`renderSkillDocument` is pure), so this pane is
 * not an approximation of what will be stored — it is what will be stored.
 */

import { type FC } from 'react'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { renderSkillDocumentParts, type SkillDocumentInput } from '../lib/skill-document'

export interface SkillDocumentPreviewProps extends SkillDocumentInput {
  className?: string
}

export const SkillDocumentPreview: FC<SkillDocumentPreviewProps> = ({
  name,
  description,
  body,
  metadata,
  className,
}) => {
  const t = useTranslations('skills')
  const { frontmatter, body: renderedBody } = renderSkillDocumentParts({
    // Placeholders keep the document well-formed while it is being typed, so
    // the pane never flickers between valid and broken YAML mid-keystroke.
    name: name.trim() || 'skill-name',
    description: description.trim() || t('editor.preview.descriptionPlaceholder'),
    body,
    metadata,
  })

  return (
    <section
      className={cn('flex flex-col gap-2', className)}
      aria-labelledby="skill-document-preview-heading"
      data-testid="skill-document-preview"
    >
      <h3 id="skill-document-preview-heading" className="text-sm font-medium">
        {t('editor.preview.heading')}
      </h3>
      <p className="text-muted-foreground text-xs">{t('editor.preview.subtitle')}</p>

      <div className="overflow-hidden rounded-lg border">
        {/* Level 1 — the part that is always loaded. */}
        <div className="border-border/70 bg-muted/40 border-b px-3 py-1.5">
          <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('editor.preview.level1')}
          </p>
          <p className="text-muted-foreground/90 text-[11px] leading-snug">
            {t('editor.preview.level1Hint')}
          </p>
        </div>
        <pre className="whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed">
          <code>{frontmatter}</code>
        </pre>

        {/* Level 2 — loaded only if the agent activates the skill. */}
        <div className="border-border/70 bg-muted/40 border-y px-3 py-1.5">
          <p className="text-[10.5px] font-medium uppercase tracking-wider text-muted-foreground">
            {t('editor.preview.level2')}
          </p>
          <p className="text-muted-foreground/90 text-[11px] leading-snug">
            {t('editor.preview.level2Hint')}
          </p>
        </div>
        {/* Wrapped, not horizontally scrolled: an instruction line longer than the
            pane was simply cut off at the right edge, which contradicts the one
            thing this pane claims — that it shows exactly what is stored. Vertical
            scrolling is fine; the body is long by design. */}
        {renderedBody ? (
          <pre className="max-h-64 overflow-y-auto whitespace-pre-wrap break-words px-3 py-2 font-mono text-[11px] leading-relaxed">
            <code>{renderedBody}</code>
          </pre>
        ) : (
          <p className="text-muted-foreground px-3 py-2 text-[11px] italic">
            {t('editor.preview.emptyBody')}
          </p>
        )}
      </div>
    </section>
  )
}
