'use client'

/**
 * shadcn Sidebar (New York), adapted to GRID:
 * collapse persists in localStorage (`grid.sidebar.collapsed`; true → open=false),
 * no cookie, no cmd+b (this app uses `g …` leader shortcuts).
 */

import * as React from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { PanelLeft } from 'lucide-react'

import { useIsMobile } from '@/hooks/use-is-mobile'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { FOCUS_RING } from '@/components/ui/focus-ring'
import { Input } from '@/components/ui/input'
import { Separator } from '@/components/ui/separator'
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet'
import { Skeleton } from '@/components/ui/skeleton'
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip'

const SIDEBAR_STORAGE_KEY = 'grid.sidebar.collapsed'
const SIDEBAR_WIDTH_STORAGE_KEY = 'grid.sidebar.width'

/**
 * Rail geometry, in px — NUMBERS, not the `'236px'` strings this used to hold,
 * because the width is now a value the reader drags: it has to survive
 * arithmetic (a pointer delta, a keyboard step, a clamp) before it is published
 * as `--sidebar-width`.
 *
 * The bounds are the rail's own content, not a taste: below ~200px the project
 * switcher and the longest nav labels start truncating on their own, and above
 * ~420px the rail is taking width from the thing it navigates to.
 */
const SIDEBAR_WIDTH = 236
const SIDEBAR_WIDTH_MIN = 200
const SIDEBAR_WIDTH_MAX = 420
const SIDEBAR_WIDTH_ICON = 64
/** Dragged narrower than this, the gesture has stopped resizing and is collapsing. */
const SIDEBAR_COLLAPSE_AT = 160
/** Pointer travel under which a press on the rail was a click, not a drag. */
const SIDEBAR_DRAG_SLOP = 4
/** Arrow-key step; Shift takes the coarse one. */
const SIDEBAR_KEY_STEP = 16
const SIDEBAR_KEY_STEP_COARSE = 64

function clampWidth(value: number): number {
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, Math.round(value)))
}

type SidebarStyle = React.CSSProperties & {
  '--sidebar-width'?: string
  '--sidebar-width-icon'?: string
  '--skeleton-width'?: string
}

type SidebarContextValue = {
  state: 'expanded' | 'collapsed'
  open: boolean
  setOpen: (open: boolean | ((value: boolean) => boolean)) => void
  openMobile: boolean
  setOpenMobile: React.Dispatch<React.SetStateAction<boolean>>
  isMobile: boolean
  toggleSidebar: () => void
  /** Current expanded width in px (the collapsed rail is `--sidebar-width-icon`). */
  width: number
  /**
   * Set the expanded width, clamped to the bounds. Deliberately does NOT
   * persist: this runs once per `pointermove` for the length of a drag, and a
   * synchronous `localStorage` write per frame is main-thread work the reader
   * only needs done once — at the end. {@link SidebarRail} commits there.
   */
  setWidth: (width: number) => void
}

const SidebarContext = React.createContext<SidebarContextValue | null>(null)

function useSidebar(): SidebarContextValue {
  const context = React.useContext(SidebarContext)
  if (!context) {
    throw new Error('useSidebar must be used within a SidebarProvider.')
  }
  return context
}

function persistCollapsed(open: boolean): void {
  try {
    window.localStorage.setItem(SIDEBAR_STORAGE_KEY, String(!open))
  } catch {
    // Storage unavailable (privacy mode) — fail soft.
  }
}

function persistWidth(width: number): void {
  try {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, String(width))
  } catch {
    // Storage unavailable (privacy mode) — fail soft; the rail keeps the width
    // for this session and comes back at the default in the next one.
  }
}

/** The stored width, or null when there is none / it is not a usable number. */
function readStoredWidth(): number | null {
  try {
    const stored = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)
    // The empty string is checked BEFORE `Number`, which reads it as 0 — a
    // cleared key would otherwise come back as the minimum width rather than as
    // "no stored width", and the rail would open narrow for no stated reason.
    if (stored === null || stored.trim() === '') return null
    const parsed = Number(stored)
    // A hand-edited or half-written value must not be able to publish
    // `--sidebar-width: NaNpx`, which resolves to nothing and leaves the gap
    // and the rail disagreeing about where the page begins.
    return Number.isFinite(parsed) ? clampWidth(parsed) : null
  } catch {
    return null
  }
}

function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  defaultOpen?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
}): React.JSX.Element {
  const isMobile = useIsMobile()
  const [openMobile, setOpenMobile] = React.useState(false)
  const [_open, _setOpen] = React.useState(defaultOpen)
  const open = openProp ?? _open
  const [width, _setWidth] = React.useState(SIDEBAR_WIDTH)

  // Restore after mount so SSR markup matches the first client render.
  React.useEffect(() => {
    if (openProp !== undefined) return
    try {
      const stored = window.localStorage.getItem(SIDEBAR_STORAGE_KEY)
      if (stored === null) return
      _setOpen(stored !== 'true')
    } catch {
      // Storage unavailable — keep defaultOpen.
    }
  }, [openProp])

  // Its own effect, not a second read inside the one above: that one returns
  // early for a CONTROLLED `open`, and a caller driving the collapse itself has
  // said nothing about the width the reader dragged.
  React.useEffect(() => {
    const stored = readStoredWidth()
    if (stored !== null) _setWidth(stored)
  }, [])

  const setWidth = React.useCallback((value: number) => {
    _setWidth(clampWidth(value))
  }, [])

  const setOpen = React.useCallback(
    (value: boolean | ((value: boolean) => boolean)) => {
      const openState = typeof value === 'function' ? value(open) : value
      if (setOpenProp) {
        setOpenProp(openState)
      } else {
        _setOpen(openState)
      }
      persistCollapsed(openState)
    },
    [setOpenProp, open],
  )

  const toggleSidebar = React.useCallback(() => {
    return isMobile ? setOpenMobile((current) => !current) : setOpen((current) => !current)
  }, [isMobile, setOpen])

  const state = open ? 'expanded' : 'collapsed'

  const contextValue = React.useMemo<SidebarContextValue>(
    () => ({
      state,
      open,
      setOpen,
      isMobile,
      openMobile,
      setOpenMobile,
      toggleSidebar,
      width,
      setWidth,
    }),
    [state, open, setOpen, isMobile, openMobile, toggleSidebar, width, setWidth],
  )

  // `--sidebar-current-width` used to be published here, and on `:root` as
  // well, because the docked chat panels were `position: fixed` against the
  // VIEWPORT and so had to be told where the rail ended. They are now
  // `absolute` inside the shell's `relative` <main>, which begins at that
  // edge — so the offset is structural and the variable had no readers left.
  // A width published as a global custom property is also a width that can be
  // wrong: two mounted providers raced over it, and the unmounting one deleted
  // it out from under the other.
  const wrapperStyle: SidebarStyle = {
    '--sidebar-width': `${width}px`,
    '--sidebar-width-icon': `${SIDEBAR_WIDTH_ICON}px`,
    ...style,
  }

  return (
    <SidebarContext.Provider value={contextValue}>
      <TooltipProvider delayDuration={0}>
        <div
          data-slot="sidebar-wrapper"
          style={wrapperStyle}
          className={cn('group/sidebar-wrapper flex min-h-0 w-full has-data-[variant=inset]:bg-sidebar', className)}
          {...props}
        >
          {children}
        </div>
      </TooltipProvider>
    </SidebarContext.Provider>
  )
}

function Sidebar({
  side = 'left',
  variant = 'sidebar',
  collapsible = 'offcanvas',
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  side?: 'left' | 'right'
  variant?: 'sidebar' | 'floating' | 'inset'
  collapsible?: 'offcanvas' | 'icon' | 'none'
}): React.JSX.Element {
  const { isMobile, state, openMobile, setOpenMobile } = useSidebar()

  if (collapsible === 'none') {
    return (
      <div
        data-slot="sidebar"
        className={cn('flex h-full w-(--sidebar-width) flex-col bg-sidebar text-sidebar-foreground', className)}
        {...props}
      >
        {children}
      </div>
    )
  }

  if (isMobile) {
    return (
      <Sheet open={openMobile} onOpenChange={setOpenMobile}>
        <SheetContent
          data-sidebar="sidebar"
          data-slot="sidebar"
          data-mobile="true"
          className={cn(
            'w-72 bg-sidebar p-0 text-sidebar-foreground [&>button]:hidden sm:max-w-72',
            className,
          )}
          side={side}
        >
          <SheetHeader className="sr-only">
            <SheetTitle>Sidebar</SheetTitle>
            <SheetDescription>Displays the mobile sidebar.</SheetDescription>
          </SheetHeader>
          <div className="flex h-full w-full flex-col">{children}</div>
        </SheetContent>
      </Sheet>
    )
  }

  return (
    <div
      className="group peer hidden text-sidebar-foreground md:block"
      data-state={state}
      data-collapsible={state === 'collapsed' ? collapsible : ''}
      data-variant={variant}
      data-side={side}
      data-slot="sidebar"
    >
      {/* Desktop gap: reserves layout width for the `fixed` rail beside it.
          NO TRANSITION, on purpose. This is the design language's binding
          constraint made concrete — "a panel that changes size sets its size in
          one pass and TRANSLATES its content" — and here it was also the app's
          single most expensive animation: an in-flow element animating `width`
          for 200ms re-runs layout for the whole page beside it, every frame, on
          a change the reader made once.

          It was never even coherent. The rail's CONTENTS swap on the same tick
          (`iconRail` is React state: labels unmount, the brand mark swaps, tiles
          restyle), so the old transition animated an empty box shrinking around
          content that had already changed. Setting both the gap and the
          container in one pass makes the collapse a single honest layout step
          that agrees with itself. */}
      <div
        data-slot="sidebar-gap"
        className={cn(
          'relative w-(--sidebar-width) bg-transparent',
          'group-data-[collapsible=offcanvas]:w-0',
          'group-data-[side=right]:rotate-180',
          variant === 'floating' || variant === 'inset'
            ? 'group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4)))]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon)',
        )}
      />
      <div
        data-slot="sidebar-container"
        className={cn(
          // `h-dvh`, not `h-svh`: the app shell this rail sits in is `h-dvh`
          // (`app/projects/[id]/layout.tsx`), and this element is `fixed` with
          // `inset-y-0` — over-constrained, so height wins and `bottom` is
          // dropped. Wherever `svh > dvh` (any browser with a retracting URL
          // bar) the mismatch pushed the rail's last rows, footer included,
          // below the visible area.
          // TRANSFORM ONLY. `left`/`right` were being animated to slide the
          // offcanvas rail off the edge — a layout property doing a
          // compositor's job — so the slide is now a `translate` of the same
          // distance (100% of the rail's own width IS `--sidebar-width`), which
          // the browser can run off the main thread. `width` is deliberately
          // NOT in the transition list: see the gap above.
          // Both legs get their own curve: `data-collapsible` is only present
          // while collapsed, so the rail leaves on `ease-exit` and returns on
          // `ease-entrance` — a departure accelerates away, an arrival decides
          // early and settles.
          'fixed inset-y-0 z-10 hidden h-dvh w-(--sidebar-width) transition-transform duration-deliberate ease-entrance group-data-[collapsible=offcanvas]:ease-exit motion-reduce:transition-none md:flex',
          side === 'left'
            ? 'left-0 group-data-[collapsible=offcanvas]:-translate-x-full'
            : 'right-0 group-data-[collapsible=offcanvas]:translate-x-full',
          variant === 'floating' || variant === 'inset'
            ? 'p-2 group-data-[collapsible=icon]:w-[calc(var(--sidebar-width-icon)+(--spacing(4))+2px)]'
            : 'group-data-[collapsible=icon]:w-(--sidebar-width-icon) group-data-[side=left]:border-r group-data-[side=right]:border-l',
          className,
        )}
        {...props}
      >
        <div
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
          className="flex h-full w-full flex-col bg-sidebar group-data-[variant=floating]:rounded-lg group-data-[variant=floating]:border group-data-[variant=floating]:border-sidebar-border group-data-[variant=floating]:shadow-sm"
        >
          {children}
        </div>
      </div>
    </div>
  )
}

function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>): React.JSX.Element {
  const { toggleSidebar } = useSidebar()

  return (
    <Button
      data-sidebar="trigger"
      data-slot="sidebar-trigger"
      variant="ghost"
      size="icon"
      className={cn('size-7', className)}
      onClick={(event) => {
        onClick?.(event)
        toggleSidebar()
      }}
      {...props}
    >
      <PanelLeft />
      <span className="sr-only">Toggle Sidebar</span>
    </Button>
  )
}

/** A drag in progress. Lives in a ref: none of it belongs in a render. */
type RailDrag = {
  /** Pointer x where the press landed. */
  startX: number
  /** Rail width at that moment (the icon width when it started collapsed). */
  startWidth: number
  side: 'left' | 'right'
  /** Latest clamped width, so the commit does not have to re-read state. */
  width: number
  /** Whether the pointer travelled far enough that this is a drag, not a click. */
  moved: boolean
  /** Collapse state this drag last asked for — see `handleMove`. */
  collapsed: boolean
}

/**
 * Which edge the rail hangs off, read from the DOM rather than a prop.
 *
 * `side` is `Sidebar`'s prop and reaches the rail only as the `data-side`
 * attribute the CSS below already keys off — so the drag maths reads the same
 * source the cursor does, instead of a second copy that can disagree with it.
 */
function railSide(element: HTMLElement): 'left' | 'right' {
  return element.closest('[data-side]')?.getAttribute('data-side') === 'right' ? 'right' : 'left'
}

/**
 * The rail edge — the strip between the sidebar and the page.
 *
 * It has shown a `resize` cursor since the day it was vendored in, and it did
 * not resize anything: the only thing it could do was toggle between the full
 * rail and the icon column. That is the one failure mode a cursor has — the
 * reader tries the drag it was offered, the rail jumps to a width nobody asked
 * for, and the edge stops being trustworthy.
 *
 * So it drags. Pointer: drag to set the width (clamped to
 * `SIDEBAR_WIDTH_MIN…MAX`), keep going past `SIDEBAR_COLLAPSE_AT` to collapse to
 * the icon rail, drag back out to bring it round. A press that travels less than
 * `SIDEBAR_DRAG_SLOP` is still the old toggle, so the gesture people already
 * have keeps working.
 *
 * Keyboard: it is a real `role="separator"` window splitter and a tab stop —
 * arrows resize (Shift for the coarse step), Home/End go to the bounds, one more
 * shrink at the minimum collapses, and Enter/Space is the toggle (the button
 * element's own activation behaviour, which `role` does not take away).
 */
function SidebarRail({
  className,
  onClick,
  onPointerDown,
  onKeyDown,
  ...props
}: React.ComponentProps<'button'>): React.JSX.Element {
  const { toggleSidebar, setOpen, state, width, setWidth } = useSidebar()
  const [resizing, setResizing] = React.useState(false)
  const dragRef = React.useRef<RailDrag | null>(null)
  // A drag ends in a `click` the browser fires regardless; without this the rail
  // would collapse itself every time the reader finished resizing it.
  const suppressClickRef = React.useRef(false)

  // Window-level, not pointer capture: the pointer spends the drag out over the
  // page, and happy-dom/jsdom implement neither `setPointerCapture` nor the
  // retargeting that makes it work — this is the same listener set in both.
  React.useEffect(() => {
    if (!resizing) return

    const handleMove = (event: PointerEvent): void => {
      const drag = dragRef.current
      if (!drag) return
      const delta = drag.side === 'left' ? event.clientX - drag.startX : drag.startX - event.clientX
      if (Math.abs(delta) > SIDEBAR_DRAG_SLOP) drag.moved = true
      // Under the slop nothing has been asked for yet. A click that also nudges
      // the rail two pixels is a hand, not an instruction.
      if (!drag.moved) return

      const next = drag.startWidth + delta
      // Past the floor the gesture means "put it away", and the width it would
      // have had is kept — dragging back out returns to it, not to the default.
      // Only ever called on a CROSSING: `setOpen` writes to localStorage, and a
      // storage write per pointermove is the cost this file already refuses to
      // pay for the width.
      const collapsed = next < SIDEBAR_COLLAPSE_AT
      if (collapsed !== drag.collapsed) {
        drag.collapsed = collapsed
        setOpen(!collapsed)
      }
      if (collapsed) return
      drag.width = clampWidth(next)
      setWidth(drag.width)
    }

    const handleUp = (): void => {
      const drag = dragRef.current
      dragRef.current = null
      setResizing(false)
      if (!drag?.moved) return
      suppressClickRef.current = true
      persistWidth(drag.width)
    }

    window.addEventListener('pointermove', handleMove)
    window.addEventListener('pointerup', handleUp)
    window.addEventListener('pointercancel', handleUp)
    // The cursor and the selection belong to the page for the duration: the
    // pointer is over the transcript, not over the 16px strip that started
    // this, and a resize that selects the text it passes over reads as broken.
    const { cursor, userSelect } = document.body.style
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      window.removeEventListener('pointermove', handleMove)
      window.removeEventListener('pointerup', handleUp)
      window.removeEventListener('pointercancel', handleUp)
      document.body.style.cursor = cursor
      document.body.style.userSelect = userSelect
    }
  }, [resizing, setOpen, setWidth])

  const handlePointerDown = (event: React.PointerEvent<HTMLButtonElement>): void => {
    onPointerDown?.(event)
    if (event.button !== 0 || event.defaultPrevented) return
    const startWidth = state === 'collapsed' ? SIDEBAR_WIDTH_ICON : width
    dragRef.current = {
      startX: event.clientX,
      startWidth,
      side: railSide(event.currentTarget),
      width: state === 'collapsed' ? width : startWidth,
      moved: false,
      collapsed: state === 'collapsed',
    }
    setResizing(true)
  }

  const handleClick = (event: React.MouseEvent<HTMLButtonElement>): void => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false
      return
    }
    onClick?.(event)
    toggleSidebar()
  }

  const handleKeyDown = (event: React.KeyboardEvent<HTMLButtonElement>): void => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return

    const side = railSide(event.currentTarget)
    const grows = side === 'left' ? 'ArrowRight' : 'ArrowLeft'
    const shrinks = side === 'left' ? 'ArrowLeft' : 'ArrowRight'
    if (event.key !== grows && event.key !== shrinks && event.key !== 'Home' && event.key !== 'End') {
      return
    }
    // Arrows scroll the page and Home/End jump it; a focused splitter owns them.
    event.preventDefault()

    if (state === 'collapsed') {
      // From the icon rail the only move that means anything is "come back".
      if (event.key === grows || event.key === 'End') setOpen(true)
      return
    }
    if (event.key === shrinks && width <= SIDEBAR_WIDTH_MIN) {
      // Already at the floor: the next shrink is the collapse. The pointer
      // reaches it by overshooting; the keyboard has no overshoot, so it is the
      // second press at the bound.
      setOpen(false)
      return
    }

    const step = event.shiftKey ? SIDEBAR_KEY_STEP_COARSE : SIDEBAR_KEY_STEP
    const next =
      event.key === 'Home'
        ? SIDEBAR_WIDTH_MIN
        : event.key === 'End'
          ? SIDEBAR_WIDTH_MAX
          : clampWidth(width + (event.key === grows ? step : -step))
    setWidth(next)
    persistWidth(next)
  }

  return (
    <button
      type="button"
      data-sidebar="rail"
      data-slot="sidebar-rail"
      data-resizing={resizing || undefined}
      // A window splitter, which is what it now is: a focusable separator that
      // reports the width it controls. `role` does not remove a <button>'s
      // activation behaviour, so Enter/Space still reach `onClick` — the toggle.
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize sidebar"
      aria-valuenow={state === 'collapsed' ? SIDEBAR_WIDTH_ICON : width}
      aria-valuemin={SIDEBAR_WIDTH_ICON}
      aria-valuemax={SIDEBAR_WIDTH_MAX}
      onPointerDown={handlePointerDown}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      // The tooltip names the two things the edge does, and which way round they
      // are depends on where the rail is: from the icon column there is no width
      // to change yet, only a rail to bring back.
      title={state === 'collapsed' ? 'Drag or click to expand the sidebar' : 'Drag to resize, click to collapse'}
      className={cn(
        // Was `transition-all ease-linear` — the app's only `transition-all`,
        // and it promised to animate every property this element might ever
        // grow. The only thing it actually moves is its own `translate-x`
        // between the collapsible modes, so that is what it names.
        'absolute inset-y-0 z-20 hidden w-4 -translate-x-1/2 transition-transform duration-quick ease-out motion-reduce:transition-none group-data-[side=left]:-right-4 group-data-[side=right]:left-0 after:absolute after:inset-y-0 after:left-1/2 after:w-[2px] hover:after:bg-sidebar-border sm:flex',
        // `col-resize` while there is a width to change, and the one-way arrow
        // while collapsed, where the only move left is "come back".
        'cursor-col-resize touch-none',
        '[[data-side=left][data-state=collapsed]_&]:cursor-e-resize [[data-side=right][data-state=collapsed]_&]:cursor-w-resize',
        // Lit for the whole drag, not just while the pointer is over the strip
        // it left behind two hundred pixels ago.
        'data-[resizing]:after:bg-sidebar-border',
        FOCUS_RING,
        'group-data-[collapsible=offcanvas]:translate-x-0 group-data-[collapsible=offcanvas]:after:left-full hover:group-data-[collapsible=offcanvas]:bg-sidebar',
        '[[data-side=left][data-collapsible=offcanvas]_&]:-right-2',
        '[[data-side=right][data-collapsible=offcanvas]_&]:-left-2',
        className,
      )}
      {...props}
    />
  )
}

function SidebarInset({ className, ...props }: React.ComponentProps<'main'>): React.JSX.Element {
  return (
    <main
      data-slot="sidebar-inset"
      className={cn(
        'relative flex w-full flex-1 flex-col bg-background',
        'md:peer-data-[variant=inset]:m-2 md:peer-data-[variant=inset]:ml-0 md:peer-data-[variant=inset]:rounded-xl md:peer-data-[variant=inset]:shadow-sm md:peer-data-[variant=inset]:peer-data-[state=collapsed]:ml-2',
        className,
      )}
      {...props}
    />
  )
}

function SidebarInput({ className, ...props }: React.ComponentProps<typeof Input>): React.JSX.Element {
  return (
    <Input
      data-slot="sidebar-input"
      data-sidebar="input"
      className={cn('h-8 w-full bg-background shadow-none focus-visible:ring-2 focus-visible:ring-sidebar-ring', className)}
      {...props}
    />
  )
}

function SidebarHeader({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div data-slot="sidebar-header" data-sidebar="header" className={cn('flex flex-col gap-2 p-2', className)} {...props} />
  )
}

function SidebarFooter({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div data-slot="sidebar-footer" data-sidebar="footer" className={cn('flex flex-col gap-2 p-2', className)} {...props} />
  )
}

function SidebarSeparator({ className, ...props }: React.ComponentProps<typeof Separator>): React.JSX.Element {
  return (
    <Separator
      data-slot="sidebar-separator"
      data-sidebar="separator"
      className={cn('mx-2 w-auto bg-sidebar-border', className)}
      {...props}
    />
  )
}

function SidebarContent({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="sidebar-content"
      data-sidebar="content"
      className={cn(
        'flex min-h-0 flex-1 flex-col gap-2 overflow-auto group-data-[collapsible=icon]:overflow-hidden',
        className,
      )}
      {...props}
    />
  )
}

function SidebarGroup({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="sidebar-group"
      data-sidebar="group"
      className={cn('relative flex w-full min-w-0 flex-col p-2', className)}
      {...props}
    />
  )
}

function SidebarGroupLabel({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'div'> & { asChild?: boolean }): React.JSX.Element {
  const Comp = asChild ? Slot : 'div'

  return (
    <Comp
      data-slot="sidebar-group-label"
      data-sidebar="group-label"
      className={cn(
        // Opacity fades, the margin does NOT. The collapsed state pulls this
        // label out of flow with `-mt-8`, and animating a margin is animating
        // layout — the label used to drag every row below it up over 200ms.
        // Same split as the rail: the size change lands in one pass, and only
        // the compositable half is timed.
        'flex h-8 shrink-0 items-center rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 outline-none ring-sidebar-ring transition-opacity duration-quick ease-out motion-reduce:transition-none focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        'group-data-[collapsible=icon]:-mt-8 group-data-[collapsible=icon]:opacity-0',
        className,
      )}
      {...props}
    />
  )
}

function SidebarGroupAction({
  className,
  asChild = false,
  ...props
}: React.ComponentProps<'button'> & { asChild?: boolean }): React.JSX.Element {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="sidebar-group-action"
      data-sidebar="group-action"
      className={cn(
        'absolute top-3.5 right-3 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-none ring-sidebar-ring transition-transform hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        'after:absolute after:-inset-2 md:after:hidden',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}

function SidebarGroupContent({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="sidebar-group-content"
      data-sidebar="group-content"
      className={cn('w-full text-sm', className)}
      {...props}
    />
  )
}

function SidebarMenu({ className, ...props }: React.ComponentProps<'ul'>): React.JSX.Element {
  return (
    <ul
      data-slot="sidebar-menu"
      data-sidebar="menu"
      className={cn('flex w-full min-w-0 flex-col gap-1', className)}
      {...props}
    />
  )
}

function SidebarMenuItem({ className, ...props }: React.ComponentProps<'li'>): React.JSX.Element {
  return (
    <li
      data-slot="sidebar-menu-item"
      data-sidebar="menu-item"
      className={cn('group/menu-item relative', className)}
      {...props}
    />
  )
}

const sidebarMenuButtonVariants = cva(
  // `transition-[width,height,padding]` here was the same layout animation as
  // the rail's, multiplied by every row in the nav — and it was the ONLY
  // transition on this control, so the one thing a nav row should ease (its
  // hover fill) was snapping while its geometry was easing. Both are now the
  // right way round: the tile resizes in one pass with the rail, and `colors`
  // carries the hover.
  'peer/menu-button flex w-full items-center gap-2 overflow-hidden rounded-md p-2 text-left text-sm outline-none ring-sidebar-ring transition-colors duration-quick ease-out group-has-data-[sidebar=menu-action]/menu-item:pr-8 group-data-[collapsible=icon]:size-8! group-data-[collapsible=icon]:p-2! hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[state=open]:hover:bg-sidebar-accent data-[state=open]:hover:text-sidebar-accent-foreground [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'hover:bg-sidebar-accent hover:text-sidebar-accent-foreground',
        outline:
          'bg-background shadow-[0_0_0_1px_var(--color-sidebar-border)] hover:bg-sidebar-accent hover:text-sidebar-accent-foreground hover:shadow-[0_0_0_1px_var(--color-sidebar-accent)]',
      },
      size: {
        default: 'h-8 text-sm',
        sm: 'h-7 text-xs',
        lg: 'h-12 text-sm group-data-[collapsible=icon]:p-0!',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

function SidebarMenuButton({
  asChild = false,
  isActive = false,
  variant = 'default',
  size = 'default',
  tooltip,
  className,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  isActive?: boolean
  tooltip?: string | React.ComponentProps<typeof TooltipContent>
} & VariantProps<typeof sidebarMenuButtonVariants>): React.JSX.Element {
  const Comp = asChild ? Slot : 'button'
  const { isMobile, state } = useSidebar()

  const button = (
    <Comp
      data-slot="sidebar-menu-button"
      data-sidebar="menu-button"
      data-size={size}
      data-active={isActive}
      className={cn(sidebarMenuButtonVariants({ variant, size }), className)}
      {...props}
    />
  )

  if (!tooltip) {
    return button
  }

  const tooltipProps = typeof tooltip === 'string' ? { children: tooltip } : tooltip

  return (
    <Tooltip>
      <TooltipTrigger asChild>{button}</TooltipTrigger>
      <TooltipContent side="right" align="center" hidden={state !== 'collapsed' || isMobile} {...tooltipProps} />
    </Tooltip>
  )
}

function SidebarMenuAction({
  className,
  asChild = false,
  showOnHover = false,
  ...props
}: React.ComponentProps<'button'> & {
  asChild?: boolean
  showOnHover?: boolean
}): React.JSX.Element {
  const Comp = asChild ? Slot : 'button'

  return (
    <Comp
      data-slot="sidebar-menu-action"
      data-sidebar="menu-action"
      className={cn(
        'absolute top-1.5 right-1 flex aspect-square w-5 items-center justify-center rounded-md p-0 text-sidebar-foreground outline-none ring-sidebar-ring transition-transform peer-hover/menu-button:text-sidebar-accent-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 [&>svg]:size-4 [&>svg]:shrink-0',
        'after:absolute after:-inset-2 md:after:hidden',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        showOnHover &&
          'group-focus-within/menu-item:opacity-100 group-hover/menu-item:opacity-100 peer-data-[active=true]/menu-button:text-sidebar-accent-foreground data-[state=open]:opacity-100 md:opacity-0',
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenuBadge({ className, ...props }: React.ComponentProps<'div'>): React.JSX.Element {
  return (
    <div
      data-slot="sidebar-menu-badge"
      data-sidebar="menu-badge"
      className={cn(
        'pointer-events-none absolute right-1 flex h-5 min-w-5 items-center justify-center rounded-md px-1 text-xs font-medium text-sidebar-foreground tabular-nums select-none',
        'peer-hover/menu-button:text-sidebar-accent-foreground peer-data-[active=true]/menu-button:text-sidebar-accent-foreground',
        'peer-data-[size=sm]/menu-button:top-1',
        'peer-data-[size=default]/menu-button:top-1.5',
        'peer-data-[size=lg]/menu-button:top-2.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenuSkeleton({
  className,
  showIcon = false,
  ...props
}: React.ComponentProps<'div'> & {
  showIcon?: boolean
}): React.JSX.Element {
  const width = React.useMemo(() => `${Math.floor(Math.random() * 40) + 50}%`, [])
  const skeletonStyle: SidebarStyle = { '--skeleton-width': width }

  return (
    <div
      data-slot="sidebar-menu-skeleton"
      data-sidebar="menu-skeleton"
      className={cn('flex h-8 items-center gap-2 rounded-md px-2', className)}
      {...props}
    >
      {showIcon && <Skeleton className="size-4 rounded-md" data-sidebar="menu-skeleton-icon" />}
      <Skeleton
        className="h-4 max-w-(--skeleton-width) flex-1"
        data-sidebar="menu-skeleton-text"
        style={skeletonStyle}
      />
    </div>
  )
}

function SidebarMenuSub({ className, ...props }: React.ComponentProps<'ul'>): React.JSX.Element {
  return (
    <ul
      data-slot="sidebar-menu-sub"
      data-sidebar="menu-sub"
      className={cn(
        'mx-3.5 flex min-w-0 translate-x-px flex-col gap-1 border-l border-sidebar-border px-2.5 py-0.5',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}

function SidebarMenuSubItem({ className, ...props }: React.ComponentProps<'li'>): React.JSX.Element {
  return (
    <li
      data-slot="sidebar-menu-sub-item"
      data-sidebar="menu-sub-item"
      className={cn('group/menu-sub-item relative', className)}
      {...props}
    />
  )
}

function SidebarMenuSubButton({
  asChild = false,
  size = 'md',
  isActive = false,
  className,
  ...props
}: React.ComponentProps<'a'> & {
  asChild?: boolean
  size?: 'sm' | 'md'
  isActive?: boolean
}): React.JSX.Element {
  const Comp = asChild ? Slot : 'a'

  return (
    <Comp
      data-slot="sidebar-menu-sub-button"
      data-sidebar="menu-sub-button"
      data-size={size}
      data-active={isActive}
      className={cn(
        'flex h-7 min-w-0 -translate-x-px items-center gap-2 overflow-hidden rounded-md px-2 text-sidebar-foreground outline-none ring-sidebar-ring hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:ring-2 active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&>span:last-child]:truncate [&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-sidebar-accent-foreground',
        'data-[active=true]:bg-sidebar-accent data-[active=true]:text-sidebar-accent-foreground',
        size === 'sm' && 'text-xs',
        size === 'md' && 'text-sm',
        'group-data-[collapsible=icon]:hidden',
        className,
      )}
      {...props}
    />
  )
}

export {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupAction,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInput,
  SidebarInset,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSkeleton,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
  SidebarProvider,
  SidebarRail,
  SidebarSeparator,
  SidebarTrigger,
  useSidebar,
}
