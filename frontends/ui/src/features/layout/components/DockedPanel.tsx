/**
 * DockedPanel Component
 *
 * Plain docked <aside> that replaces the KUI SidePanel for the chat shell
 * panels (Sessions, Settings, Data Sources). Docks under the app header,
 * has no overlay and no click-outside behavior (matching the previous
 * `closeOnClickOutside={false}` usage), and slides in from its side with a
 * translate transition that respects prefers-reduced-motion.
 *
 * Layout: heading row + scrollable body + optional footer.
 */

'use client'

import { type FC, type ReactNode } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/i18n'

interface DockedPanelProps {
  /** Whether the panel is open */
  open: boolean
  /** Which edge the panel docks to */
  side: 'left' | 'right'
  /** Heading row content (icon + title) */
  heading: ReactNode
  /** Optional footer content, pinned below the scrollable body */
  footer?: ReactNode
  /** Called when the close button is pressed */
  onClose: () => void
  /**
   * Keep the panel mounted while closed (slides out of view instead of
   * unmounting). Matches the previous SidePanel `forceMount` behavior.
   */
  forceMount?: boolean
  /** Accessible name for the aside */
  'aria-label': string
  /** Extra classes for the aside (e.g. width overrides) */
  className?: string
  children: ReactNode
}

/**
 * Docked side panel under the header. No overlay, no click-outside.
 */
export const DockedPanel: FC<DockedPanelProps> = ({
  open,
  side,
  heading,
  footer,
  onClose,
  forceMount = false,
  'aria-label': ariaLabel,
  className,
  children,
}) => {
  const t = useTranslations('research')
  if (!open && !forceMount) return null

  return (
    <aside
      aria-label={ariaLabel}
      aria-hidden={!open}
      data-state={open ? 'open' : 'closed'}
      className={cn(
        'fixed top-[var(--header-height)] z-40 flex h-[calc(100dvh-var(--header-height))] w-[400px] flex-col bg-background',
        side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
        // Slide transition; reduced-motion users get an instant swap
        'transition-transform duration-300 ease-in-out motion-reduce:transition-none',
        open ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full',
        !open && 'pointer-events-none',
        className
      )}
    >
      {/* Heading row */}
      <div className="flex h-14 shrink-0 items-center justify-between gap-2 border-b px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">{heading}</div>
        <Button
          variant="ghost"
          size="icon"
          className="size-8"
          onClick={onClose}
          aria-label={t('dockedPanel.closePanel')}
          title={t('dockedPanel.closePanel')}
        >
          <X className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>

      {/* Scrollable body */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto p-4">{children}</div>

      {/* Footer */}
      {footer && <div className="shrink-0 border-t px-4 py-3">{footer}</div>}
    </aside>
  )
}
