// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * GRID product logo — inline SVG mark plus optional wordmark.
 * Token-driven (text-primary / brand accent), so it adapts to light/dark.
 */

import { type FC } from 'react'
import { cn } from '@/lib/utils'

interface LogoProps {
  /** 'horizontal' renders the mark + wordmark; 'logo-only' renders the mark alone */
  kind?: 'horizontal' | 'logo-only'
  size?: 'small' | 'medium' | 'large'
  className?: string
}

const markSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'size-5',
  medium: 'size-7',
  large: 'size-10',
}

const wordmarkSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'text-sm',
  medium: 'text-lg',
  large: 'text-2xl',
}

export const Logo: FC<LogoProps> = ({ kind = 'horizontal', size = 'medium', className }) => {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} role="img" aria-label="Grid">
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className={cn('shrink-0 text-primary', markSize[size])}
        aria-hidden="true"
      >
        <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
      </svg>
      {kind === 'horizontal' && (
        <span className={cn('font-semibold tracking-tight text-foreground', wordmarkSize[size])}>Grid</span>
      )}
    </span>
  )
}
