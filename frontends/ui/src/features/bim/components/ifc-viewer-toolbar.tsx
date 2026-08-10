'use client'

/**
 * The viewport's controls, as a component that owns no canvas.
 *
 * Split out of `IfcModelViewer` deliberately, and not only for tidiness: the
 * canvas needs WebGPU, so anything rendered inside it is unreachable to a test
 * runner and to the screenshot harness. Every control an architect actually
 * presses now lives in a component that renders from plain state, which means
 * the toolbar can be asserted on, captured, and reviewed even where no GPU
 * exists — and the untestable part shrinks to "does the renderer honour the
 * values we hand it".
 *
 * The controls are the ones that turn a model into drawings: stand it square
 * (plan, four elevations), draw it parallel so it measures, and cut it. Orbit
 * was never the hard part.
 */

import {
  Box,
  Eye,
  EyeOff,
  Maximize2,
  Scissors,
  SquareStack,
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import { BIM_CAMERA_VIEWS, type BimCameraView, type BimSection } from '../lib/viewer-camera'

export interface IfcViewerToolbarProps {
  view: BimCameraView
  onViewChange: (view: BimCameraView) => void
  orthographic: boolean
  onOrthographicChange: (orthographic: boolean) => void
  section: BimSection | null
  onSectionChange: (section: BimSection | null) => void
  /** Vertical extent of the model, in metres, for the cut slider's range. */
  cutRange: { minMetres: number; maxMetres: number } | null
  /** Where the cut lands when it is switched on — a metre above the floor. */
  defaultCutMetres: number | null
  xray: boolean
  onXrayChange?: (xray: boolean) => void
  onFit: () => void
  /** Disabled until the model has actually loaded — see the note on `onFit`. */
  disabled?: boolean
  className?: string
}

/** The order the buttons read in: plan first, then the compass. */
const VIEW_ORDER: readonly BimCameraView[] = BIM_CAMERA_VIEWS

export function IfcViewerToolbar({
  view,
  onViewChange,
  orthographic,
  onOrthographicChange,
  section,
  onSectionChange,
  cutRange,
  defaultCutMetres,
  xray,
  onXrayChange,
  onFit,
  disabled = false,
  className,
}: IfcViewerToolbarProps): JSX.Element {
  const t = useTranslations('bim')

  // Switching the cut on needs somewhere to put it. The storey's own height
  // when the page knows one, otherwise a third of the way up the model — never
  // the floor, where the plane slices the slab and shows an empty view the
  // reader will read as a broken model.
  const fallbackCut =
    cutRange === null ? 0 : cutRange.minMetres + (cutRange.maxMetres - cutRange.minMetres) / 3
  const cutWhenEnabled = defaultCutMetres ?? Math.round(fallbackCut * 100) / 100

  return (
    <div className={cn('flex flex-col items-end gap-1.5', className)}>
      <div className="flex flex-wrap justify-end gap-1">
        {VIEW_ORDER.map((candidate) => (
          <Button
            key={candidate}
            type="button"
            size="sm"
            variant={view === candidate ? 'default' : 'secondary'}
            aria-pressed={view === candidate}
            disabled={disabled}
            onClick={() => onViewChange(candidate)}
          >
            {t(`viewer.view.${candidate}`)}
          </Button>
        ))}
      </div>

      <div className="flex flex-wrap justify-end gap-1">
        <Button
          type="button"
          size="sm"
          variant={orthographic ? 'default' : 'secondary'}
          aria-pressed={orthographic}
          disabled={disabled}
          onClick={() => onOrthographicChange(!orthographic)}
        >
          {orthographic ? (
            <SquareStack className="size-3.5" aria-hidden="true" />
          ) : (
            <Box className="size-3.5" aria-hidden="true" />
          )}
          {t(orthographic ? 'viewer.projection.parallel' : 'viewer.projection.perspective')}
        </Button>

        <Button
          type="button"
          size="sm"
          variant={section ? 'default' : 'secondary'}
          aria-pressed={section !== null}
          disabled={disabled}
          onClick={() =>
            onSectionChange(section ? null : { atMetres: cutWhenEnabled, flipped: false })
          }
        >
          <Scissors className="size-3.5" aria-hidden="true" />
          {t('viewer.section.toggle')}
        </Button>

        {onXrayChange && (
          <Button
            type="button"
            size="sm"
            variant={xray ? 'default' : 'secondary'}
            aria-pressed={xray}
            disabled={disabled}
            onClick={() => onXrayChange(!xray)}
          >
            {xray ? (
              <EyeOff className="size-3.5" aria-hidden="true" />
            ) : (
              <Eye className="size-3.5" aria-hidden="true" />
            )}
            {t('viewer.xray')}
          </Button>
        )}

        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={onFit}>
          <Maximize2 className="size-3.5" aria-hidden="true" />
          {t('viewer.fit')}
        </Button>
      </div>

      {section && cutRange && (
        <div className="flex items-center gap-2 rounded-lg bg-background/85 px-2 py-1 backdrop-blur">
          <label htmlFor="bim-section-cut" className="text-xs text-muted-foreground">
            {t('viewer.section.height')}
          </label>
          <input
            id="bim-section-cut"
            type="range"
            className="w-40 accent-brand"
            min={cutRange.minMetres}
            max={cutRange.maxMetres}
            step={0.05}
            value={section.atMetres}
            disabled={disabled}
            onChange={(event) =>
              onSectionChange({ ...section, atMetres: Number(event.target.value) })
            }
          />
          <output
            htmlFor="bim-section-cut"
            className="w-16 text-right font-mono text-xs tabular-nums"
          >
            {t('viewer.section.metres', { value: section.atMetres.toFixed(2) })}
          </output>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-pressed={section.flipped}
            disabled={disabled}
            onClick={() => onSectionChange({ ...section, flipped: !section.flipped })}
          >
            {t(section.flipped ? 'viewer.section.up' : 'viewer.section.down')}
          </Button>
        </div>
      )}
    </div>
  )
}
