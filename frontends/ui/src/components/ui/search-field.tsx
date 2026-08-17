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
  /** Default `search`. Use `text` when specs query `role="textbox"`. */
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
  type = 'search',
  inputRef,
  trailing,
}: SearchFieldProps): JSX.Element {
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
          value && clearLabel ? 'pr-8' : undefined,
          inputClassName,
        )}
      />
      {value && clearLabel ? (
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className={cn(
            'absolute right-0.5 top-1/2 size-8 -translate-y-1/2 text-muted-foreground md:size-6',
            clearClassName,
          )}
          aria-label={clearLabel}
          onClick={() => (onClear ? onClear() : onChange(''))}
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
    <div className={cn('flex items-center gap-2', className)}>
      {field}
      {trailing}
    </div>
  )
}
