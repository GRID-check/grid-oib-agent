'use client'

/**
 * MultiSelect — pick any number of values from a list, shown as removable chips
 * in a field-shaped well, with a searchable, keyboard-driven list behind it.
 *
 * The kit had single choice (`Select`, `ToggleGroup`), a command palette
 * (`Command`) and a floating panel (`Popover`), and nothing that picked several
 * values from a list too long for a toggle row: the intake wizard's
 * `ChipMultiSelect` lays every option out as a pill, which works for six options
 * and not for two hundred organizations. This composes the three that exist.
 *
 * - **Chips are the value.** Each selected option is a `Chip` with its own
 *   remove button, beside (never inside) the trigger, so no button nests in a
 *   button. Past `maxChips` the rest collapse into one "+N" chip that opens the
 *   list, so a long selection cannot push the row off a phone.
 * - **The list is `Command`.** Type to narrow, ↑ ↓ to move, Enter to toggle,
 *   Escape to close; the list stays open while picking, because picking several
 *   is the point. Backspace in an empty search removes the last chip.
 * - **Counts are optional and quiet.** "Brandschutz · 42" is a `CountPill`
 *   beside the label: a picker that shows how much is behind each value saves
 *   the reader a round trip to a value with nothing in it.
 * - **A value the list does not know** (an id from a link, before the options
 *   load) still shows as a chip, labelled by `labelFor` or by the value itself,
 *   so a selection is never silently dropped from view.
 */

import * as React from 'react'
import { Check, ChevronDown, X } from 'lucide-react'

import { cn } from '@/lib/utils'
import { Chip } from '@/components/ui/chip'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { CountPill } from '@/components/ui/count-pill'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Spinner } from '@/components/ui/spinner'

export interface MultiSelectOption {
  value: string
  label: string
  /** Shown as a quiet count beside the label. */
  count?: number
  /** A second, muted line (an organization under a project, say). */
  hint?: string
}

export interface MultiSelectProps {
  options: readonly MultiSelectOption[]
  value: readonly string[]
  onValueChange: (next: string[]) => void
  /** Shown in the well while nothing is selected. Also the "all" reading of an empty selection. */
  placeholder: string
  /** The control's accessible name. */
  label: string
  searchPlaceholder?: string
  /** Shown when the search matches nothing. */
  emptyText?: string
  /** Accessible name of a chip's remove button. */
  removeLabel?: (label: string) => string
  /** Text of the collapsed "+N" chip. */
  moreLabel?: (count: number) => string
  /** Label of a selected value the options do not (yet) contain. */
  labelFor?: (value: string) => string
  /** Chips shown before the rest collapse into "+N". */
  maxChips?: number
  /** Offer the search field. Defaults to on past eight options. */
  searchable?: boolean
  disabled?: boolean
  /** The options are being fetched: the list shows a spinner instead of "nothing found". */
  loading?: boolean
  formatCount?: (count: number) => string
  id?: string
  className?: string
  'data-testid'?: string
}

const SEARCH_THRESHOLD = 8

function MultiSelect({
  options,
  value,
  onValueChange,
  placeholder,
  label,
  searchPlaceholder,
  emptyText,
  removeLabel = (name) => `Remove ${name}`,
  moreLabel = (count) => `+${count}`,
  labelFor,
  maxChips = 3,
  searchable,
  disabled = false,
  loading = false,
  formatCount = String,
  id,
  className,
  'data-testid': testId,
}: MultiSelectProps): React.JSX.Element {
  const [open, setOpen] = React.useState(false)
  const [search, setSearch] = React.useState('')
  const listId = React.useId()

  const selected = React.useMemo(() => new Set(value), [value])
  const byValue = React.useMemo(() => new Map(options.map((option) => [option.value, option])), [options])
  const nameOf = (entry: string): string => byValue.get(entry)?.label ?? labelFor?.(entry) ?? entry

  /** The selection in the options' order, then anything the options do not know. */
  const ordered = (next: ReadonlySet<string>): string[] => [
    ...options.filter((option) => next.has(option.value)).map((option) => option.value),
    ...[...next].filter((entry) => !byValue.has(entry)),
  ]

  const toggle = (entry: string): void => {
    const next = new Set(selected)
    if (next.has(entry)) next.delete(entry)
    else next.add(entry)
    onValueChange(ordered(next))
  }
  const remove = (entry: string): void => onValueChange(value.filter((current) => current !== entry))

  const shown = value.slice(0, maxChips)
  const hidden = value.length - shown.length
  const withSearch = searchable ?? options.length > SEARCH_THRESHOLD

  return (
    <Popover
      open={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setSearch('')
      }}
    >
      <PopoverAnchor asChild>
        <div
          role="group"
          aria-label={label}
          data-slot="multi-select"
          data-testid={testId}
          data-disabled={disabled || undefined}
          className={cn(
            // The field's material: the same well, border and radius as `Input`,
            // growing in height when the chips wrap rather than scrolling them.
            'border-input bg-input-background flex min-h-10 w-full min-w-0 flex-wrap items-center gap-1 rounded-lg border py-1 pr-1 pl-1.5 text-sm pointer-coarse:min-h-11',
            'transition-[border-color,box-shadow] duration-quick ease-out motion-reduce:transition-none',
            'has-[[data-slot=multi-select-trigger]:focus-visible]:border-ring has-[[data-slot=multi-select-trigger]:focus-visible]:ring-2 has-[[data-slot=multi-select-trigger]:focus-visible]:ring-ring/20',
            disabled && 'cursor-not-allowed opacity-50',
            className
          )}
        >
          {shown.map((entry) => {
            const name = nameOf(entry)
            return (
              <Chip key={entry} variant="secondary" className="max-w-full gap-0.5 pr-0.5" data-slot="multi-select-chip">
                <span className="truncate">{name}</span>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => remove(entry)}
                  aria-label={removeLabel(name)}
                  className={cn(
                    'text-muted-foreground hover:bg-accent hover:text-foreground touch-target inline-flex size-4 shrink-0 items-center justify-center rounded-sm outline-none',
                    FOCUS_RING
                  )}
                >
                  <X className="size-3" aria-hidden />
                </button>
              </Chip>
            )
          })}
          {hidden > 0 ? (
            <Chip asChild variant="muted" interactive>
              <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
                {moreLabel(hidden)}
              </button>
            </Chip>
          ) : null}
          <PopoverTrigger asChild>
            <button
              type="button"
              id={id}
              disabled={disabled}
              data-slot="multi-select-trigger"
              role="combobox"
              aria-expanded={open}
              aria-controls={listId}
              aria-haspopup="listbox"
              aria-label={label}
              className={cn(
                // With chips in the well the trigger is just the chevron, so it
                // may shrink to it rather than wrap onto a line of its own.
                'text-muted-foreground flex min-h-7 flex-1 items-center justify-between gap-2 rounded-md px-1.5 text-left outline-none disabled:cursor-not-allowed',
                value.length === 0 ? 'min-w-16' : 'min-w-6 justify-end',
                'pointer-coarse:min-h-9'
              )}
            >
              <span className="truncate">{value.length === 0 ? placeholder : ''}</span>
              <ChevronDown className="size-4 shrink-0 opacity-70" aria-hidden />
            </button>
          </PopoverTrigger>
        </div>
      </PopoverAnchor>
      <PopoverContent
        align="start"
        className="w-[var(--radix-popover-trigger-width)] min-w-64 max-w-[calc(100vw-2rem)] p-0"
        collisionPadding={16}
      >
        <Command
          // Filtering is cmdk's; each item matches on its label (`keywords`)
          // as well as its value, which may be an opaque id.
          onKeyDown={(event) => {
            if (event.key === 'Backspace' && search === '' && value.length > 0) {
              event.preventDefault()
              remove(value[value.length - 1])
            }
          }}
        >
          {withSearch ? (
            <CommandInput
              value={search}
              onValueChange={setSearch}
              placeholder={searchPlaceholder}
              aria-label={searchPlaceholder ?? label}
            />
          ) : null}
          <CommandList id={listId} aria-label={label} aria-multiselectable="true">
            {loading ? (
              <div className="flex justify-center py-6" role="status">
                <Spinner size="sm" className="text-muted-foreground" aria-hidden />
              </div>
            ) : (
              <CommandEmpty>{emptyText}</CommandEmpty>
            )}
            <CommandGroup>
              {options.map((option) => {
                const checked = selected.has(option.value)
                return (
                  <CommandItem
                    key={option.value}
                    value={option.value}
                    keywords={[option.label, option.hint ?? '']}
                    onSelect={() => toggle(option.value)}
                    aria-checked={checked}
                    data-checked={checked || undefined}
                    className="pointer-coarse:min-h-11"
                  >
                    <span
                      aria-hidden
                      className={cn(
                        'border-input flex size-4 shrink-0 items-center justify-center rounded-sm border',
                        checked && 'border-primary bg-primary text-primary-foreground'
                      )}
                    >
                      {checked ? <Check className="size-3" /> : null}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{option.label}</span>
                      {option.hint ? (
                        <span className="text-muted-foreground truncate text-xs">{option.hint}</span>
                      ) : null}
                    </span>
                    {option.count !== undefined ? <CountPill>{formatCount(option.count)}</CountPill> : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { MultiSelect }
