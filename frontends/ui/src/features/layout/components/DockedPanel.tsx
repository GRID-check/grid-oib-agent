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

import { type FC, type ReactNode, useCallback, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { useEscapeKey } from '@/shared/hooks/use-escape-key'
import { usePanelFocus } from '@/shared/hooks/use-panel-focus'

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
  const isMobile = useIsMobile()
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // On open, move focus to the close button; remember the opener so Escape can
  // return focus to it. Hooks must run unconditionally, so this precedes the
  // early return below.
  const { restoreFocus } = usePanelFocus(open, closeButtonRef)

  const handleEscape = useCallback(() => {
    restoreFocus()
    onClose()
  }, [restoreFocus, onClose])

  // Escape closes the panel; the listener is inert (and unregistered) while
  // the panel is closed.
  useEscapeKey(open, handleEscape)

  if (!open && !forceMount) return null

  return (
    <aside
      role="dialog"
      // Full-screen on mobile, where the panel covers the page and behaves
      // modally; on desktop it docks beside still-usable content, so it is a
      // non-modal dialog.
      aria-modal={isMobile}
      aria-label={ariaLabel}
      aria-hidden={!open}
      data-state={open ? 'open' : 'closed'}
      className={cn(
        // Mobile docks under the top bar as a lifted modal; desktop has no
        // global header — the panel stays FLUSH on the shared chat plane
        // (bg-background), joined by a single hairline edge, and aligns to the
        // bottom of the h-12 chat toolbar. No desktop elevation → one surface.
        'fixed top-[var(--header-height)] z-40 flex h-[calc(100dvh-var(--header-height))] w-full max-w-[400px] flex-col bg-background shadow-lg md:top-12 md:h-[calc(100dvh-3rem)] md:shadow-none',
        side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
        // Slide transition; reduced-motion users get an instant swap
        'transition-transform duration-300 ease-in-out motion-reduce:transition-none',
        open ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full',
        !open && 'pointer-events-none',
        className
      )}
    >
      {/* Heading row — 48px to match the chat toolbar so the seams register */}
      <div className="flex h-12 shrink-0 items-center justify-between gap-2 border-b border-border/60 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm font-semibold">{heading}</div>
        <Button
          ref={closeButtonRef}
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
      {footer && <div className="shrink-0 border-t border-border/60 px-4 py-3">{footer}</div>}
    </aside>
  )
}
