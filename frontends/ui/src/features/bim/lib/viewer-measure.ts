/**
 * Measuring the building.
 *
 * ## Why a viewer without this is not a review tool
 *
 * Everything this product says about a model is a claim about a dimension: a
 * corridor is 1.20 m wide, a riser is 18 cm, a door leaf is 90 cm, the clear
 * height under that beam is 2.10 m. The agent reads those from the IFC's own
 * quantities — which is the right source, and is also exactly the number a
 * reviewer wants to check against the geometry when a finding surprises them.
 * Until now the answer to "is that really 1.20?" was to open a different
 * program.
 *
 * ## What a measurement is here
 *
 * Two world-space points and the numbers that follow from them. Not just the
 * straight-line distance: a reviewer checking a clear width wants the
 * HORIZONTAL run, and one checking a head height wants the VERTICAL rise, and
 * a diagonal between two arbitrary picks is the one number that answers
 * neither. All three travel together, which is also what makes a measurement
 * self-checking — a "2.10 m" that turns out to be 2.05 horizontal and 0.45
 * vertical was taken between the wrong two corners.
 *
 * ## Why snapping is not a nicety
 *
 * A measurement taken by eye on a triangulated surface is worth nothing: the
 * cursor lands somewhere on a face and the number is plausible and wrong. The
 * renderer's `SnapDetector` locks onto vertices, edges and face centres, and
 * the WHICH is reported alongside so the reader can see the pick was a corner
 * rather than a guess. A measurement whose provenance is invisible is a
 * screenshot, not a check.
 *
 * Pure: no React, no renderer. The imperative half lives in the canvas.
 */

import type { SnapOptions } from '@ifc-lite/renderer'

/** A point in the renderer's Y-up world space, in metres. */
export interface MeasurePoint {
  x: number
  y: number
  z: number
}

/**
 * What the cursor locked onto.
 *
 * Mirrors the renderer's `SnapType` without importing the enum at runtime —
 * the values are its string values, and `none` covers a free point on a face
 * where nothing was close enough to snap to.
 */
export type MeasureSnapKind = 'vertex' | 'edge' | 'face' | 'face_center' | 'point_cloud' | 'none'

/** One placed end of a measurement, and how it was placed. */
export interface MeasureAnchor {
  point: MeasurePoint
  snap: MeasureSnapKind
}

export interface Measurement {
  /** Stable across re-renders so the overlay does not rebuild every frame. */
  id: string
  from: MeasureAnchor
  to: MeasureAnchor
}

/**
 * How eagerly the cursor is pulled onto real geometry.
 *
 * `screenSnapRadius` is the one that matters in practice: it is a PIXEL
 * radius, so the pull is the same physical distance on screen whether the
 * reader is 2 m or 200 m from the wall — which a world-space radius alone
 * cannot do. 20 px is the renderer's own default and is about a fingertip;
 * larger starts stealing picks from the face the reader actually wanted.
 *
 * Faces are included. A measurement between two face points is worth less than
 * one between two corners, but "no snap target" must not mean "no measurement"
 * — a reader measuring the clear width of a corridor is pointing at two wall
 * FACES, and those are the correct targets.
 */
export const MEASURE_SNAP_OPTIONS: Partial<SnapOptions> = {
  snapToVertices: true,
  snapToEdges: true,
  snapToFaces: true,
  screenSnapRadius: 20,
  snapRadius: 0.1,
}

/** Straight-line distance between two picks, in metres. */
export function distanceMetres(from: MeasurePoint, to: MeasurePoint): number {
  return Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
}

/**
 * The run on the ground plane, ignoring any height difference.
 *
 * Y is up in the renderer's world — see the axes note in
 * `ifc-viewer-canvas.tsx`. Reading this off X and Z rather than off X and Y is
 * the mistake that makes every horizontal measurement in a viewer wrong by the
 * storey height, and it is invisible on a single-storey test model.
 */
export function horizontalMetres(from: MeasurePoint, to: MeasurePoint): number {
  return Math.hypot(to.x - from.x, to.z - from.z)
}

/** The height difference, signed the way the picks were taken. */
export function verticalMetres(from: MeasurePoint, to: MeasurePoint): number {
  return to.y - from.y
}

/** Where the label sits: halfway along the measured line. */
export function midpoint(from: MeasurePoint, to: MeasurePoint): MeasurePoint {
  return {
    x: (from.x + to.x) / 2,
    y: (from.y + to.y) / 2,
    z: (from.z + to.z) / 2,
  }
}

/**
 * Whether the two components are worth showing beside the total.
 *
 * A purely horizontal or purely vertical measurement is fully described by one
 * number, and printing "2.40 m (2.40 horizontal, 0.00 vertical)" beside it is
 * noise that trains the reader to stop reading the label. One centimetre is
 * the threshold because that is the precision the readout has.
 */
export function isSkew(from: MeasurePoint, to: MeasurePoint): boolean {
  const horizontal = horizontalMetres(from, to)
  const vertical = Math.abs(verticalMetres(from, to))
  return horizontal >= 0.005 && vertical >= 0.005
}

/**
 * A length as an architect writes it.
 *
 * Centimetre precision in metres, always two decimals — `2.40 m`, never
 * `2.4 m`. A trailing zero that disappears is the difference between a
 * dimension and a rounded-off estimate, and drawing conventions everywhere
 * keep it for exactly that reason. Below a centimetre the number is reported
 * in millimetres instead, because `0.00 m` says nothing at all.
 */
export function formatMetres(metres: number): string {
  if (!Number.isFinite(metres)) return '—'
  const magnitude = Math.abs(metres)
  if (magnitude < 0.01) return `${Math.round(metres * 1000)} mm`
  return `${metres.toFixed(2)} m`
}

/**
 * A measurement's id.
 *
 * Derived from the picks rather than from a counter or a random value: the
 * same two points measured twice are the same measurement, so re-measuring
 * something cannot silently stack two identical overlays on top of each other.
 * It is also stable across a reload, which is what lets a measurement travel
 * in a link later without changing shape here.
 */
export function measurementId(from: MeasurePoint, to: MeasurePoint): string {
  const at = (point: MeasurePoint) =>
    `${point.x.toFixed(3)},${point.y.toFixed(3)},${point.z.toFixed(3)}`
  return `${at(from)}|${at(to)}`
}

/**
 * Close a measurement, or reject it.
 *
 * A double-click, a click that did not move off the previous point, or two
 * picks on the same corner all produce a zero-length measurement, which draws
 * as a dot with "0.00 m" beside it and looks like a bug in the tool rather
 * than a slip of the hand. One millimetre apart is the floor.
 */
export function completeMeasurement(
  from: MeasureAnchor,
  to: MeasureAnchor
): Measurement | null {
  if (distanceMetres(from.point, to.point) < 0.001) return null
  return { id: measurementId(from.point, to.point), from, to }
}

/**
 * Add a measurement to the list, replacing any identical one.
 *
 * Deliberately not a plain append: see {@link measurementId}. Re-measuring the
 * same pair is a thing readers do to double-check themselves, and it must not
 * leave two overlapping labels behind.
 */
export function addMeasurement(
  existing: readonly Measurement[],
  next: Measurement
): Measurement[] {
  return [...existing.filter((candidate) => candidate.id !== next.id), next]
}
