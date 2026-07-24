/**
 * Skeleton thumbnails for the Files card grid — small stroke-based line
 * drawings, one per inferred {@link DocumentKind} (floor plan, section, site
 * plan, notice, photo, generic document). Plain inline SVG drawing with
 * `currentColor` so the ink follows the surrounding text token; the subtle
 * fills use opacity, never a literal color. Purely decorative (`aria-hidden`):
 * the owning card carries the accessible name (filename).
 *
 * Two presentations:
 *   - `variant="icon"` (default): a compact centred glyph, sized by the caller's
 *     `className` (used by the Archiv library cards).
 *   - `variant="fill"`: a full-bleed content-aware sketch that fills the card's
 *     thumbnail header, mirroring the click-dummy's Dateien cards.
 */

import type { JSX, ReactNode, SVGProps } from 'react'
import { ImageIcon, ImageOff } from 'lucide-react'
import type { DocumentKind } from '../document-kind'
import { cn } from '@/lib/utils'

/**
 * Office-gold source tint for the image placeholder's format chip. Mirrors
 * `TINTS.office` in `../document-kind` (photos map to the office family) so the
 * colour never travels without an icon + label — never a lone glyph.
 */
const OFFICE_TINT = {
  background: 'var(--source-office-tint, var(--background-color-feedback-warning-subtle))',
  color: 'var(--source-office-text, var(--text-color-feedback-warning))',
} as const

type SvgProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'children'>

/* --------------------------------------------------------------------------
 * Compact icon glyphs (Archiv library cards) — unchanged.
 * ------------------------------------------------------------------------ */

function Frame({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 120 80"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      focusable={false}
      {...props}
    >
      {children}
    </svg>
  )
}

/** Floor plan: outer walls, interior partitions, a door swing. */
function FloorPlanSketch(props: SvgProps) {
  return (
    <Frame {...props}>
      <rect x={22} y={12} width={76} height={56} rx={1} />
      <path d="M60 12v26M22 38h20M60 38h38" />
      <path d="M48 38h12" strokeOpacity={0.35} strokeDasharray="3 3" />
      {/* Door leaf + swing arc in the lower wall */}
      <path d="M74 68V56" />
      <path d="M74 56a12 12 0 0 1 12 12" strokeOpacity={0.55} />
      <rect x={28} y={56} width={10} height={6} strokeOpacity={0.45} />
    </Frame>
  )
}

/** Section: ground line, roof profile, floor slabs, hatch ticks. */
function SectionSketch(props: SvgProps) {
  return (
    <Frame {...props}>
      <path d="M10 64h100" />
      <path d="M32 64V36L60 18l28 18v28" />
      <path d="M32 50h56" strokeOpacity={0.55} />
      <path d="M32 36h56" strokeOpacity={0.35} />
      {/* Ground hatch */}
      <path d="M16 70l5-5M30 70l5-5M44 70l5-5M72 70l5-5M86 70l5-5M100 70l5-5" strokeOpacity={0.4} strokeWidth={1} />
    </Frame>
  )
}

/** Site plan: dashed plot boundary, building footprint, north arrow. */
function SitePlanSketch(props: SvgProps) {
  return (
    <Frame {...props}>
      <path d="M18 22l80-8 10 46-76 12z" strokeDasharray="5 4" strokeOpacity={0.7} />
      <rect x={46} y={32} width={26} height={18} />
      <path d="M46 41h26M59 32v18" strokeOpacity={0.35} />
      {/* North arrow */}
      <path d="M104 34V18" strokeOpacity={0.7} />
      <path d="M100 24l4-6 4 6" strokeOpacity={0.7} />
    </Frame>
  )
}

/** Generic text document: page with folded corner and text lines. */
function DocumentSketch(props: SvgProps) {
  return (
    <Frame {...props}>
      <path d="M38 10h32l14 14v46H38z" />
      <path d="M70 10v14h14" />
      <path d="M46 34h28M46 42h28M46 50h28M46 58h18" strokeOpacity={0.5} />
    </Frame>
  )
}

/** Official notice (Bescheid): page, heading block, round stamp, signature. */
function NoticeSketch(props: SvgProps) {
  return (
    <Frame {...props}>
      <path d="M38 10h32l14 14v46H38z" />
      <path d="M70 10v14h14" />
      <path d="M46 24h16M46 32h28M46 40h28" strokeOpacity={0.5} />
      <circle cx={72} cy={55} r={8} strokeOpacity={0.6} />
      <path d="M44 60c3-6 6 2 9-3s5 2 8-2" strokeOpacity={0.7} />
    </Frame>
  )
}

/** Photo: frame, sun, mountain ridge. */
function PhotoSketch(props: SvgProps) {
  return (
    <Frame {...props}>
      <rect x={26} y={16} width={68} height={48} rx={3} />
      <circle cx={44} cy={31} r={5} strokeOpacity={0.65} />
      <path d="M30 58l18-18 10 10 12-14 20 22" />
    </Frame>
  )
}

const SKETCHES: Record<DocumentKind, (props: SvgProps) => JSX.Element> = {
  floorplan: FloorPlanSketch,
  section: SectionSketch,
  siteplan: SitePlanSketch,
  notice: NoticeSketch,
  photo: PhotoSketch,
  document: DocumentSketch,
}

/* --------------------------------------------------------------------------
 * Full-bleed sketches (Dateien cards) — fill the thumbnail header, matching
 * the click-dummy. Line drawings use a 200×96 viewBox with `currentColor`;
 * document/notice/photo lean on token-tinted fills (never a literal color).
 * ------------------------------------------------------------------------ */

/** Shared frame for the stroke-based fill sketches. */
function FillSvg({ children }: { children: ReactNode }) {
  return (
    <svg
      className="h-full w-full"
      viewBox="0 0 200 96"
      preserveAspectRatio="xMidYMid meet"
      fill="none"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  )
}

function FloorPlanFill() {
  return (
    <FillSvg>
      <rect x={2} y={2} width={196} height={92} strokeWidth={1.6} strokeOpacity={0.85} />
      <path
        d="M80 2v34M80 56v38M80 56h118M138 2v22M138 40v16M2 74h34M50 74h30"
        strokeWidth={1.6}
        strokeOpacity={0.85}
      />
      <path
        d="M80 36a20 20 0 0 1 20 20M138 24a16 16 0 0 1 16 16"
        strokeWidth={1.3}
        strokeOpacity={0.4}
        strokeDasharray="2.5 3"
      />
    </FillSvg>
  )
}

function SectionFill() {
  return (
    <FillSvg>
      <path d="M4 90h192" strokeWidth={1.6} strokeOpacity={0.85} />
      <path d="M48 90V44L100 14l52 30v46" strokeWidth={1.6} strokeOpacity={0.85} />
      <path d="M48 68h104M48 44h104" strokeWidth={1.6} strokeOpacity={0.85} />
      <path d="M22 44h14M166 44h14" strokeWidth={1.3} strokeOpacity={0.4} strokeDasharray="2.5 3" />
    </FillSvg>
  )
}

function SitePlanFill() {
  return (
    <FillSvg>
      <rect x={4} y={4} width={192} height={88} strokeWidth={1.3} strokeOpacity={0.4} strokeDasharray="5 4" />
      <rect
        x={52}
        y={24}
        width={66}
        height={46}
        fill="currentColor"
        fillOpacity={0.07}
        strokeWidth={1.6}
        strokeOpacity={0.85}
      />
      <path d="M156 66V34M151 39l5-5 5 5" strokeWidth={1.5} strokeOpacity={0.4} />
    </FillSvg>
  )
}

/** Generic document: heading line + paragraph skeleton bars. */
function DocumentFill() {
  return (
    <div className="absolute inset-0 flex flex-col gap-[6px] px-[18px] py-[15px]">
      <div className="h-[6px] w-[52%] rounded-sm bg-current opacity-40" />
      <div className="mb-[5px] h-[4px] w-[30%] rounded-sm bg-current opacity-20" />
      {[100, 94, 97, 88, 96, 62].map((w, i) => (
        <div key={i} className="h-[4px] rounded-sm bg-current opacity-20" style={{ width: `${w}%` }} />
      ))}
    </div>
  )
}

/** Official notice: letterhead + reference dot, paragraph bars, round stamp. */
function NoticeFill() {
  return (
    <div className="absolute inset-0 flex flex-col gap-[6px] px-[18px] py-[15px]">
      <div className="mb-[6px] flex items-start justify-between">
        <div className="flex flex-col gap-[4px]">
          <div className="h-[5px] w-16 rounded-sm bg-current opacity-40" />
          <div className="h-[4px] w-10 rounded-sm bg-current opacity-20" />
        </div>
        <div className="size-[18px] shrink-0 rounded-full border-[1.5px] border-current opacity-40" />
      </div>
      {[100, 92, 96, 70, 88, 54].map((w, i) => (
        <div key={i} className="h-[4px] rounded-sm bg-current opacity-20" style={{ width: `${w}%` }} />
      ))}
      <div className="absolute bottom-3 right-4 flex size-10 -rotate-12 items-center justify-center rounded-full border-[1.5px] border-current opacity-30">
        <div className="h-[3px] w-5 rounded-sm bg-current" />
      </div>
    </div>
  )
}

const FILLS: Record<DocumentKind, () => JSX.Element> = {
  floorplan: FloorPlanFill,
  section: SectionFill,
  siteplan: SitePlanFill,
  notice: NoticeFill,
  // Photos are handled specially in the fill branch (warm image placeholder
  // with a format chip); this entry keeps the record type-complete but is never
  // reached for `variant="fill"`.
  photo: DocumentFill,
  document: DocumentFill,
}

/** Line sketches sit in a padded box; document/notice/photo fill edge-to-edge. */
const FILL_PADDED: Record<DocumentKind, boolean> = {
  floorplan: true,
  section: true,
  siteplan: true,
  notice: false,
  photo: false,
  document: false,
}

export function DocumentKindThumbnail({
  kind,
  className,
  variant = 'icon',
  formatLabel,
  failed = false,
  failedLabel,
}: {
  kind: DocumentKind
  className?: string
  variant?: 'icon' | 'fill'
  /** Format/kind chip on the image placeholder (e.g. "PNG" / "Bild"). */
  formatLabel?: string
  /** A GENUINE load failure — a distinct, honest treatment (never a broken-image look). */
  failed?: boolean
  /** Label for the genuine-failure treatment (e.g. "Vorschau nicht verfügbar"). */
  failedLabel?: string
}) {
  if (variant === 'fill') {
    // Genuine load failure: a distinct, muted "couldn't load" tile — never red,
    // and clearly different from the "no thumbnail available" placeholders below.
    if (failed) {
      return (
        <div
          aria-hidden
          data-kind={kind}
          data-testid="document-kind-thumbnail"
          data-state="failed"
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-2 bg-muted text-muted-foreground/70',
            className
          )}
        >
          <ImageOff className="size-6 opacity-50" aria-hidden />
          {failedLabel && (
            <span className="px-3 text-center text-[10.5px] font-medium leading-tight">{failedLabel}</span>
          )}
        </div>
      )
    }

    // An image with no thumbnail: a WARM, intentional placeholder — soft paper
    // wash + image glyph + a format chip (icon travels WITH a label, office-gold
    // family) — never a lone glyph that reads as a browser broken-image icon.
    if (kind === 'photo') {
      return (
        <div
          aria-hidden
          data-kind={kind}
          data-testid="document-kind-thumbnail"
          data-state="placeholder"
          className={cn(
            'absolute inset-0 flex flex-col items-center justify-center gap-2.5 bg-gradient-to-br from-muted/40 via-muted/60 to-muted text-muted-foreground',
            className
          )}
        >
          <ImageIcon className="size-[26px] opacity-45" aria-hidden />
          {formatLabel && (
            <span
              className="inline-flex items-center rounded-[6px] px-2 py-[3px] text-[10px] font-bold uppercase leading-none tracking-[0.04em]"
              style={OFFICE_TINT}
            >
              {formatLabel}
            </span>
          )}
        </div>
      )
    }

    const Fill = FILLS[kind] ?? DocumentFill
    return (
      <div
        aria-hidden
        data-kind={kind}
        data-testid="document-kind-thumbnail"
        data-state="placeholder"
        className={cn(
          'absolute inset-0 text-muted-foreground',
          FILL_PADDED[kind] && 'px-[18px] py-[14px]',
          className
        )}
      >
        <Fill />
      </div>
    )
  }

  const Sketch = SKETCHES[kind] ?? DocumentSketch
  return <Sketch className={className} data-kind={kind} data-testid="document-kind-thumbnail" />
}
