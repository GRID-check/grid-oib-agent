'use client'

/**
 * A prose field with the chat composer's `/` behaviour: type `/`, pick a skill,
 * and the name lands in the text.
 *
 * ## Why a task's prompt gets the composer's surface
 *
 * A standing task used to attach a skill through a `<Select>` in the wizard's
 * advanced section — one skill or none, whose body the fire prompt then pasted
 * in front of the model with no `use_skill` call and no judgment. That was the
 * last forcing mechanism in the product, wearing a different hat: `ADR-0060`
 * says nothing may impose a skill on a turn, "not the request, not the
 * deployment, not a job", and a picker that guaranteed the body made the job
 * the exception the doctrine denies.
 *
 * There was never a second mechanism needed. A person who wants a task to use
 * a playbook writes its name in the task, exactly as they would in chat: the
 * model reads the name among the words and decides, the same decision it makes
 * about every other skill in its catalog. So the wizard's prompt field IS the
 * chat input, with the same `/` menu and the same chip beneath it — one gesture
 * to learn, one mechanism to reason about, and nothing structured on the wire.
 *
 * ## What is shared and what is not
 *
 * The BEHAVIOUR is `useSlashCommand`, and that is the thing that must never
 * fork: what `/` matches, what picking writes, how the invocation is derived
 * back out of the text. This component and `InputArea` both call it, so a
 * change to any of those rules moves both surfaces at once.
 *
 * The LAYOUT is not shared, and should not be. The composer's picker hangs off
 * a popover anchored to a whole toolbar with files, a send button and a hint
 * slot; this one hangs under a form field. Forcing one component to serve both
 * would mean a prop for every difference between a chat composer and a form
 * input, which is the lookalike problem from the other direction.
 */

import { useId, useRef, type KeyboardEvent } from 'react'
import { AnimatePresence, motion, motionEntrance, motionQuick } from '@/components/motion'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { useSlashCommand } from '../hooks/use-slash-command'
import { InvokedSkillChip } from './InvokedSkillChip'
import { SlashCommandPicker } from './SlashCommandPicker'

export interface SkillPromptFieldProps {
  value: string
  onChange: (value: string) => void
  /** False turns `/` back into an ordinary character. */
  enabled?: boolean
  rows?: number
  placeholder?: string
  id?: string
  'aria-label'?: string
  'aria-describedby'?: string
  onBlur?: () => void
  className?: string
  'data-testid'?: string
}

export function SkillPromptField({
  value,
  onChange,
  enabled = true,
  rows = 8,
  placeholder,
  id,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  onBlur,
  className,
  'data-testid': testId,
}: SkillPromptFieldProps): JSX.Element {
  const fallbackId = useId()
  const fieldId = id ?? fallbackId
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const anchorRef = useRef<HTMLDivElement>(null)

  const slash = useSlashCommand({
    text: value,
    enabled,
    // The caret is restored after React has painted the replacement: setting
    // it synchronously puts it back where the old value's length said, which
    // for an insertion mid-prompt is several characters short.
    onReplaceText: (nextText, caret) => {
      onChange(nextText)
      requestAnimationFrame(() => {
        const node = textareaRef.current
        if (!node) return
        node.focus()
        node.setSelectionRange(caret, caret)
      })
    },
  })

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    // A form field has no submit-on-Enter, so the picker gets a no-op for the
    // key the composer would send on. Everything else — the arrows, Enter to
    // choose, Escape to dismiss — is the composer's behaviour unchanged.
    slash.handleKeyDown(event, () => {})
  }

  return (
    <div className={cn('flex flex-col gap-2', className)} data-testid={testId}>
      <Popover open={slash.open} onOpenChange={(next) => !next && slash.dismiss()}>
        <PopoverAnchor asChild>
          <div ref={anchorRef}>
            <Textarea
              ref={textareaRef}
              id={fieldId}
              rows={rows}
              value={value}
              placeholder={placeholder}
              aria-label={ariaLabel}
              aria-describedby={describedBy}
              onBlur={onBlur}
              onChange={(event) => {
                onChange(event.target.value)
                slash.syncQuery(event.target.value, event.target.selectionStart ?? 0)
              }}
              // The caret can move without the text changing, and a `/` the
              // user arrows back into has to re-open the panel.
              onKeyUp={(event) => {
                const node = event.currentTarget
                slash.syncQuery(node.value, node.selectionStart ?? 0)
              }}
              onClick={(event) => {
                const node = event.currentTarget
                slash.syncQuery(node.value, node.selectionStart ?? 0)
              }}
              onKeyDown={handleKeyDown}
              // Combobox semantics only while the picker is live, for the
              // reason the composer gives: a prose field that calls itself a
              // combobox at all times is worse for a screen reader than one
              // that announces the popup when it appears.
              role={slash.open ? 'combobox' : undefined}
              aria-expanded={slash.open ? true : undefined}
              aria-haspopup={slash.open ? 'listbox' : undefined}
              aria-autocomplete={slash.open ? 'list' : undefined}
              aria-controls={slash.open ? (slash.aria.listboxId ?? undefined) : undefined}
              aria-activedescendant={
                slash.open ? (slash.aria.activeOptionId ?? undefined) : undefined
              }
            />
          </div>
        </PopoverAnchor>
        <PopoverContent
          side="bottom"
          align="start"
          sideOffset={6}
          className="w-[var(--radix-popover-trigger-width)] border-0 bg-transparent p-0 shadow-none"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          onFocusOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => {
            // Moving the caret inside the field is not clicking away.
            const target = event.target as Node | null
            if (target && anchorRef.current?.contains(target)) event.preventDefault()
          }}
        >
          <SlashCommandPicker
            ref={slash.pickerRef}
            query={slash.query}
            skills={slash.skills}
            loading={slash.loading}
            onSelect={slash.select}
            onAriaChange={slash.onAriaChange}
          />
        </PopoverContent>
      </Popover>

      {/* The chip is DERIVED from the text, so removing it edits the name back
          out and the two can never disagree about what this task names. */}
      <AnimatePresence initial={false}>
        {slash.invokedSkill && (
          <motion.div
            key={`invoked-skill-${slash.invokedSkill.name}`}
            initial={{ opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0, transition: motionEntrance }}
            exit={{ opacity: 0, y: 2, transition: motionQuick }}
          >
            <InvokedSkillChip
              name={slash.invokedSkill.name}
              description={slash.invokedSkill.description}
              onRemove={slash.clearInvocation}
            />
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  )
}
