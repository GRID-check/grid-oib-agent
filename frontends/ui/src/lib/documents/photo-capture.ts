/**
 * The EXIF facts a photo carries, as the UI reads them.
 *
 * Declared here, beside the other document wire types, so the BFF's
 * reconciliation (`reconcile-status.ts`) and the features layer (`FileItem`)
 * import one shape. The backend sends snake_case; {@link parsePhotoCapture} is
 * the only place that maps it to camelCase and decides what is junk.
 *
 * A capture is a privacy-bearing fact: coordinates place a person. They are
 * shown to people with access to the document and never sent to a model.
 */

export interface PhotoCapture {
  /** When the shutter fired, as the camera recorded it. Not parsed here. */
  capturedAt?: string
  /** Decimal degrees, -90 to 90. Present only together with `longitude`. */
  latitude?: number
  /** Decimal degrees, -180 to 180. Present only together with `latitude`. */
  longitude?: number
  /** Camera make and model as the EXIF writes them. */
  camera?: string
}

const nonEmptyString = (value: unknown): value is string => typeof value === 'string' && value.length > 0

const isCoordinate = (value: unknown, limit: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= limit

/**
 * Read a backend `capture` object into a {@link PhotoCapture}, or `null` when
 * nothing usable is left. Junk is dropped field by field: a bad `captured_at`
 * does not cost the coordinates, and a lone latitude or longitude is dropped,
 * because half a position places nothing.
 */
export function parsePhotoCapture(raw: unknown): PhotoCapture | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const fields = raw as Record<string, unknown>

  const capture: PhotoCapture = {}
  if (nonEmptyString(fields.captured_at)) capture.capturedAt = fields.captured_at
  if (isCoordinate(fields.latitude, 90) && isCoordinate(fields.longitude, 180)) {
    capture.latitude = fields.latitude
    capture.longitude = fields.longitude
  }
  if (nonEmptyString(fields.camera)) capture.camera = fields.camera

  return Object.keys(capture).length > 0 ? capture : null
}
