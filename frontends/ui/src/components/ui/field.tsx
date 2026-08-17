import * as React from 'react'

import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'

export interface FieldProps extends React.ComponentProps<'div'> {
  orientation?: 'vertical' | 'horizontal'
}

function Field({ className, orientation = 'vertical', ...props }: FieldProps): React.JSX.Element {
  return (
    <div
      data-slot="field"
      data-orientation={orientation}
      className={cn(
        orientation === 'horizontal'
          ? 'flex items-start justify-between gap-4'
          : 'flex flex-col gap-1.5',
        className,
      )}
      {...props}
    />
  )
}

function FieldLabel({ className, ...props }: React.ComponentProps<typeof Label>): React.JSX.Element {
  return <Label data-slot="field-label" className={cn('text-sm font-medium', className)} {...props} />
}

function FieldDescription({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element {
  return (
    <p
      data-slot="field-description"
      className={cn('text-xs text-muted-foreground', className)}
      {...props}
    />
  )
}

function FieldError({ className, ...props }: React.ComponentProps<'p'>): React.JSX.Element {
  return (
    <p
      data-slot="field-error"
      role="alert"
      className={cn('text-xs font-medium text-destructive', className)}
      {...props}
    />
  )
}

function FieldGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return <div data-slot="field-group" className={cn('flex flex-col gap-4', className)} {...props} />
}

export { Field, FieldLabel, FieldDescription, FieldError, FieldGroup }
