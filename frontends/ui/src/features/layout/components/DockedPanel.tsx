/**
 * DockedPanel Component
 *
 * Plain docked <aside> that replaces the KUI SidePanel for the chat shell
 * panels (Sessions, Settings, Data Sources). On desktop it docks beside the
 * still-usable chat plane with no overlay and no click-outside. On mobile it
 * behaves as a modal drawer: a tap-dismissable scrim dims the page behind it
 * and background scroll is locked, matching native mobile drawer conventions.
 * It slides in from its side with a translate transition that respects
 * prefers-reduced-motion.
 *
 * Layout: heading row + body + optional footer. The panel spans the FULL
 * viewport height on both breakpoints — see the class list for why it must.
 *
 * The body is a plain flex column that does NOT scroll. Panels own their own
 * internal regions, because "which part scrolls" is a per-panel decision: the
 * sessions panel pins its new-chat button and search field and scrolls only the
 * history list beneath them.
 */

'use client'

import { type FC, type ReactNode, type RefObject, useCallback, useEffect, useRef } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useIsMobile } from '@/hooks/use-is-mobile'
import { useTranslations } from '@/i18n'
import { useEscapeKey } from '@/shared/hooks/use-escape-key'
import { usePanelFocus } from '@/shared/hooks/use-panel-focus'
import { useBodyScrollLock } from '@/shared/hooks/use-body-scroll-lock'

interface DockedPanelProps {
  /** Whether the panel is open */
  open: boolean
  /** Which edge the panel docks to */
  side: 'left' | 'right'
  /** Heading row content (icon + title) */
  heading: ReactNode
  /** Optional footer content, pinned below the body */
  footer?: ReactNode
  /** Called when the close button is pressed */
  onClose: () => void
  /**
   * Keep the panel mounted while closed (slides out of view instead of
   * unmounting). Matches the previous SidePanel `forceMount` behavior.
   */
  forceMount?: boolean
  /**
   * Control that should receive focus when the panel opens, instead of the
   * close button. Pass this only when a panel has an obvious landing spot —
   * the sessions panel hands focus to its search field, since finding a past
   * chat is why you opened it. Leave it unset on mobile, where focusing a text
   * field throws up the on-screen keyboard before the user has asked for it.
   */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Accessible name for the aside */
  'aria-label': string
  /** Extra classes for the aside (e.g. width overrides) */
  className?: string
  children: ReactNode
}

/**
 * Docked side panel. No overlay and no click-outside on desktop.
 */
export const DockedPanel: FC<DockedPanelProps> = ({
  open,
  side,
  heading,
  footer,
  onClose,
  forceMount = false,
  initialFocusRef,
  'aria-label': ariaLabel,
  className,
  children,
}) => {
  const t = useTranslations('research')
  const isMobile = useIsMobile()
  const panelRef = useRef<HTMLElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)

  // A force-mounted panel stays in the DOM while closed, so its controls stay
  // in the tab order: Tab from the chat would walk into an off-screen dialog
  // that `aria-hidden` has already told assistive tech does not exist. `inert`
  // is the one attribute that removes BOTH — focus and the a11y tree. React 18
  // has no typing for it, hence the ref rather than a prop.
  //
  // This effect is declared BEFORE usePanelFocus so it runs first: focus must
  // not be handed to a control inside a still-inert subtree.
  useEffect(() => {
    const el = panelRef.current
    if (!el) return
    if (open) el.removeAttribute('inert')
    else el.setAttribute('inert', '')
  }, [open])

  // On open, move focus into the panel — to `initialFocusRef` when the panel
  // named one, otherwise the close button; remember the opener so Escape can
  // return focus to it. Hooks must run unconditionally, so this precedes the
  // early return below.
  const { restoreFocus } = usePanelFocus(open, initialFocusRef ?? closeButtonRef)

  // Shared dismissal path: return focus to the opener, then close. Used by
  // both Escape and the mobile scrim tap so they behave identically.
  const handleDismiss = useCallback(() => {
    restoreFocus()
    onClose()
  }, [restoreFocus, onClose])

  // Escape closes the panel; the listener is inert (and unregistered) while
  // the panel is closed.
  useEscapeKey(open, handleDismiss)

  // Lock background scroll while the drawer is open on mobile, where it covers
  // the page modally. Desktop docks beside usable content, so scroll stays free.
  useBodyScrollLock(isMobile && open)

  if (!open && !forceMount) return null

  return (
    <>
      {/* Mobile scrim: dims the page behind the drawer and dismisses it on
          tap. Mobile-only — desktop keeps the docked, non-modal behavior with
          no overlay. Sits just under the panel (z-30 < z-40). Decorative: the
          panel itself carries the dialog role and accessible name. */}
      {isMobile && open && (
        <div
          aria-hidden="true"
          onClick={handleDismiss}
          data-testid="docked-panel-backdrop"
          className="bg-overlay animate-in fade-in-0 fixed inset-0 z-30 backdrop-blur-sm duration-300 motion-reduce:animate-none md:hidden"
        />
      )}
      <aside
        ref={panelRef}
        role="dialog"
        // Full-screen on mobile, where the panel covers the page and behaves
        // modally; on desktop it docks beside still-usable content, so it is a
        // non-modal dialog.
        aria-modal={isMobile}
        aria-label={ariaLabel}
        aria-hidden={!open}
        data-state={open ? 'open' : 'closed'}
        className={cn(
          // FULL viewport height, flush with the top edge, on BOTH breakpoints.
          //
          // This used to start below a header (`top-[var(--header-height)]`,
          // `md:top-12`) — and neither header exists on the chat route, the only
          // route that opens these panels. Desktop chat has no top band at all
          // (its toolbar floats as pills inside the centre column), and the
          // mobile top bar is explicitly suppressed there. So the offset bought
          // nothing and cost a defect: the panel overlays the app rail from
          // `left-0`, so starting 48px down left the rail's "Piloti" wordmark
          // and collapse chevron stranded in a sliver above the panel — a strip
          // of a *different* surface (`bg-surface-sunken`) wedged above the
          // heading, which read as a stray gap.
          //
          // Flush to the top, the panel simply replaces the rail while it is
          // open: one surface, one top edge, nothing peeking over it.
          'bg-background fixed inset-y-0 z-40 flex w-full max-w-[400px] flex-col shadow-lg md:shadow-none',
          side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
          // Slide transition; reduced-motion users get an instant swap
          'transition-transform duration-300 ease-in-out motion-reduce:transition-none',
          open ? 'translate-x-0' : side === 'left' ? '-translate-x-full' : 'translate-x-full',
          !open && 'pointer-events-none',
          className
        )}
      >
        {/* Heading row — 48px, matching the chat toolbar pills' band so the
            seams register across the two surfaces. */}
        <div className="border-border/60 flex h-12 shrink-0 items-center justify-between gap-2 border-b px-4">
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

        {/* Body — a non-scrolling column; children own their padding and decide
            which region scrolls. `min-h-0` so a scrolling child of theirs can
            actually shrink instead of pushing the footer off the panel. */}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>

        {/* Footer */}
        {footer && (
          <div className="border-border/60 bg-background shrink-0 border-t px-4 py-3">{footer}</div>
        )}
      </aside>
    </>
  )
}
