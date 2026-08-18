import { type ComponentProps } from 'react'
import { cn } from '@/lib/utils'

/**
 * How wide the content column is.
 *
 * `default` (max-w-5xl, 1024px) is the ONE column width for the app. Before the
 * shell change every surface picked its own — 1024 inside a project, 1152 on the
 * Archiv and the Organisation, 1080 on the projects home, 768 on Profil — so
 * moving between them re-flowed the text column under the reader's eyes.
 *
 * `wide` (max-w-6xl, 1152px) is the documented opt-in, and it is for CARD GRIDS
 * only: a grid whose cells are sized by content, not by measure, gets a third
 * column instead of a stretched second one. Prose, forms and settings stacks
 * take the default — a 1152px line of text is past the readable measure and no
 * amount of card grids elsewhere makes it not be.
 */
export type ShellContentWidth = 'default' | 'wide'

export interface ShellContentProps extends ComponentProps<'div'> {
  width?: ShellContentWidth
  /** Fill the frame's height and let a child own the scrolling (card libraries). */
  fill?: boolean
}

/**
 * The content column of the app shell.
 *
 * The `<main>` landmark, the scroll container and the route-focus target all
 * live in the shell layout — this is only the centred column inside it, so a
 * page never has to (and must never) restate `min-h-dvh`, `id="main-content"`
 * or its own `<main>`.
 */
export function ShellContent({
  width = 'default',
  fill = false,
  className,
  children,
  ...rest
}: ShellContentProps): JSX.Element {
  return (
    <div
      data-shell-content={width}
      className={cn(
        'mx-auto w-full px-4 md:px-8',
        width === 'wide' ? 'max-w-6xl' : 'max-w-5xl',
        fill ? 'flex h-full min-h-0 flex-col py-4 md:py-6' : 'py-6 md:py-10',
        className
      )}
      {...rest}
    >
      {children}
    </div>
  )
}
