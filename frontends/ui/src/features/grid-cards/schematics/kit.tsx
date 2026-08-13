/**
 * Schematic kit — shared SVG + chrome primitives for the five schematic
 * Grid cards (building section, stair, dimension, setback, egress).
 *
 * Design contract:
 * - Geometry is drawn TO SCALE (metres/centimetres → SVG units via
 *   `fitScale`), sketched with seeded rough.js strokes (see rough.tsx).
 * - The measurement layer is crisp: `DimensionArrow` / `ExtensionLine` /
 *   `SvgLabel` use thin precise lines and a text halo in the card colour.
 * - Status colours are semantic feedback tokens (success / danger / warning),
 *   never the brand accent: pass=green, fail=red, warning=amber,
 *   needs_input=muted + dashed. Unknown values are ALWAYS shown as
 *   "fehlende Angabe" — never a guessed number.
 * - Every card ends in a `NormRefFooter` echoing LegalBasisCard's visual
 *   language, so each drawn limit stays verifiable.
 */

'use client'

import { type FC, type ReactNode, useState } from 'react'
import {
  CircleCheck,
  CircleHelp,
  CircleX,
  FileText,
  Scale,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react'
import { Card } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { useTranslations } from '@/i18n'
import { PdfViewerDialog } from '@/features/knowledge/components/pdf-viewer-dialog'
import { resolveCorpusFileName } from '@/features/knowledge/lib/resolve-corpus-file'
import { useCorpusFiles } from '@/features/knowledge/lib/use-corpus-files'
import { cn } from '@/lib/utils'
import type { DimensionCheckData, DimStatus, NormReferenceData, Provenance } from './types'

/* ── status vocabulary ────────────────────────────────────────────────────── */

/** Semantic stroke/fill colour for a check status (theme-aware CSS vars). */
export const statusColor = (status: DimStatus): string => {
  switch (status) {
    case 'pass':
      return 'var(--text-color-feedback-success)'
    case 'fail':
      return 'var(--text-color-feedback-danger)'
    case 'warning':
      return 'var(--text-color-feedback-warning)'
    case 'needs_input':
      return 'var(--muted-foreground)'
  }
}

/** German verdict label for a status. */
export const statusLabel = (status: DimStatus): string => {
  switch (status) {
    case 'pass':
      return 'erfüllt'
    case 'fail':
      return 'nicht erfüllt'
    case 'warning':
      return 'grenzwertig'
    case 'needs_input':
      return 'Angabe fehlt'
  }
}

const STATUS_ICON: Record<DimStatus, LucideIcon> = {
  pass: CircleCheck,
  fail: CircleX,
  warning: TriangleAlert,
  needs_input: CircleHelp,
}

const STATUS_BADGE_CLASS: Record<DimStatus, string> = {
  pass: 'bg-success-subtle text-success',
  fail: 'bg-danger-subtle text-error',
  warning: 'bg-warning-subtle text-warning',
  needs_input: 'bg-muted text-muted-foreground',
}

const STATUS_RANK: Record<DimStatus, number> = { fail: 3, needs_input: 2, warning: 1, pass: 0 }

/** The most severe status of a set (fail > needs_input > warning > pass). */
export const worstStatus = (statuses: DimStatus[]): DimStatus | null => {
  if (statuses.length === 0) return null
  return statuses.reduce((worst, s) => (STATUS_RANK[s] > STATUS_RANK[worst] ? s : worst))
}

/* ── formatting ───────────────────────────────────────────────────────────── */

export const MISSING_LABEL = 'fehlende Angabe'

const numberFormat = new Intl.NumberFormat('de-AT', { maximumFractionDigits: 2 })

/** Austrian-locale number: 9.8 → "9,8". */
export const fmtNum = (value: number): string => numberFormat.format(value)

/** "9,8 m" / "120 cm" / "6 %" — or `MISSING_LABEL` when the value is null. */
export const fmtDim = (value: number | null | undefined, unit: string): string =>
  value == null ? MISSING_LABEL : `${fmtNum(value)} ${unit}`

/** '<=' → '≤', '>=' → '≥'. */
export const fmtComparator = (comparator: '<=' | '>=' | null | undefined): string =>
  comparator === '<=' ? '≤' : comparator === '>=' ? '≥' : ''

/**
 * The German for each provenance — the same three verbs the answer text uses.
 *
 * Written out rather than composed, because the difference between „laut
 * Modell" and „gemessen" is the difference between reporting the architect's
 * own statement and reporting ours, and a reader has to be able to tell which
 * one they are holding before they sign it.
 */
export const PROVENANCE_LABEL: Record<Provenance, string> = {
  declared: 'laut Modell',
  computed: 'gemessen',
  inferred: 'vermutlich',
}

/** Long form for the tooltip, where there is room to say what the word means. */
export const PROVENANCE_TITLE: Record<Provenance, string> = {
  declared: 'Diese Zahl steht so in der IFC-Datei — eine Angabe der Architektin.',
  computed: 'Aus der Geometrie gemessen, nicht deklariert. Die Toleranz gehört zur Aussage.',
  inferred: 'Aus einer Heuristik abgeleitet. Ein Vorschlag zur Bestätigung, kein Befund.',
}

/**
 * The ± band, at two significant figures — „±5 mm", „±0,15 m²".
 *
 * Two significant figures rather than the value's own precision, mirroring
 * `_tolerance_text` in `measure_register.py`: a band is an order of magnitude,
 * and printing ±0,15416781250000042 asserts a precision about the imprecision.
 *
 * Trailing zeros are NOT padded, which is the half that had to be measured
 * rather than assumed — the backend prints „0.5", not „0.50". Checked against
 * it directly: 0.5 → 0,5 · 0.005 → 0,005 · 0.15416781 → 0,15 · 2.3 → 2,3 ·
 * 0.021 → 0,021. Two renderings of one band that disagree on a digit are two
 * numbers as far as the reader is concerned.
 */
export const fmtTolerance = (tolerance: number | null | undefined, unit: string): string | null => {
  if (tolerance == null || !Number.isFinite(tolerance) || tolerance <= 0) return null
  const magnitude = Math.floor(Math.log10(Math.abs(tolerance)))
  const decimals = Math.min(6, Math.max(0, 1 - magnitude))
  return `±${new Intl.NumberFormat('de-AT', { maximumFractionDigits: decimals }).format(tolerance)} ${unit}`
}

/* ── scale mapping ────────────────────────────────────────────────────────── */

/**
 * Uniform real-world → SVG scale factor: fits `realW × realH` (metres or
 * centimetres) into `boxW × boxH` SVG units, preserving aspect ratio.
 */
export const fitScale = (realW: number, realH: number, boxW: number, boxH: number): number =>
  Math.min(boxW / Math.max(realW, 1e-6), boxH / Math.max(realH, 1e-6))

/* ── crisp SVG measurement layer ──────────────────────────────────────────── */

interface SvgLabelProps {
  x: number
  y: number
  children: ReactNode
  anchor?: 'start' | 'middle' | 'end'
  fill?: string
  size?: number
  mono?: boolean
  italic?: boolean
  weight?: number
  transform?: string
  /** Halo colour behind the glyphs; defaults to the card surface. */
  halo?: string
}

/** SVG text with a halo in the card colour so labels stay legible over strokes. */
export const SvgLabel: FC<SvgLabelProps> = ({
  x,
  y,
  children,
  anchor = 'start',
  fill = 'var(--muted-foreground)',
  size = 10,
  mono = false,
  italic = false,
  weight = 500,
  transform,
  halo = 'var(--card)',
}) => (
  <text
    x={x}
    y={y}
    textAnchor={anchor}
    dominantBaseline="central"
    fontSize={size}
    fontWeight={weight}
    fontStyle={italic ? 'italic' : undefined}
    fontFamily={mono ? 'var(--font-mono)' : 'var(--font-sans)'}
    fill={fill}
    stroke={halo}
    strokeWidth={3}
    strokeLinejoin="round"
    transform={transform}
    style={{ paintOrder: 'stroke' }}
  >
    {children}
  </text>
)

interface ExtensionLineProps {
  x1: number
  y1: number
  x2: number
  y2: number
}

/** Thin extension line from the measured geometry out to a dimension line. */
export const ExtensionLine: FC<ExtensionLineProps> = ({ x1, y1, x2, y2 }) => (
  <line
    x1={x1}
    y1={y1}
    x2={x2}
    y2={y2}
    stroke="var(--muted-foreground)"
    strokeWidth={0.7}
    opacity={0.55}
  />
)

interface DimensionArrowProps {
  x1: number
  y1: number
  x2: number
  y2: number
  /** Pre-formatted label ("120 cm" or MISSING_LABEL). */
  label: string
  status?: DimStatus | null
  /** Explicit colour override (neutral dimensions without a check). */
  color?: string
  /** Perpendicular label offset in px; sign flips the side. Default −9. */
  labelOffset?: number
  fontSize?: number
  dashed?: boolean
  /** Keep the label horizontal even on a vertical dimension (e.g. long "fehlende Angabe"). */
  horizontalLabel?: boolean
}

/**
 * A dimension line with inward arrowheads and a label at the midpoint, placed
 * where the dimension is actually measured. Vertical dimensions get rotated
 * labels, `needs_input` dimensions render dashed + muted + italic.
 */
export const DimensionArrow: FC<DimensionArrowProps> = ({
  x1,
  y1,
  x2,
  y2,
  label,
  status,
  color,
  labelOffset = -9,
  fontSize = 10,
  dashed,
  horizontalLabel,
}) => {
  const stroke = color ?? (status ? statusColor(status) : 'var(--foreground)')
  const missing = status === 'needs_input'
  const dx = x2 - x1
  const dy = y2 - y1
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const nx = -uy
  const ny = ux
  const ah = 5.5

  const head = (px: number, py: number, dirX: number, dirY: number): string => {
    const bx = px + dirX * ah
    const by = py + dirY * ah
    const wing = ah * 0.5
    return `M ${bx + nx * wing} ${by + ny * wing} L ${px} ${py} L ${bx - nx * wing} ${by - ny * wing}`
  }

  const mx = (x1 + x2) / 2 + nx * labelOffset
  const my = (y1 + y2) / 2 + ny * labelOffset
  const vertical = Math.abs(ux) < 0.35 && !horizontalLabel
  const transform = vertical ? `rotate(-90 ${mx} ${my})` : undefined

  return (
    <g>
      <line
        x1={x1}
        y1={y1}
        x2={x2}
        y2={y2}
        stroke={stroke}
        strokeWidth={1.1}
        strokeDasharray={dashed || missing ? '4 3' : undefined}
      />
      <path
        d={head(x1, y1, ux, uy)}
        stroke={stroke}
        strokeWidth={1.1}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d={head(x2, y2, -ux, -uy)}
        stroke={stroke}
        strokeWidth={1.1}
        fill="none"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <SvgLabel
        x={mx}
        y={my}
        anchor="middle"
        fill={stroke}
        size={fontSize}
        mono={!missing}
        italic={missing}
        weight={600}
        transform={transform}
      >
        {label}
      </SvgLabel>
    </g>
  )
}

/* ── canvas wrapper ───────────────────────────────────────────────────────── */

interface SchematicCanvasProps {
  viewW: number
  viewH: number
  /** Below this width the canvas scrolls horizontally instead of shrinking. */
  minWidth?: number
  label: string
  children: ReactNode
}

/**
 * Responsive SVG stage: scales down with the chat column, and past `minWidth`
 * scrolls horizontally inside the card so the column never scrolls sideways.
 */
export const SchematicCanvas: FC<SchematicCanvasProps> = ({
  viewW,
  viewH,
  minWidth,
  label,
  children,
}) => (
  <div className="w-full overflow-x-auto">
    <svg
      viewBox={`0 0 ${viewW} ${viewH}`}
      role="img"
      aria-label={label}
      className="block h-auto w-full"
      style={{ minWidth: minWidth ?? Math.min(viewW, 360) }}
    >
      {children}
    </svg>
  </div>
)

/* ── value-vs-limit bar ───────────────────────────────────────────────────── */

interface LimitBarProps {
  check: DimensionCheckData
  className?: string
}

/**
 * Horizontal bar reading an actual value against a required limit: status-
 * coloured fill for the value, a foreground tick at the limit. Unknown values
 * render an empty track with "fehlende Angabe".
 */
export const LimitBar: FC<LimitBarProps> = ({ check, className }) => {
  const { label, value, required, comparator, status } = check
  const unit = check.unit ?? 'cm'
  const max = Math.max(value ?? 0, required ?? 0) * 1.08 || 1
  const valuePct = value != null ? Math.min((value / max) * 100, 100) : 0
  const requiredPct = required != null ? Math.min((required / max) * 100, 100) : null

  // The band is drawn only for a measurement of OURS. A declared figure is the
  // file's statement and carries no tolerance of ours to draw.
  const band = check.provenance === 'computed' ? fmtTolerance(check.tolerance, unit) : null
  const tolerance = band != null && check.tolerance != null ? check.tolerance : null
  const bandLowPct = value != null && tolerance != null ? Math.max(((value - tolerance) / max) * 100, 0) : null
  const bandHighPct = value != null && tolerance != null ? Math.min(((value + tolerance) / max) * 100, 100) : null

  // The one thing this bar can say that a sentence cannot say as fast: the band
  // CROSSES the limit, so at the precision we actually have, this dimension is
  // on both sides of the line. A 2,47 m ±5 mm clear height against a 2,50 m
  // minimum fails; a 2,498 m ±5 mm one is genuinely undecided, and a bar that
  // drew it as a clean red fill would be asserting a verdict the measurement
  // does not support. Drawn as a hatched span straddling the marker.
  //
  // „Straddles" means some points in the band satisfy the limit and some do
  // not, which makes it comparator-dependent — the first version tested
  // `lo <= required && hi >= required` in both directions and was wrong at
  // each end. 50 ±5 against `<= 55` warns under that rule, and it should not:
  // every value in [45, 55] meets a „≤ 55". Symmetric STRICT bounds are wrong
  // the other way — 50 ±5 against `>= 55` would stop warning, and 45 fails
  // that limit outright.
  //
  // So each comparator gets the pair that actually describes it:
  //   ≤ limit — some pass when lo ≤ limit, some fail when hi >  limit
  //   ≥ limit — some pass when hi ≥ limit, some fail when lo <  limit
  //
  // With no comparator there is no direction and therefore no crossing to
  // report; the band is still drawn, and only the sentence is withheld.
  const low = value != null && tolerance != null ? value - tolerance : null
  const high = value != null && tolerance != null ? value + tolerance : null
  const straddlesLimit =
    required != null && low != null && high != null
      ? comparator === '<='
        ? low <= required && high > required
        : comparator === '>='
          ? high >= required && low < required
          : false
      : false

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-3 text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono text-foreground">
          {value == null ? (
            <span className="font-sans italic text-muted-foreground">{MISSING_LABEL}</span>
          ) : (
            fmtDim(value, unit)
          )}
          {band && <span className="ml-1 text-[0.9em] text-muted-foreground">{band}</span>}
          {check.provenance && (
            <span
              className="ml-1.5 rounded bg-muted px-1 py-px font-sans text-[0.85em] text-muted-foreground"
              title={PROVENANCE_TITLE[check.provenance]}
            >
              {PROVENANCE_LABEL[check.provenance]}
            </span>
          )}
          {required != null && (
            <span className="text-muted-foreground">
              {' '}
              {fmtComparator(comparator)} {fmtDim(required, unit)}
            </span>
          )}
        </span>
      </div>
      <div className="relative h-2 rounded-full bg-muted">
        {value != null && (
          <div
            className="absolute inset-y-0 left-0 rounded-full"
            style={{ width: `${valuePct}%`, backgroundColor: statusColor(status) }}
          />
        )}
        {bandLowPct != null && bandHighPct != null && (
          <div
            className="absolute inset-y-0 border-x border-foreground/40 bg-foreground/15"
            style={{ left: `${bandLowPct}%`, width: `${Math.max(bandHighPct - bandLowPct, 0.5)}%` }}
            aria-hidden="true"
          />
        )}
        {requiredPct != null && (
          <div
            className="absolute -top-1 h-4 w-0.5 -translate-x-1/2 rounded-full bg-foreground/70"
            style={{ left: `${requiredPct}%` }}
            aria-hidden="true"
          />
        )}
      </div>
      {straddlesLimit && (
        <p className="text-[0.92em] leading-snug text-muted-foreground">
          Die Messtoleranz reicht über den Grenzwert: bei dieser Genauigkeit ist nicht entschieden, ob der Wert
          eingehalten ist. Für einen Nachweis genauer aufmessen.
        </p>
      )}
      {status === 'needs_input' && check.missing && (
        <p className="text-[0.92em] leading-snug text-muted-foreground">{check.missing}</p>
      )}
    </div>
  )
}

/* ── checks legend ────────────────────────────────────────────────────────── */

interface DimChecksListProps {
  checks: DimensionCheckData[]
  className?: string
}

/**
 * Legend under a schematic: one row per dimension check, status-coloured.
 *
 * Each row now carries the number AND where it came from, because the two are
 * one claim. The band sits against the value it qualifies rather than in a
 * footnote — „2,47 m ±5 mm" is what decides whether the dimension clears a
 * 2,50 m minimum, and a reader who has to look elsewhere for it will not.
 *
 * A `needs_input` row prints the CAD remedy underneath instead of leaving an
 * empty slot. „fehlende Angabe" on its own reads as a fact about the building;
 * „Fenster ohne IfcOpeningElement — im CAD als Öffnung modellieren" reads as
 * what it is, a finding about the export, with the fix attached.
 */
export const DimChecksList: FC<DimChecksListProps> = ({ checks, className }) => {
  if (checks.length === 0) return null
  return (
    <ul className={cn('flex flex-col gap-1.5', className)}>
      {checks.map((check, index) => {
        const Icon = STATUS_ICON[check.status]
        const unit = check.unit ?? 'cm'
        const band = check.provenance === 'computed' ? fmtTolerance(check.tolerance, unit) : null
        return (
          <li key={`${check.label}-${index}`} className="flex flex-col gap-0.5 text-xs">
            <div className="flex items-center gap-2">
              <Icon
                className="size-3.5 shrink-0"
                style={{ color: statusColor(check.status) }}
                aria-label={statusLabel(check.status)}
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">{check.label}</span>
              {check.value == null ? (
                <span className="italic text-muted-foreground">{MISSING_LABEL}</span>
              ) : (
                <span className="font-mono text-foreground">
                  {fmtDim(check.value, unit)}
                  {band && <span className="ml-1 text-[0.9em] text-muted-foreground">{band}</span>}
                </span>
              )}
              {check.provenance && (
                <span
                  className="shrink-0 rounded bg-muted px-1 py-px text-[0.85em] text-muted-foreground"
                  title={PROVENANCE_TITLE[check.provenance]}
                >
                  {PROVENANCE_LABEL[check.provenance]}
                </span>
              )}
              {check.required != null && (
                <span className="font-mono text-muted-foreground">
                  {fmtComparator(check.comparator)} {fmtDim(check.required, unit)}
                </span>
              )}
            </div>
            {check.status === 'needs_input' && check.missing && (
              <p className="pl-5.5 text-[0.92em] leading-snug text-muted-foreground">{check.missing}</p>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/* ── norm reference footer ────────────────────────────────────────────────── */

interface NormRefFooterProps {
  reference: NormReferenceData | null | undefined
}

/** Footer chip echoing LegalBasisCard: document + section badge + edition.
 * When the referenced document resolves to a base-corpus PDF, the citation
 * opens the actual source in the in-app viewer. */
export const NormRefFooter: FC<NormRefFooterProps> = ({ reference }) => {
  const t = useTranslations('knowledge')
  const corpusFiles = useCorpusFiles()
  const [viewerOpen, setViewerOpen] = useState(false)
  if (!reference?.document) return null
  const corpusFileName = resolveCorpusFileName(reference.document, corpusFiles)
  return (
    <div className="flex flex-col gap-2 border-t pt-3">
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <Scale className="size-3.5" aria-hidden="true" />
        <span className="font-medium text-foreground">{reference.document}</span>
        {reference.section && (
          <Badge variant="outline" className="font-mono text-xs font-normal">
            {reference.section}
          </Badge>
        )}
        {reference.edition && <span>{reference.edition}</span>}
        {corpusFileName && (
          <button
            type="button"
            onClick={() => setViewerOpen(true)}
            className="inline-flex items-center gap-1 font-medium text-primary transition-opacity duration-200 ease-out hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:outline-none"
          >
            <FileText className="size-3.5" aria-hidden="true" />
            {t('viewer.view')}
          </button>
        )}
      </div>
      {reference.excerpt && (
        <blockquote className="max-w-prose border-l-2 border-border pl-3 text-xs italic leading-relaxed text-muted-foreground">
          {reference.excerpt}
        </blockquote>
      )}
      {corpusFileName && viewerOpen && (
        <PdfViewerDialog open onOpenChange={setViewerOpen} fileName={corpusFileName} title={reference.document} />
      )}
    </div>
  )
}

/* ── card chrome ──────────────────────────────────────────────────────────── */

interface StatusBadgeProps {
  status: DimStatus
}

/** Small verdict pill for the card header. */
export const StatusBadge: FC<StatusBadgeProps> = ({ status }) => {
  const Icon = STATUS_ICON[status]
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium',
        STATUS_BADGE_CLASS[status]
      )}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {statusLabel(status)}
    </span>
  )
}

interface SchematicCardProps {
  icon: LucideIcon
  eyebrow: string
  title: string
  verdict?: DimStatus | null
  note?: string | null
  reference?: NormReferenceData | null
  children: ReactNode
}

/**
 * Shared chrome for schematic cards, matching Summary/LegalBasis: eyebrow with
 * icon, title, optional verdict pill, drawing + legend, note, norm footer.
 */
export const SchematicCard: FC<SchematicCardProps> = ({
  icon: Icon,
  eyebrow,
  title,
  verdict,
  note,
  reference,
  children,
}) => (
  <Card className="animate-in fade-in-0 slide-in-from-bottom-1 gap-3 p-5 shadow-xs">
    <div className="flex items-center justify-between gap-2">
      <div className="flex items-center gap-1.5 text-xs font-medium uppercase tracking-widest text-muted-foreground">
        <Icon className="size-3.5" aria-hidden="true" />
        <span>{eyebrow}</span>
      </div>
      {verdict && <StatusBadge status={verdict} />}
    </div>

    <p className="text-sm font-semibold text-foreground">{title}</p>

    {children}

    {note && <p className="max-w-prose text-xs leading-relaxed text-muted-foreground">{note}</p>}

    <NormRefFooter reference={reference} />
  </Card>
)
