/**
 * AuthorityTag — the compact OIB / RIS / ÖNORM badge shown inside a Baurecht
 * source chip and Herleitung card (ADR-0026). It distinguishes the authority
 * tier (binding law vs. adopted guideline vs. external standard) WITHOUT
 * splitting the color family: it tints with the chip's own `currentColor`, so
 * it always reads as part of the chip. `shrink-0` keeps it whole while the
 * label truncates. One component so the chips and the fan-out never drift.
 */

import type { FC, ReactNode } from 'react'

export const AuthorityTag: FC<{ children: ReactNode }> = ({ children }) => (
  <span
    className="shrink-0 rounded-[3px] px-1 text-[9px] font-bold uppercase leading-[1.5] tracking-wide"
    style={{ backgroundColor: 'color-mix(in oklch, currentColor 16%, transparent)' }}
  >
    {children}
  </span>
)
