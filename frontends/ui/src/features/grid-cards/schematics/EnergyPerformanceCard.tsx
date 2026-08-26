/**
 * EnergyPerformanceCard — Energieausweis: the Heizwärmebedarf placed on the
 * A++…G energy-class ladder, with a limit bar reading HWB vs the maximum.
 *
 * The ladder is the familiar EU-style stepped label (green A++ → red G); the
 * building's class row gets a pointer marker carrying its HWB value. Below, a
 * LimitBar reads the Heizwärmebedarf against the required maximum (lower is
 * better) and, when supplied, the Gesamtenergieeffizienzfaktor (fGEE).
 *
 * The ladder colours are the statutory energy-label scale — a deliberate,
 * documented exception to "provenance is the only chroma", tokenized below as
 * a card-scoped named scale with light/dark pairs (see `BANDS`).
 */

import { type FC } from 'react'
import { fmtDim, LimitBar, missingLabel, SchematicCard } from '../cards/shell'
import { SchematicCanvas, SvgLabel } from './draw'
import { useTranslations } from '@/i18n'
import type { DimensionCheckData, NormReferenceData } from './types'

interface EnergyPerformanceCardProps {
  title: string
  hwb: DimensionCheckData
  energy_class?: string | null
  fgee?: DimensionCheckData | null
  reference?: NormReferenceData | null
  note?: string | null
}

/* ── the energy-certificate scale ─────────────────────────────────────────────
 *
 * DOCUMENTED EXCEPTION to `grid-design-language.md` §"Do-not" ("provenance
 * signals are the only chroma"). The A++…G ladder is not decoration and not a
 * signal of ours: it is the statutory colour scale printed on every Austrian /
 * EU Energieausweis, and an architect reads the band by its colour before the
 * letter. Repainting it in the provenance palette would make the card *less*
 * verifiable against the document it is quoting. It is therefore kept — but as
 * a NAMED scale with light/dark pairs, not as loose hex in JSX.
 *
 * The tokens are scoped to this card (`.grid-energy-scale`) rather than added
 * to `styles/tokens.css`, because nothing else in the app may reach for them:
 * a global `--energy-*` invites someone to colour a chart by it. If a second
 * surface ever needs the ladder, these eleven vars should graduate to the token
 * layer as one block, unchanged.
 *
 * Dark is a re-step, not a flip: the bright middle of the ladder (B/C/D) glares
 * on charcoal, so those bands are pulled down while the hue identity holds.
 * Every band clears 3:1 against the dark card surface, so the ladder still
 * reads as nine distinct steps.
 *
 * `ink` is MEASURED, not chosen: the band label used to be a hardcoded `#fff`,
 * which failed on eight of the nine light bands (yellow ran at 1.5:1) and had
 * no dark counterpart at all. Near-black ink clears 4.5:1 on bands A++…F in
 * both themes; only G (deep red) takes paper.
 */
type BandInk = 'ink' | 'paper'

const BANDS: { label: string; light: string; dark: string; ink: BandInk }[] = [
  { label: 'A++', light: '#1a9641', dark: '#1a9641', ink: 'ink' },
  { label: 'A+', light: '#4cae4c', dark: '#47a54a', ink: 'ink' },
  { label: 'A', light: '#7fbf3f', dark: '#78b83c', ink: 'ink' },
  { label: 'B', light: '#c3d92f', dark: '#b6cc2c', ink: 'ink' },
  { label: 'C', light: '#f4d03f', dark: '#e0c23a', ink: 'ink' },
  { label: 'D', light: '#f5b041', dark: '#e2a53e', ink: 'ink' },
  { label: 'E', light: '#eb8f34', dark: '#d98332', ink: 'ink' },
  { label: 'F', light: '#e2662c', dark: '#d15f2a', ink: 'ink' },
  { label: 'G', light: '#d0021b', dark: '#cf2733', ink: 'paper' },
]

/** The scale's own scope. Only this card carries the class. */
const SCALE_SCOPE = 'grid-energy-scale'

const bandVar = (index: number): string => `var(--energy-band-${index + 1})`
const inkVar = (ink: BandInk): string => `var(--energy-band-${ink})`

/**
 * The scale as CSS custom properties, light + dark. Same shape as
 * `components/charts/palette.tsx`'s `SeriesPaletteStyle`: the values live in
 * one place, the `.dark` step switches under the repo-wide `&:is(.dark *)`
 * variant, and no literal hex reaches the JSX.
 */
const EnergyScaleStyle: FC = () => (
  <style>{`
    .${SCALE_SCOPE} {
      --energy-band-ink: #141518;
      --energy-band-paper: #ffffff;
      ${BANDS.map((b, i) => `--energy-band-${i + 1}: ${b.light};`).join('\n      ')}
    }
    .dark .${SCALE_SCOPE} {
      ${BANDS.map((b, i) => `--energy-band-${i + 1}: ${b.dark};`).join('\n      ')}
    }
  `}</style>
)

const normClass = (c: string): string => c.trim().toUpperCase().replace(/\s+/g, '')

export const EnergyPerformanceCard: FC<EnergyPerformanceCardProps> = ({
  title,
  hwb,
  energy_class: energyClass,
  fgee,
  reference,
  note,
}) => {
  const t = useTranslations('chat')
  const activeIndex = energyClass ? BANDS.findIndex((b) => b.label === normClass(energyClass)) : -1

  const rowH = 15
  const gap = 3
  const x0 = 18
  const baseW = 74
  const stepW = 12
  const viewW = 300
  const viewH = BANDS.length * (rowH + gap) + 14

  const hwbCheck: DimensionCheckData = {
    ...hwb,
    label: hwb.label || t('cards.schematics.energy.hwb'),
    unit: hwb.unit ?? 'kWh/m²a',
    comparator: hwb.comparator ?? '<=',
  }

  return (
    <SchematicCard
      title={title}
      verdict={hwbCheck.status}
      note={note}
      reference={reference}
    >
      <div className={SCALE_SCOPE}>
        <EnergyScaleStyle />
        <SchematicCanvas viewW={viewW} viewH={viewH} label={title}>
          {BANDS.map((band, i) => {
            const y = 7 + i * (rowH + gap)
            const w = baseW + i * stepW
            const active = i === activeIndex
            const lit = active || activeIndex < 0
            const fill = bandVar(i)
            // A LIT band is painted at full strength, so its label takes the
            // ink measured against that band. A DIMMED band is composited at
            // 40% toward whatever surface is behind it — paper in light mode,
            // charcoal in dark — so its label follows the surface's own ink
            // (`--foreground`), the only value that stays legible in both
            // directions. Pinning the label to one colour is what broke it
            // before: `#fff` was unreadable on the pale half of the ladder.
            const ink = lit ? inkVar(band.ink) : 'var(--foreground)'
            return (
              <g key={band.label}>
                {/* stepped bar with an arrow tip */}
                <path
                  d={`M ${x0} ${y} H ${x0 + w} L ${x0 + w + 9} ${y + rowH / 2} L ${x0 + w} ${y + rowH} H ${x0} Z`}
                  fill={fill}
                  opacity={lit ? 1 : 0.4}
                />
                <text
                  x={x0 + 9}
                  y={y + rowH / 2}
                  dominantBaseline="central"
                  fontSize={10}
                  fontWeight={700}
                  fontFamily="var(--font-sans)"
                  fill={ink}
                >
                  {band.label}
                </text>
                {active && (
                  <g>
                    <rect
                      x={x0 + w + 16}
                      y={y - 1}
                      width={118}
                      height={rowH + 2}
                      rx={3}
                      fill="var(--card)"
                      stroke={fill}
                      strokeWidth={1.6}
                    />
                    <SvgLabel
                      x={x0 + w + 24}
                      y={y + rowH / 2}
                      size={9.5}
                      weight={700}
                      fill="var(--foreground)"
                      halo="var(--card)"
                    >
                      {hwbCheck.value != null
                        ? t('cards.schematics.energy.hwbMarker', {
                            value: fmtDim(hwbCheck.value, hwbCheck.unit ?? '', t),
                          })
                        : missingLabel(t)}
                    </SvgLabel>
                  </g>
                )}
              </g>
            )
          })}
        </SchematicCanvas>
      </div>

      <div className="flex flex-col gap-2.5">
        <LimitBar check={hwbCheck} />
        {fgee && (
          <LimitBar
            check={{
              ...fgee,
              label: fgee.label || t('cards.schematics.energy.fgee'),
              unit: fgee.unit ?? '',
              comparator: fgee.comparator ?? '<=',
            }}
          />
        )}
      </div>
    </SchematicCard>
  )
}
