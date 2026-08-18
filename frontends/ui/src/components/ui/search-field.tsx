'use client'

import type { ReactNode, Ref } from 'react'
import { Search, X } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { InputGroup, InputGroupAddon } from '@/components/ui/input-group'
import { cn } from '@/lib/utils'

export interface SearchFieldProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  label: string
  clearLabel?: string
  /** Called instead of `onChange('')` when the clear control is pressed. */
  onClear?: () => void
  className?: string
  inputClassName?: string
  clearClassName?: string
  /**
   * Default `text` so existing `role="textbox"` queries keep working
   * (DataToolbar, admin filters). Pass `search` only when the field is a
   * standalone search landmark.
   */
  type?: 'search' | 'text'
  inputRef?: Ref<HTMLInputElement>
  /** Optional control after the field (a run / submit button). */
  trailing?: ReactNode
}

/**
 * Magnifier + Input + optional clear. Every product search field is this
 * molecule — not a one-off `relative` wrapper next to `DataToolbar`.
 */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  clearLabel,
  onClear,
  className,
  inputClassName,
  clearClassName,
  type = 'text',
  inputRef,
  trailing,
}: SearchFieldProps): JSX.Element {
  const canClear = Boolean(clearLabel)
  const hasValue = Boolean(value)

  const field = (
    <InputGroup>
      <InputGroupAddon>
        <Search aria-hidden />
      </InputGroupAddon>
      <Input
        ref={inputRef}
        type={type}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        aria-label={label}
        className={cn(
          'h-9 pl-8 [&::-webkit-search-cancel-button]:hidden',
          // Reserve the clear gutter even when empty so typing does not shift text.
          canClear && 'pr-8',
          inputClassName,
        )}
      />
      {canClear ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          tabIndex={hasValue ? undefined : -1}
          aria-hidden={!hasValue}
          className={cn(
            'absolute right-0.5 top-1/2 size-8 -translate-y-1/2 text-muted-foreground',
            'transition-opacity duration-200 ease-out motion-reduce:transition-none',
            hasValue ? 'opacity-100' : 'pointer-events-none opacity-0',
            clearClassName,
          )}
          aria-label={clearLabel}
          onClick={() => {
            if (!hasValue) return
            onClear ? onClear() : onChange('')
          }}
        >
          <X className="size-3.5" aria-hidden />
        </Button>
      ) : null}
    </InputGroup>
  )

  if (!trailing) {
    return className ? <div className={className}>{field}</div> : field
  }

  return (
    <div className={cn('flex min-w-0 items-center gap-2', className)}>
      {field}
      <div className="shrink-0">{trailing}</div>
    </div>
  )
}
