'use client'

/**
 * Organisation → Anweisungen: the standing instruction block the whole
 * organization's turns carry.
 *
 * Its own card, and its own PUT (`/api/organization/instructions`), rather than
 * a field on the settings form beside it. Two reasons, and the second is the
 * one that matters:
 *
 *   - it is a different row with a different bound and a different write
 *     (`organization_instructions`, migration 0087), not a key in the settings
 *     bag; and
 *   - it is the only control on this page that changes what Piloti SAYS. A
 *     display name and a default language are chrome. This is an instruction
 *     every answer in the organization is written under, and it deserves to be
 *     read as one rather than tabbed past between a name field and a language
 *     picker.
 *
 * The counter is live and counts DOWN from the cap the server enforces
 * (`ORG_INSTRUCTIONS_MAX_CHARS`), because a bound somebody only discovers by
 * being refused is a bound they will discover with a paragraph already written.
 * Over the cap the editor refuses to save and says so; it does not silently
 * truncate, since an instruction cut mid-sentence says something its author
 * never wrote.
 */

import { type FC, useCallback, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Field, FieldDescription, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Textarea } from '@/components/ui/textarea'
import { useTranslations } from '@/i18n'
import { ORG_INSTRUCTIONS_MAX_CHARS } from '@/lib/org-instructions/constants'
import { cn } from '@/lib/utils'

interface OrgInstructionsFormProps {
  /** What the organization has stored, or null when it has written none. */
  initialInstructions: string | null
}

export const OrgInstructionsForm: FC<OrgInstructionsFormProps> = ({ initialInstructions }) => {
  const t = useTranslations('organization')

  const [text, setText] = useState(initialInstructions ?? '')
  const [baseline, setBaseline] = useState(initialInstructions ?? '')
  const [saving, setSaving] = useState(false)

  const remaining = ORG_INSTRUCTIONS_MAX_CHARS - text.length
  const overCap = remaining < 0
  const isDirty = text.trim() !== baseline.trim()

  const submit = useCallback(
    async (next: string) => {
      setSaving(true)
      try {
        const res = await fetch('/api/organization/instructions', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ instructions: next }),
        })
        if (!res.ok) throw new Error(`Save failed (${res.status})`)
        setBaseline(next.trim())
        setText(next)
        toast.success(next.trim() ? t('instructions.saved') : t('instructions.cleared'))
      } catch {
        toast.error(t('instructions.saveError'))
      } finally {
        setSaving(false)
      }
    },
    [t],
  )

  return (
    <FieldGroup>
      <Field>
        <FieldLabel htmlFor="org-instructions">{t('instructions.label')}</FieldLabel>
        <Textarea
          id="org-instructions"
          value={text}
          rows={8}
          // The atom sizes to its content, which is right for a few lines and
          // wrong for a pasted house-style guide: past the cap the box would
          // grow until Save and the counter were off the bottom of the screen,
          // exactly when the reader needs to see both. Bounded and scrolling
          // instead.
          className="max-h-72 overflow-y-auto"
          aria-invalid={overCap || undefined}
          aria-describedby="org-instructions-counter"
          placeholder={t('instructions.placeholder')}
          onChange={(event) => setText(event.target.value)}
        />
        <FieldDescription>{t('instructions.hint')}</FieldDescription>
        <p
          id="org-instructions-counter"
          aria-live="polite"
          className={cn('text-xs', overCap ? 'text-destructive' : 'text-muted-foreground')}
          data-testid="org-instructions-counter"
        >
          {overCap
            ? t('instructions.overCap', { over: -remaining })
            : t('instructions.remaining', {
                used: text.length,
                max: ORG_INSTRUCTIONS_MAX_CHARS,
              })}
        </p>
      </Field>

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void submit(text)} disabled={saving || overCap || !isDirty}>
          {saving ? t('instructions.saving') : t('instructions.save')}
        </Button>
        {/* Clearing is its own act, not "save an empty box": the box is often
            emptied on the way to rewriting it, and a Save that was disabled
            because nothing had changed yet must not become the thing that
            wipes the instruction. */}
        <Button
          variant="ghost"
          onClick={() => void submit('')}
          disabled={saving || (text === '' && baseline === '')}
        >
          {t('instructions.clear')}
        </Button>
      </div>
    </FieldGroup>
  )
}
