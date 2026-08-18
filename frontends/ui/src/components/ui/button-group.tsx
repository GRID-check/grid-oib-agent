import * as React from 'react'

import { cn } from '@/lib/utils'

function ButtonGroup({
  className,
  orientation = 'horizontal',
  ...props
}: React.ComponentProps<'div'> & { orientation?: 'horizontal' | 'vertical' }): React.JSX.Element {
  return (
    <div
      data-slot="button-group"
      role="group"
      data-orientation={orientation}
      className={cn(
        'inline-flex items-center rounded-lg border border-border bg-card p-0.5 shadow-2xs',
        orientation === 'vertical' && 'flex-col',
        className,
      )}
      {...props}
    />
  )
}

function ButtonGroupSeparator({
  className,
  ...props
}: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="button-group-separator"
      role="separator"
      aria-orientation="vertical"
      className={cn('mx-0.5 h-5 w-px shrink-0 bg-border', className)}
      {...props}
    />
  )
}

export { ButtonGroup, ButtonGroupSeparator }
