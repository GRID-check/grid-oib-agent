/**
 * Skeleton thumbnails for the Files card grid — small stroke-based line
 * drawings, one per inferred {@link DocumentKind} (floor plan, section, site
 * plan, notice, photo, generic document). Plain inline SVG drawing with
 * `currentColor` so the ink follows the surrounding text token; the subtle
 * fills use opacity, never a literal color. Purely decorative (`aria-hidden`):
 * the owning card carries the accessible name (filename).
 */

import type { SVGProps } from 'react'
import type { DocumentKind } from '../document-kind'

type SvgProps = Omit<SVGProps<SVGSVGElement>, 'viewBox' | 'children'>

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

export function DocumentKindThumbnail({ kind, className }: { kind: DocumentKind; className?: string }) {
  const Sketch = SKETCHES[kind] ?? DocumentSketch
  return <Sketch className={className} data-kind={kind} data-testid="document-kind-thumbnail" />
}
