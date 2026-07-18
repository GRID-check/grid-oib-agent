/**
 * ConnectorSvg — the thin trace connectors between reasoning-chain nodes
 * (click-dummy "Herleitung" overhaul).
 *
 * Reproduces the mock's fixed 720-unit viewBox geometry (a `line` trunk, a
 * `fan-out` trunk→columns, and a mirror `fan-in` columns→trunk) but strokes
 * with a theme-aware ink hairline instead of the mock's hardcoded `#a8a8a4`,
 * so the lines composite and flip in dark mode. Each connector scales down with
 * its column (viewBox + `max-w-full`); the fan arms are laid out on evenly
 * spaced centers so the flourish reads correctly for any visible card count.
 */

import type { FC } from 'react'

export type ConnectorVariant = 'line' | 'fan-out' | 'fan-in'

export interface ConnectorSvgProps {
  variant: ConnectorVariant
  /** Number of fan arms (fan-out / fan-in). Clamped to 2..4; ignored for line. */
  columns?: number
  /** Accessible-hidden decoration. */
  className?: string
}

/** Theme-aware connector stroke — a mid-strength ink hairline (mock --connector). */
const STROKE = 'color-mix(in oklch, var(--foreground) 22%, transparent)'
const RING_FILL = 'var(--card)'

/** Evenly spaced column centers across the 720 track: (720/n)*(i+0.5). */
const columnCenters = (n: number): number[] =>
  Array.from({ length: n }, (_, i) => Math.round((720 / n) * (i + 0.5)))

const OriginRing: FC<{ cx: number }> = ({ cx }) => (
  <circle cx={cx} cy={4} r={2.5} fill={RING_FILL} stroke={STROKE} strokeWidth={1} />
)

const Chevron: FC<{ cx: number; y: number }> = ({ cx, y }) => (
  <path
    d={`M${cx - 4} ${y - 4} ${cx} ${y} ${cx + 4} ${y - 4}`}
    stroke={STROKE}
    strokeWidth={1}
    strokeLinecap="round"
    strokeLinejoin="round"
  />
)

export const ConnectorSvg: FC<ConnectorSvgProps> = ({ variant, columns = 4, className }) => {
  const svgProps = {
    'aria-hidden': true as const,
    className: `mx-auto block max-w-full ${className ?? ''}`,
    fill: 'none' as const,
    preserveAspectRatio: 'xMidYMid meet' as const,
    style: { marginTop: -1, marginBottom: -1 },
  }

  if (variant === 'line') {
    // Straight trunk from the previous node into this one.
    return (
      <svg width={720} height={38} viewBox="0 0 720 38" {...svgProps}>
        <OriginRing cx={360} />
        <path d="M360 6.5 V33.5" stroke={STROKE} strokeWidth={1} />
        <Chevron cx={360} y={33.5} />
      </svg>
    )
  }

  const cols = columnCenters(Math.min(4, Math.max(2, columns)))

  if (variant === 'fan-out') {
    // One trunk drops to the mid-line then splits to each column.
    return (
      <svg width={720} height={42} viewBox="0 0 720 42" {...svgProps}>
        <OriginRing cx={360} />
        {cols.map((cx) => (
          <path
            key={cx}
            d={`M360 6.5 V20 H${cx} V37.5`}
            stroke={STROKE}
            strokeWidth={1}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
        {cols.map((cx) => (
          <Chevron key={`a${cx}`} cx={cx} y={37.5} />
        ))}
      </svg>
    )
  }

  // fan-in: each column rises to the mid-line then converges to the trunk.
  return (
    <svg width={720} height={42} viewBox="0 0 720 42" {...svgProps}>
      {cols.map((cx) => (
        <OriginRing key={cx} cx={cx} />
      ))}
      {cols.map((cx) => (
        <path
          key={`p${cx}`}
          d={`M${cx} 6.5 V20 H360 V37.5`}
          stroke={STROKE}
          strokeWidth={1}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
      <Chevron cx={360} y={37.5} />
    </svg>
  )
}
