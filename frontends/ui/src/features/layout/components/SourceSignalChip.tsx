/**
 * SourceSignalChip — the provenance signal chip (spec §4).
 *
 * Renders icon + label + color TOGETHER (color is never the only carrier —
 * a11y rule from the click-dummy spec §1). Colors come exclusively from the
 * `--source-*` token family (law / project / office / auto, plus lane-level
 * accents like `oib`), with safe
 * semantic fallbacks so the chip degrades to a muted chip if a token is
 * missing. No hex anywhere.
 */

'use client'

import { forwardRef, type ButtonHTMLAttributes, type CSSProperties, type ReactNode } from 'react'
import { Archive, FileText, Globe, Ruler, Scale } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { SourceSignal, SourceTint } from '../lib/source-presets'

/** Icon per signal — always shown next to the label. */
const SIGNAL_ICON: Record<SourceSignal, typeof Globe> = {
  law: Scale,
  project: FileText,
  office: Archive,
  auto: Globe,
  // A ruler, not a document glyph: nothing was read, something was measured.
  model: Ruler,
}

/**
 * Icon for a tint. Accents share their stratum's glyph on purpose: colour
 * separates OIB from RIS, the icon still says "this is Baurecht", so the two
 * read as siblings rather than as unrelated source types.
 */
export const iconForTint = (tint: SourceTint): typeof Globe =>
  tint === 'oib' ? SIGNAL_ICON.law : SIGNAL_ICON[tint]

/**
 * Tinted style from the --source-* token family (semantic fallbacks only).
 * Takes a `SourceTint`, so a caller that knows the fine lane can pass an accent
 * (`oib`) and a caller that only knows the stratum can pass the plain signal.
 */
export const sourceSignalStyle = (signal: SourceTint): CSSProperties => ({
  backgroundColor: `var(--source-${signal}-tint, var(--muted))`,
  color: `var(--source-${signal}-text, var(--muted-foreground))`,
  borderColor: `color-mix(in oklch, var(--source-${signal}, var(--foreground)) 25%, transparent)`,
})

const chipClasses =
  'inline-flex h-6 max-w-full shrink-0 items-center gap-1 truncate whitespace-nowrap rounded-full ' +
  'border px-2.5 text-xs font-medium transition-[color,background-color,box-shadow,filter] duration-snap ease-out ' +
  'motion-reduce:transition-none ' +
  '[&>svg]:size-3 [&>svg]:shrink-0 ' +
  'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50'

/**
 * The touch floor, added ONLY where the chip is something you press.
 *
 * Two of the three renderings below are real targets — the link opens a law in a
 * new tab, the toggle switches a retrieval scope — and both sat at the static
 * chip's 24px, which is where a label belongs and not where a control does.
 *
 * Kept out of {@link chipClasses} on purpose. That base is shared with the span
 * rendering, which is a LABEL: it names the provenance inside a peek card and a
 * detail panel, and growing every one of those to 44px on a phone would inflate
 * a dense metadata block to say nothing new. A target earns the floor by being a
 * target, not by looking like its neighbour.
 */
const chipTouchClasses = 'pointer-coarse:h-11 pointer-coarse:px-3.5'

interface SourceSignalChipSpanProps {
  signal: SourceTint
  children: ReactNode
  className?: string
  title?: string
}

/** Static provenance chip (span). */
export const SourceSignalChip = ({ signal, children, className, title }: SourceSignalChipSpanProps) => {
  const Icon = iconForTint(signal)
  return (
    <span className={cn(chipClasses, className)} style={sourceSignalStyle(signal)} title={title}>
      <Icon aria-hidden="true" />
      <span className="truncate">{children}</span>
    </span>
  )
}

/** Provenance chip as a link (used for web/RIS citations). */
interface SourceSignalChipLinkProps extends SourceSignalChipSpanProps {
  href: string
}

export const SourceSignalChipLink = ({
  signal,
  children,
  className,
  title,
  href,
}: SourceSignalChipLinkProps) => {
  const Icon = iconForTint(signal)
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className={cn(chipClasses, chipTouchClasses, 'hover:brightness-95 dark:hover:brightness-125', className)}
      style={sourceSignalStyle(signal)}
      title={title ?? href}
    >
      <Icon aria-hidden="true" />
      <span className="truncate">{children}</span>
    </a>
  )
}

/**
 * Toggleable provenance chip (button, aria-pressed) — the shortcut preset
 * chips. Inactive: quiet outline chip; active: tinted with its signal color.
 */
interface SourceSignalChipToggleProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  signal: SourceSignal
  active: boolean
}

export const SourceSignalChipToggle = forwardRef<HTMLButtonElement, SourceSignalChipToggleProps>(
  function SourceSignalChipToggle({ signal, active, className, children, ...props }, ref) {
    const Icon = SIGNAL_ICON[signal]
    // Both states carry the signal tint + colored icon (dummy shortcut row —
    // color is always present). Active adds the hairline border + raised
    // shadow; inactive is borderless and lifts only on hover.
    const { borderColor, ...tint } = sourceSignalStyle(signal)
    return (
      <button
        ref={ref}
        type="button"
        aria-pressed={active}
        className={cn(
          chipClasses,
          chipTouchClasses,
          'cursor-pointer',
          active ? 'shadow-xs' : 'border-transparent hover:shadow-xs',
          className
        )}
        style={active ? { ...tint, borderColor } : tint}
        {...props}
      >
        <Icon aria-hidden="true" />
        <span className="truncate">{children}</span>
      </button>
    )
  }
)
