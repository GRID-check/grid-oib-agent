import * as React from 'react'

import { cn } from '@/lib/utils'

function InputGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="input-group"
      role="group"
      className={cn('relative flex min-w-0 flex-1 items-center', className)}
      {...props}
    />
  )
}

function InputGroupAddon({
  align = 'start',
  className,
  ...props
}: React.ComponentProps<'span'> & { align?: 'start' | 'end' }): React.JSX.Element {
  return (
    <span
      data-slot="input-group-addon"
      className={cn(
        'pointer-events-none absolute top-1/2 z-10 -translate-y-1/2 text-muted-foreground [&_svg]:size-4',
        align === 'start' ? 'left-2.5' : 'right-1',
        className,
      )}
      {...props}
    />
  )
}

function InputGroupText({ className, ...props }: React.ComponentProps<'span'>): React.JSX.Element {
  return (
    <span
      data-slot="input-group-text"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

export { InputGroup, InputGroupAddon, InputGroupText }
