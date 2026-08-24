/**
 * The two numbers that make composing presence work, shared by the publisher
 * (server) and the composer (browser).
 *
 * Deliberately separate from `./presence`, which is `'server-only'`: the browser
 * needs the refresh cadence and importing it from there would drag the event bus
 * into the client bundle. Same split, and the same reason, as `@/lib/events/types`
 * versus `@/lib/events/bus`.
 *
 * They are a pair. `TYPING_TTL_MS` must stay comfortably above `TYPING_REFRESH_MS`
 * or a still-typing colleague flickers between "typing…" and nothing between
 * publishes; too far above and a closed tab leaves them typing for longer than
 * anyone believes. Roughly 2× is the ratio to keep — two publishes may be lost
 * before an indicator blinks.
 */

/** How long a `typing: true` claim stays believable without a refresh. */
export const TYPING_TTL_MS = 6_000

/** How often a still-typing client republishes. */
export const TYPING_REFRESH_MS = 3_000
