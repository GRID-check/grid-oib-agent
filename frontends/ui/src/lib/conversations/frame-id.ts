/**
 * A frame's replay entry id: the `grid_frame_id` the backend tags every
 * outbound WebSocket frame with, and the id of its entry in the conversation's
 * replay stream on Dragonfly (`conv:<id>:stream`). It is the resume cursor a
 * client that dropped its socket reads back from
 * (`GET /api/conversations/:id/frames?after=<id>`).
 *
 * A Redis stream entry id, `<ms>-<n>`: monotonic across replicas and restarts.
 * Shared by the browser (dedupe, cursor) and the BFF (the read), so it is one
 * definition.
 */

/** The shape of an entry id, for validating a cursor that came from a URL. */
export const FRAME_ID_PATTERN = /^\d+-\d+$/

/** Order two entry ids, numerically part by part. */
export function compareFrameIds(a: string, b: string): number {
  const [aMs = 0, aN = 0] = a.split('-').map(Number)
  const [bMs = 0, bN = 0] = b.split('-').map(Number)
  return aMs - bMs || aN - bN
}
