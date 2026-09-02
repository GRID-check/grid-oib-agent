import * as React from 'react'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

const spinnerSizeMap = {
  xs: 'size-3.5',
  sm: 'size-4',
  default: 'size-6',
  lg: 'size-8',
} as const

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: keyof typeof spinnerSizeMap
  label?: string
}

const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ className, size = 'default', label = 'Loading', ...props }, ref) => {
    // Next to visible status copy, callers pass aria-hidden so we don't
    // announce "Loading" (or the same phrase twice) through role=status + sr-only.
    const decorative = props['aria-hidden'] === true || props['aria-hidden'] === 'true'
    return (
      <span
        ref={ref}
        data-slot="spinner"
        role={decorative ? undefined : 'status'}
        aria-label={decorative ? undefined : label}
        className={cn('inline-flex', className)}
        {...props}
      >
        <Loader2
          className={cn('animate-spin motion-reduce:animate-none', spinnerSizeMap[size])}
          aria-hidden="true"
        />
        {decorative ? null : <span className="sr-only">{label}</span>}
      </span>
    )
  }
)
Spinner.displayName = 'Spinner'

export { Spinner }
