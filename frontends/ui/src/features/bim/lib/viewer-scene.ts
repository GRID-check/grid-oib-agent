/**
 * How the building is lit and shaded.
 *
 * The renderer has had a lighting environment and a visual-enhancement pass
 * since 1.4x, and this viewport used neither: every frame was drawn with the
 * kernel's hardcoded default sun on a flat clear colour. That is why the model
 * read as grey plastic. Contact shading is what makes a slab meet a wall,
 * separation lines are what stop twenty coplanar surfaces merging into one, and
 * edge contrast is what makes an axonometric read as a drawing.
 *
 * Kept out of the canvas because it is a *design decision*, not a rendering
 * one — these are the same warm-paper values as `tokens.css`, expressed as
 * light rather than as CSS, and they belong somewhere a designer can find and a
 * test can pin. The canvas hands them to `render()` and knows nothing about
 * them.
 *
 * Colours are linear RGB triples in the renderer's own space, which is why they
 * are not literally the token hexes: `#faf9f7` paper is `0.94` here, not
 * `0.98`. The pairs below were chosen so the two themes have the SAME contrast
 * between model and background, which is the property that actually matters —
 * a model that reads well on paper and disappears on charcoal is one theme
 * that was designed and one that was inherited.
 */

import type { LightingEnvironment, VisualEnhancementOptions } from '@ifc-lite/renderer'

export type ViewerTheme = 'light' | 'dark'

/**
 * The frame's clear colour, matching the surface the dialog sits on.
 *
 * Only used when the sky is off. It stays here rather than in the canvas so
 * "what colour is behind the building" has one answer per theme.
 */
export const VIEWER_CLEAR_COLOR: Record<ViewerTheme, [number, number, number, number]> = {
  light: [0.949, 0.945, 0.937, 1],
  dark: [0.086, 0.086, 0.09, 1],
}

/**
 * A soft vertical gradient behind the model rather than a flat fill.
 *
 * The single thing that separates a viewer that looks built from one that looks
 * like a canvas element with a background colour. Deliberately almost
 * monochrome — the gradient is doing depth, not colour, and a blue studio
 * backdrop would collide with the provenance signal system, where blue means
 * Rechtsquelle and nothing else.
 *
 * `ground` is darker than `horizon` in both themes so the model appears to
 * stand ON something. Below the horizon is where the building's own shadow
 * falls, and a ground lighter than the sky reads as a model floating in fog.
 */
const SKY: Record<ViewerTheme, { zenith: [number, number, number]; horizon: [number, number, number]; ground: [number, number, number] }> = {
  light: {
    zenith: [0.965, 0.961, 0.949],
    horizon: [0.925, 0.919, 0.906],
    ground: [0.855, 0.847, 0.831],
  },
  dark: {
    zenith: [0.075, 0.075, 0.082],
    horizon: [0.125, 0.126, 0.133],
    ground: [0.055, 0.055, 0.06],
  },
}

/**
 * Where the sun is, in viewer space (Y-up), pointing TOWARD the light.
 *
 * High and over the reader's left shoulder. Two reasons, both borrowed from how
 * architectural models are photographed: light from above-left is the
 * convention every elevation drawing already assumes (which is why shadow
 * direction in a rendering that disagrees looks subtly wrong), and a sun with a
 * FRONT component means the facade the camera opens on is lit rather than
 * silhouetted.
 *
 * Not straight overhead: a sun at the zenith flattens every vertical surface to
 * the same value and the building loses its corners.
 */
const SUN_DIRECTION: [number, number, number] = [-0.42, 0.82, 0.39]

/**
 * The lighting environment for a theme.
 *
 * `ambientIntensity` is generous on purpose. A building is mostly interiors and
 * north facades, and a physically-plausible ambient leaves both black — which
 * in a VIEWER (as opposed to a rendering) means an architect cannot see the
 * thing they clicked. The sun carries the form; the ambient guarantees nothing
 * is unreadable.
 */
export function viewerEnvironment(theme: ViewerTheme): LightingEnvironment {
  const dark = theme === 'dark'
  return {
    sunDirection: SUN_DIRECTION,
    // A hair warm in light, a hair cool in dark — the same trick the token file
    // plays, so the viewport belongs to the app rather than sitting in it.
    sunColor: dark ? [0.92, 0.93, 1] : [1, 0.985, 0.955],
    sunIntensity: dark ? 0.5 : 0.62,
    skyColor: dark ? [0.24, 0.26, 0.32] : [0.62, 0.65, 0.72],
    groundColor: dark ? [0.1, 0.095, 0.09] : [0.36, 0.33, 0.3],
    ambientIntensity: dark ? 0.42 : 0.38,
    fillIntensity: dark ? 0.2 : 0.16,
    // The rim is what keeps a dark model from dissolving into a dark
    // background. It costs nothing and it is the whole reason the dark theme
    // is legible at grazing angles.
    rimIntensity: dark ? 0.26 : 0.14,
    exposure: dark ? 0.92 : 0.88,
    skyEnabled: true,
    sky: SKY[theme],
  }
}

/**
 * Edges, contact shadows and separation lines.
 *
 * The three passes that turn shaded geometry into architecture:
 *
 * - **contactShading** — ambient occlusion in the crevices. Without it a slab
 *   and the wall on top of it are two shades of the same grey with no seam.
 * - **separationLines** — a line where two surfaces meet at a shallow angle.
 *   IFC exports are full of coplanar faces (every layered wall, every floor
 *   build-up) and without this they read as one surface.
 * - **edgeContrast** — darkens silhouettes, which is what makes an
 *   orthographic view read as a drawn elevation rather than a flat render.
 *
 * `high` quality on all three. This is a viewport showing ONE building on a
 * machine that already ran a WASM geometry kernel over a 150 MB file; the
 * frame budget is not where the constraint is. The interactive path drops to
 * the cheaper tier on its own while the camera is moving.
 */
export function viewerEnhancement(): VisualEnhancementOptions {
  return {
    enabled: true,
    edgeContrast: { enabled: true, intensity: 0.55 },
    contactShading: { quality: 'high', intensity: 0.7, radius: 0.6 },
    separationLines: { enabled: true, quality: 'high', intensity: 0.45, radius: 0.5 },
  }
}

/**
 * The same three passes, cheapened for a thumbnail-sized viewport.
 *
 * The in-file preview is a few hundred pixels of a card that may be one of
 * several on screen. Contact shading at `high` over four of those is a real
 * cost for detail nobody can resolve at that size.
 */
export function viewerEnhancementCompact(): VisualEnhancementOptions {
  return {
    enabled: true,
    edgeContrast: { enabled: true, intensity: 0.5 },
    contactShading: { quality: 'low', intensity: 0.55, radius: 0.6 },
    separationLines: { enabled: false },
  }
}

/**
 * Which theme the viewport should light itself for.
 *
 * Read from the document rather than from React context: the canvas is behind
 * `next/dynamic` with `ssr: false` and mounts into a page whose theme class is
 * already on `<html>`, so this is both simpler and correct on first paint —
 * where a context read would flash the light environment before hydrating.
 */
export function readViewerTheme(): ViewerTheme {
  if (typeof document === 'undefined') return 'light'
  return document.documentElement.classList.contains('dark') ? 'dark' : 'light'
}

/**
 * Keep watching, because the theme changes under an open viewport.
 *
 * Reading it once at load was enough only if nobody switches. They do, and not
 * always on purpose: the theme can be `system`, and `prefers-color-scheme`
 * flips at sunset with no interaction at all. A viewport that missed it keeps
 * the paper clear colour and the light sun inside a charcoal dialog — a
 * white-hot rectangle in a dark room, lit from the wrong environment, and no
 * control on screen to correct it short of closing the model.
 *
 * The same `class`-on-`<html>` observation `Toaster` already does; this is the
 * viewport's copy of it, here rather than in the canvas so it can be tested
 * without a WebGPU adapter.
 *
 * @param onChange Called only when the theme actually differs, so a class
 *   change for any other reason does not cost a redraw.
 * @returns The unsubscribe, for an effect cleanup.
 */
export function observeViewerTheme(onChange: (theme: ViewerTheme) => void): () => void {
  if (typeof document === 'undefined' || typeof MutationObserver === 'undefined') {
    return () => {}
  }
  let current = readViewerTheme()
  const observer = new MutationObserver(() => {
    const next = readViewerTheme()
    if (next === current) return
    current = next
    onChange(next)
  })
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}
