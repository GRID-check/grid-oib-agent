// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

import * as React from 'react'
import { Loader2 } from 'lucide-react'

import { cn } from '@/lib/utils'

const spinnerSizeMap = {
  sm: 'size-4',
  default: 'size-6',
  lg: 'size-8',
} as const

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: keyof typeof spinnerSizeMap
  label?: string
}

const Spinner = React.forwardRef<HTMLSpanElement, SpinnerProps>(
  ({ className, size = 'default', label = 'Loading', ...props }, ref) => (
    <span
      ref={ref}
      data-slot="spinner"
      role="status"
      aria-label={label}
      className={cn('inline-flex', className)}
      {...props}
    >
      <Loader2 className={cn('animate-spin', spinnerSizeMap[size])} aria-hidden="true" />
      <span className="sr-only">{label}</span>
    </span>
  )
)
Spinner.displayName = 'Spinner'

export { Spinner }
