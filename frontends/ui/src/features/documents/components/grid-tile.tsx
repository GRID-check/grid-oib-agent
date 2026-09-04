'use client'

import type { ComponentProps, ReactNode } from 'react'
import { motion, motionQuick, springPress } from '@/components/motion'
import { cn } from '@/lib/utils'

export type GridTileVariant = 'file' | 'folder'

export interface GridTileShellProps extends Omit<ComponentProps<'div'>, 'ref'> {
  variant?: GridTileVariant
  interactive?: boolean
  children: ReactNode
}

/**
 * Single rewrite point for the file grid's tiles.
 *
 * `file` keeps the existing raised-card look: a white body on a muted tray.
 * `folder` is the same shell on a plain card surface, so the two are told apart
 * by the tile's own contents — a folder glyph filling the well where a document
 * shows its first page — rather than by a tint. Both share the outer sizing, the
 * shadow lifecycle, the hover lift and the footer alignment, so changing `gap`
 * or `rounded-xl` here moves both.
 *
 * ## Why the folder is not amber any more
 *
 * It was `border-amber-200/60` over a `from-amber-50/80 … to-orange-50/30`
 * wash, and that was wrong twice. Chroma in this product belongs to the source
 * signal system and to nothing else (`grid-design-language.md`: "provenance
 * signals are the only chroma… a control that wants to stand out wants
 * contrast, not chroma"), and gold in particular is `--source-office` — the tint
 * on the `JPG` and `PNG` chips in the same listing. One hue meant two unrelated
 * things on one screen.
 *
 * It also was not paint that did anything: at those opacities the wash is
 * indistinguishable from the card surface in the grid, while the same palette
 * on the detail view's full-width folder ROWS read as a warning strip over a
 * table where nothing is wrong. That is the report this came out of.
 */
export function GridTileShell({ variant = 'file', interactive = true, className, children, ...rest }: GridTileShellProps): JSX.Element {
  const shell =
    variant === 'folder' ? (
      <div
        className={cn(
          'border-border bg-card shadow-xs relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border',
          'transition-shadow duration-quick ease-out motion-reduce:transition-none',
          interactive && 'hover:shadow-md',
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    ) : (
      <div
        className={cn(
          'border-border bg-muted/50 shadow-xs relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border',
          'transition-shadow duration-quick ease-out motion-reduce:transition-none',
          interactive && 'hover:shadow-md',
          className,
        )}
        {...rest}
      >
        {children}
      </div>
    )

  if (!interactive) return shell
  return (
    <motion.div className="h-full min-w-0 will-change-transform" whileHover={{ y: -2, transition: motionQuick }} whileTap={{ scale: 0.99, transition: springPress }}>
      {shell}
    </motion.div>
  )
}

export function GridTileMedia({ className, children, ...rest }: ComponentProps<'div'>): JSX.Element {
  return (
    <div className={cn('relative w-full overflow-hidden border-b bg-card', className)} {...rest}>
      {children}
    </div>
  )
}

export function GridTileBody({ className, children, ...rest }: ComponentProps<'div'>): JSX.Element {
  return (
    <div className={cn('bg-card shadow-xs w-full overflow-hidden rounded-b-lg px-4 pb-3 pt-3.5', className)} {...rest}>
      {children}
    </div>
  )
}

export function GridTileFooter({ className, children, ...rest }: ComponentProps<'div'>): JSX.Element {
  return (
    <div className={cn('text-muted-foreground mt-auto flex w-full items-center gap-1.5 px-3.5 py-2 text-xs', className)} {...rest}>
      {children}
    </div>
  )
}
