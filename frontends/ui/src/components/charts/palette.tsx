/**
 * GRID's validated categorical chart palette (dataviz reference instance,
 * validated for lightness band / chroma / adjacent-pair CVD separation /
 * contrast against both surfaces). Slot ORDER is the CVD-safety mechanism —
 * never reorder or cycle; entities beyond 8 slots fold into "Other".
 *
 * Consumers style marks with `var(--grid-series-N)` / `--grid-series-other`
 * inside an element that renders <SeriesPaletteStyle/> and carries the
 * `grid-usage-viz` class — dark steps switch under `.dark` automatically.
 */

import type { FC } from 'react'

export const SERIES_LIGHT = ['#2a78d6', '#1baf7a', '#eda100', '#008300', '#4a3aa7', '#e34948', '#e87ba4', '#eb6834']
export const SERIES_DARK = ['#3987e5', '#199e70', '#c98500', '#008300', '#9085e9', '#e66767', '#d55181', '#d95926']
export const OTHER_LIGHT = '#767672'
export const OTHER_DARK = '#8f8e89'

export const SERIES_SLOT_COUNT = SERIES_LIGHT.length

export const SeriesPaletteStyle: FC = () => (
  <style>{`
    .grid-usage-viz {
      ${SERIES_LIGHT.map((hex, i) => `--grid-series-${i + 1}: ${hex};`).join('\n      ')}
      --grid-series-other: ${OTHER_LIGHT};
    }
    .dark .grid-usage-viz {
      ${SERIES_DARK.map((hex, i) => `--grid-series-${i + 1}: ${hex};`).join('\n      ')}
      --grid-series-other: ${OTHER_DARK};
    }
  `}</style>
)
