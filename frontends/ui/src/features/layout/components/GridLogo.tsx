/**
 * GridLogo Component
 *
 * Local inline-SVG Grid logo mark for the chat shell. Replaces the
 * legacy adapter `Logo` re-export in migrated layout components.
 */

import { type FC } from 'react'
import { PRODUCT_NAME } from '@/lib/brand'
import { cn } from '@/lib/utils'

interface GridLogoProps {
  /** Icon size in pixels (default 20) */
  size?: number
  className?: string
}

/** Grid logo icon, colored via the brand text token. */
export const GridLogo: FC<GridLogoProps> = ({ size = 20, className }) => (
  <span
    role="img"
    aria-label={PRODUCT_NAME}
    className={cn('inline-flex shrink-0 items-center text-brand', className)}
  >
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 0h8v8h-8v-8z" />
    </svg>
  </span>
)
