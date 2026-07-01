// SPDX-FileCopyrightText: Copyright (c) 2025-2026, GRID. All rights reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Logo Component
 *
 * Renders the Grid product logo as an inline SVG icon plus optional wordmark.
 * This replaces the previous NVIDIA eye-mark logo.
 */

import { type FC } from 'react'

interface LogoProps {
  /** 'horizontal' renders the icon + wordmark; 'logo-only' renders the icon alone */
  kind?: 'horizontal' | 'logo-only'
  size?: 'small' | 'medium' | 'large'
  className?: string
}

/** Icon dimensions for each size. */
const iconSizeMap = {
  small: { width: 20, height: 20 },
  medium: { width: 28, height: 28 },
  large: { width: 40, height: 40 },
} as const

/** Wordmark font size for each size. */
const wordmarkSizeMap = {
  small: '0.875rem',
  medium: '1.125rem',
  large: '1.5rem',
} as const

/**
 * Renders the Grid logo.
 *
 * The icon uses the theme's brand color via the `text-brand` utility.
 */
export const Logo: FC<LogoProps> = ({ kind = 'horizontal', size = 'medium', className }) => {
  const isIconOnly = kind === 'logo-only'
  const dims = iconSizeMap[size]

  return (
    <span
      className={`inline-flex items-center gap-2 ${className ?? ''}`}
      style={{ color: 'var(--text-color-brand)' }}
      aria-label="Grid"
      role="img"
    >
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        width={dims.width}
        height={dims.height}
        fill="currentColor"
        className="text-brand shrink-0"
        aria-hidden="true"
      >
        <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
      </svg>

      {!isIconOnly && (
        <span
          style={{
            fontSize: wordmarkSizeMap[size],
            fontWeight: 600,
            lineHeight: 1,
            color: 'var(--text-color-brand)',
          }}
        >
          Grid
        </span>
      )}
    </span>
  )
}
