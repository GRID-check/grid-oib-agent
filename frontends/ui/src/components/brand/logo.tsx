/**
 * Piloti product logo: the column mark plus an optional wordmark.
 * The mark is the master's path (`BRAND_MARK`, from `shared/brand/piloti-mark.svg`)
 * cropped to the column, drawn in `currentColor` so it follows light and dark.
 */

import { type FC } from 'react'
import { BRAND_MARK, PRODUCT_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

interface LogoProps {
  /** 'horizontal' renders the mark + wordmark; 'logo-only' renders the mark alone */
  kind?: 'horizontal' | 'logo-only'
  size?: 'small' | 'medium' | 'large'
  className?: string
}

/** Mark heights; the width follows the column's 5:6. */
const markSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'h-5',
  medium: 'h-7',
  large: 'h-10',
}

const wordmarkSize: Record<NonNullable<LogoProps['size']>, string> = {
  small: 'text-sm',
  medium: 'text-lg',
  large: 'text-2xl',
}

export const Logo: FC<LogoProps> = ({ kind = 'horizontal', size = 'medium', className }) => {
  return (
    <span className={cn('inline-flex items-center gap-2', className)} role="img" aria-label={PRODUCT_NAME}>
      <svg
        xmlns="http://www.w3.org/2000/svg"
        viewBox={BRAND_MARK.viewBox}
        fill="currentColor"
        className={cn('aspect-[5/6] w-auto shrink-0 text-primary', markSize[size])}
        aria-hidden="true"
      >
        <path d={BRAND_MARK.path} />
      </svg>
      {kind === 'horizontal' && (
        <span className={cn('font-semibold tracking-tight text-foreground', wordmarkSize[size])}>{PRODUCT_NAME}</span>
      )}
    </span>
  )
}
