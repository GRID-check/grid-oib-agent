'use client'

import type { ComponentProps, ReactNode } from 'react'
import { motion, motionQuick, springPress } from '@/components/motion'
import { cn } from '@/lib/utils'

export interface GridTileShellProps extends Omit<ComponentProps<'div'>, 'ref'> {
  interactive?: boolean
  children: ReactNode
}

/**
 * Single rewrite point for the file grid's tiles: the raised card every cell of
 * the grid is built on — a white body on a muted tray, one shadow lifecycle, one
 * hover lift, one footer alignment. Changing `gap` or `rounded-xl` here moves
 * the file cards, the folder cards and the skeletons together.
 *
 * ## There was a second variant, and nothing rendered it
 *
 * `variant: 'file' | 'folder'` existed, and the `folder` branch drew an amber
 * wash whose stated job was to make a folder never look like a document. It had
 * no caller: `FolderCard` passed `variant="file"` from the day the two were
 * unified, so the amber was rendered exactly once anywhere in the product — by
 * the skeleton written against the wrong branch, which is a skeleton that does
 * not describe its own component.
 *
 * The distinction it claimed to make is real and is made by the tile's
 * CONTENTS: a document shows its first page in the media well, a folder shows a
 * folder. That is why nobody ever noticed the branch was dead. It is gone, and
 * with it the last raw `amber-*` in this feature — chroma in this product
 * belongs to the source-signal system (`grid-design-language.md`), and gold
 * there means Büroarchiv provenance, which is what the `JPG` chip on the card
 * two cells over is saying.
 */
export function GridTileShell({ interactive = true, className, children, ...rest }: GridTileShellProps): JSX.Element {
  const shell = (
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
