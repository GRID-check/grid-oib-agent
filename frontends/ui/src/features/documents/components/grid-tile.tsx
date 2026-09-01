'use client'

import type { ComponentProps, JSX, ReactNode } from 'react'
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
 * `file` keeps the existing raised-card look (white body on muted tray).
 * `folder` renders the amber folder silhouette (tab + warm wash) so a folder
 * never looks like a document, yet both share the same outer sizing, shadow
 * lifecycle, hover lift, and footer alignment — changing `gap` or `rounded-xl`
 * here moves both.
 */
export function GridTileShell({ variant = 'file', interactive = true, className, children, ...rest }: GridTileShellProps): JSX.Element {
  const shell =
    variant === 'folder' ? (
      <div
        className={cn(
          'relative flex h-full min-w-0 flex-col overflow-hidden rounded-xl border shadow-xs',
          'border-amber-200/60 bg-gradient-to-br from-amber-50/80 via-amber-50/40 to-orange-50/30',
          'transition-[box-shadow,border-color,transform] duration-quick ease-out motion-reduce:transition-none',
          interactive && 'hover:border-amber-300/60 hover:shadow-md',
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

/** Folder tab bar — visual cue before any icon loads. */
export function GridTileFolderTab(): JSX.Element {
  return (
    <div className="flex h-6 shrink-0 items-end px-3 pt-1" aria-hidden>
      <div className="h-3 w-16 rounded-t-md bg-amber-200/70 dark:bg-amber-800/40" />
    </div>
  )
}
