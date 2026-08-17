'use client'

/**
 * The escape hatch: the whole SKILL.md, editable.
 *
 * The form above it is the right way to write a skill for the first time, but
 * it is a projection — three fields and three switches over a document that
 * people also receive as a file, copy from agentskills.io, paste out of another
 * tool, or simply want to edit in one place. Retyping a SKILL.md field by field
 * is busywork the product should not require, so this section takes the
 * document itself and writes it back into the form.
 *
 * Collapsed by default and labelled as advanced, because it is the one control
 * here that can undo the form's guardrails in a single paste, and because the
 * document is already visible read-only just above.
 *
 * APPLY IS EXPLICIT. The draft is a copy: it is seeded when the section opens
 * and nothing reaches the form until "apply" is pressed. Syncing on every
 * keystroke would mean a half-typed `name:` momentarily clearing the Name
 * field, and a document that does not parse — every document does not parse,
 * for a moment, while it is being typed — would have to either clobber the form
 * or be silently ignored. Neither is a thing to do to somebody's work.
 */

import { useCallback, useMemo, useState, type FC } from 'react'
import { ChevronDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { Field, FieldError, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { parseSkillDocument, type ParsedSkillDocument } from '../lib/skill-document'

export interface SkillRawDocumentSectionProps {
  /** The document the form currently describes — the seed for a fresh draft. */
  document: string
  /** Called with a parsed document when the author applies it. */
  onApply: (parsed: ParsedSkillDocument) => void
  className?: string
}

export const SkillRawDocumentSection: FC<SkillRawDocumentSectionProps> = ({
  document,
  onApply,
  className,
}) => {
  const t = useTranslations('skills')
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(document)

  // Seeding on open rather than in an effect: the draft must NOT follow the
  // form while the section is open, or typing in the fields above would
  // overwrite what is being edited here.
  const handleOpenChange = useCallback(
    (next: boolean) => {
      if (next) setDraft(document)
      setOpen(next)
    },
    [document],
  )

  const parsed = useMemo(() => parseSkillDocument(draft), [draft])
  const dirty = draft !== document

  const apply = useCallback(() => {
    if (!parsed.ok) return
    onApply(parsed.value)
    setOpen(false)
  }, [onApply, parsed])

  const status = !parsed.ok
    ? { tone: 'text-destructive', message: t(`editor.raw.errors.${parsed.error}`) }
    : parsed.value.ignoredKeys.length > 0
      ? {
          tone: 'text-warning-foreground',
          message: t('editor.raw.ignored', { keys: parsed.value.ignoredKeys.join(', ') }),
        }
      : dirty
        ? { tone: 'text-muted-foreground', message: t('editor.raw.ready') }
        : { tone: 'text-muted-foreground', message: t('editor.raw.unchanged') }

  return (
    <Collapsible
      open={open}
      onOpenChange={handleOpenChange}
      className={cn('border-border rounded-xl border', className)}
      data-testid="skill-raw-document"
    >
      <CollapsibleTrigger
        type="button"
        className="hover:bg-muted/50 focus-visible:ring-ring/50 flex w-full items-center justify-between gap-3 rounded-xl px-4 py-3 text-left transition-colors focus-visible:outline-none focus-visible:ring-2"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="text-sm font-medium">{t('editor.raw.heading')}</span>
          <span className="text-muted-foreground text-xs">{t('editor.raw.subtitle')}</span>
        </span>
        <ChevronDown
          className={cn(
            'text-muted-foreground size-4 shrink-0 transition-transform',
            open && 'rotate-180',
          )}
          aria-hidden
        />
      </CollapsibleTrigger>

      <CollapsibleContent className="border-border border-t px-4 py-3">
        <Field>
          <FieldLabel htmlFor="skill-raw-document">{t('editor.raw.documentLabel')}</FieldLabel>
          <Textarea
            id="skill-raw-document"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            spellCheck={false}
            rows={18}
            className="font-mono text-xs leading-relaxed"
            aria-invalid={!parsed.ok || undefined}
          />
          {!parsed.ok && <FieldError>{status.message}</FieldError>}
        </Field>
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-3">
          {parsed.ok && (
            <p role="status" className={cn('min-w-0 flex-1 text-xs', status.tone)}>
              {status.message}
            </p>
          )}
          <div className="ml-auto flex shrink-0 gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setDraft(document)}
              disabled={!dirty}
            >
              {t('editor.raw.reset')}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={apply}
              disabled={!parsed.ok || !dirty}
            >
              {t('editor.raw.apply')}
            </Button>
          </div>
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
