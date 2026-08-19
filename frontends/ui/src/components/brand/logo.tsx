/**
 * Piloti product logo — inline SVG mark plus optional wordmark.
 * The mark is the abstract four-square glyph (kept from the GRID era — it does
 * not render any letterforms); only the wordmark text carries the brand name.
 * Token-driven (text-primary / brand accent), so it adapts to light/dark.
 */

import { type FC } from 'react'
import { PRODUCT_NAME } from '@/lib/brand'
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

// One step below the previous scale at every size, because the wordmark is now
// UPPERCASE and tracked out to 0.2em: caps plus letterspacing read roughly a
// step larger than the same number in mixed case, so keeping the old sizes
// would have grown the lockup rather than restyled it.
const wordmarkSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'text-xs',
  medium: 'text-base',
  large: 'text-xl',
}

export const Logo: FC<LogoProps> = ({ kind = 'horizontal', size = 'medium', className }) => {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} role="img" aria-label={PRODUCT_NAME}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox="0 0 24 24"
        fill="currentColor"
        className={cn('shrink-0 text-primary', markSize[size])}
        aria-hidden="true"
      >
        <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
      </svg>
      {/* The wordmark is the site's wordmark: Poppins medium, uppercase, 0.2em
          tracking (`frontends/web` atoms/Logo.astro). It is the one place
          `font-logo` and `tracking-logo` may be used. */}
      {kind === 'horizontal' && (
        <span
          className={cn(
            'font-logo font-medium uppercase tracking-logo text-foreground',
            wordmarkSize[size],
          )}
        >
          {PRODUCT_NAME}
        </span>
      )}
    </span>
  )
}
