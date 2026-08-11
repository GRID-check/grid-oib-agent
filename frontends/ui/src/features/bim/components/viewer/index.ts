/**
 * The viewport's UI kit.
 *
 * Nine atoms, and everything the model stage draws is built from them. The
 * rule this barrel exists to enforce is that the organisms import from HERE
 * and not from Tailwind: if a control needs a shape the kit does not have, the
 * kit gains an atom rather than the organism gaining a `<div className="...">`.
 * That is what keeps the chrome coherent as it grows — the previous viewport
 * had four floating panels in three different materials, all of them written
 * inline, none of them testable.
 */

export { ViewerSurface, type ViewerSurfaceProps } from './viewer-surface'
export {
  ViewerIconButton,
  ViewerIconButtonBase,
  type ViewerIconButtonProps,
} from './viewer-icon-button'
export { ViewerDock, ViewerDockSeparator, type ViewerDockProps } from './viewer-dock'
export {
  ViewerRail,
  ViewerRailItem,
  ViewerRailSection,
  type ViewerRailItemProps,
  type ViewerRailProps,
  type ViewerRailSectionProps,
} from './viewer-rail'
export {
  ViewerField,
  ViewerFieldGroup,
  ViewerPanel,
  type ViewerFieldProps,
  type ViewerPanelProps,
} from './viewer-panel'
export { ViewerProgress, type ViewerProgressProps } from './viewer-progress'
export { ViewerNotice, type ViewerNoticeProps } from './viewer-notice'
export {
  ViewerLegend,
  type ViewerLegendEntry,
  type ViewerLegendProps,
} from './viewer-legend'
export { ViewerSlider, type ViewerSliderProps } from './viewer-slider'
