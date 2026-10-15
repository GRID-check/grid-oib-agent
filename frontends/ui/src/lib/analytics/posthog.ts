/**
 * PostHog browser client — analytics, replay, surveys and Support, privacy-first.
 *
 * Analytics is never a boot dependency: when the deployment configures no
 * PostHog host/token, every function below is a silent no-op and no event
 * leaves the browser. Configuration arrives at RUNTIME through `AppConfig`
 * (server reads the env per request, client receives it via context) rather
 * than through build-time `NEXT_PUBLIC_*` inlining — the Docker image builds
 * with no env files, so a build-time read would bake `undefined` into the
 * client bundle and silently disable analytics on every deployed environment
 * while working in `next dev`.
 *
 * This module is the single gate: call sites use `capturePosthog` /
 * `identifyPosthog` / `resetPosthog` / `sendPosthogSupportMessage` directly and
 * never touch `posthog-js` or branch on configuration themselves.
 *
 * PRIVACY POSTURE (the reasons are the contract; change one and re-read all):
 *
 * - **Storage: `localStorage+cookie`, cross-subdomain.** The product question
 *   "what happens between the landing page and the first sign-in" needs one
 *   anonymous id to survive the WorkOS full-page redirect, and a recording needs
 *   a session that survives a reload. `persistence: 'memory'` (wave 1) kept
 *   nothing in the browser and paid for it with a new anonymous id and a new
 *   session on EVERY page load: funnels from the landing site never stitched and
 *   replays split mid-task. What is stored now is the `ph_<token>_posthog`
 *   cookie and the same-named localStorage entry (365 days), with a
 *   cross-subdomain identifier, plus the survey keys posthog-js writes when a
 *   survey is shown. None of it is strictly necessary. The privacy notice
 *   (`lib/legal/content`) discloses exactly this storage and the opt-out, so a
 *   change to `persistence`, the cookie scope or what is stored is a change to
 *   that notice too: edit both in one commit. The opt-out is the profile page's
 *   "usage analytics" switch (`optOutPosthog`), which PostHog honours before
 *   capturing anything.
 * - **Identity: the WorkOS user id plus non-personal context.** `bootstrap`
 *   hands the server-known id to the SDK at init, so the very first pageview is
 *   already the signed-in person (before it, that pageview was anonymous and
 *   landed on a different person). `organization_id`, `organization_name`,
 *   `user_role` and `locale` are registered as super properties. No email, no
 *   name: pending the owner's explicit permission. `person_profiles:
 *   'identified_only'` means a signed-out visitor never creates a person.
 * - **Tenant context travels as properties, not groups.** PostHog group
 *   analytics is a paid add-on, billed on every identified event once
 *   subscribed, so `posthog.group()` is deliberately not used.
 * - **Autocapture sees words.** Element text and attributes are captured so a
 *   click reads "Export" rather than "button.btn-3". Security exceptions are not
 *   up for debate and live in two places: elements carrying `ph-no-capture`
 *   (the BYOK key input, the document viewers) are skipped by autocapture and
 *   blocked in replay, and the same names (`sig|token|secret|key|code|state`) are
 *   removed from URLs twice: by the SDK's own `mask_personal_data_properties`
 *   for the properties it owns, and by `scrubEvent` (`posthog-scrub.ts`) for the
 *   ones it does not (element href/src, exception stacks, external click URLs).
 * - **Replay is on, text-masked, and blind to secrets.** See
 *   `buildSessionRecordingOptions`. Text masking is unchanged from wave 1; lifting
 *   it is the owner's decision, not this file's.
 * - **First-party ingestion.** `api_host` is this app's `/ingest` route
 *   (`app/ingest/[...path]/route.ts`) unless `NEXT_PUBLIC_POSTHOG_PROXY` is off.
 *   Blockers filter by third-party host; a same-origin path is not on their lists
 *   and the privacy notice has one fewer recipient domain to name.
 */

import posthog, {
  type BeforeSendFn,
  type CapturedNetworkRequest,
  type PostHogConfig as PostHogSdkConfig,
  type SessionRecordingOptions,
} from 'posthog-js'

import {
  DISABLED_POSTHOG_CONFIG,
  POSTHOG_PROXY_PATH,
  REPLAY_BLOCK_CLASS,
  postHogConfigFromEnv,
  posthogUiHost,
  type PostHogConfig,
  type PostHogIdentity,
} from './posthog-config'
import { SENSITIVE_QUERY_KEYS, scrubDeep } from './posthog-scrub'

export { DISABLED_POSTHOG_CONFIG, postHogConfigFromEnv, type PostHogConfig, type PostHogIdentity }

type PostHogProperties = Record<string, string | number | boolean | null | undefined>

/**
 * Product events the UI emits. A closed union so a typo'd event name fails
 * the build instead of silently creating a second, almost-identical event in
 * PostHog. Add the name here when a call site starts emitting a new one.
 *
 * `report_exported` is the trigger of the CSAT survey in PostHog (a person took a
 * generated document out of the app); its properties are `kind` and `format`.
 *
 * `answer_completed` closes a chat turn (`outcome`, `duration_ms`,
 * `citation_count`, `source_kinds`, `effort`, `has_run`); `citation_opened`,
 * `document_opened` and `ifc_model_opened` are the three ways a reader goes from
 * an answer to its evidence.
 *
 * Properties are non-identifying by rule: enums, counts, booleans, ids of our
 * own rows. Never free text, never file names, never an address.
 */
export type PostHogEvent =
  | 'product_tour_completed'
  | 'product_tour_skipped'
  | 'project_created'
  | 'project_member_access_changed'
  | 'job_created'
  | 'job_updated'
  | 'job_enabled_changed'
  | 'job_run_submitted'
  | 'job_deleted'
  | 'skill_created'
  | 'skill_updated'
  | 'skill_deleted'
  | 'skill_enabled_changed'
  | 'answer_retry_thorough'
  | 'answer_feedback_submitted'
  | 'answer_completed'
  | 'citation_opened'
  | 'document_opened'
  | 'ifc_model_opened'
  | 'product_feedback_submitted'
  | 'document_uploaded'
  | 'chat_message_sent'
  | 'report_exported'
  | 'similar_passages_searched'
  | 'similar_passage_opened'

let initialized = false

/**
 * The URL with its query string and fragment removed. Signed image URLs carry
 * their HMAC in the query (`lib/images/signed-image-url.ts`), so a recorded
 * request must never keep it.
 */
export const stripUrlQuery = (url: string): string => {
  const cut = url.search(/[?#]/)
  return cut === -1 ? url : url.slice(0, cut)
}

/**
 * Request and response headers that never reach a recording: credentials
 * (`Authorization`, `Cookie`, `Set-Cookie`), our own trust headers (`x-grid-*`,
 * which carry tenant scope and the internal token), AuthKit's session header,
 * and anything that is named like a secret.
 */
const SECRET_HEADER =
  /^(?:authorization|proxy-authorization|cookie|set-cookie|x-grid-.*|x-workos-.*|x-api-key|.*token.*|.*secret.*)$/i

/**
 * Endpoints whose request and response bodies are never recorded, whatever the
 * status: the BYOK key (`POST` carries `apiKey`), service-to-service calls,
 * the auth routes and the two that return a short-lived audit-portal link.
 */
const NO_BODY_PATH =
  /^\/api\/(?:organization\/llm-credentials|internal|auth|organization\/audit-portal|platform\/audit-portal)(?:\/|$)/

const pathOf = (url: string): string => {
  try {
    return new URL(url, 'http://localhost').pathname
  } catch {
    return stripUrlQuery(url)
  }
}

type RecordedHeaders = CapturedNetworkRequest['requestHeaders']

const withoutSecretHeaders = (headers: RecordedHeaders): RecordedHeaders => {
  if (!headers) return headers
  return Object.fromEntries(Object.entries(headers).filter(([name]) => !SECRET_HEADER.test(name)))
}

/** Bodies are kept only for a failed request, and never for {@link NO_BODY_PATH}. */
const mayKeepBodies = (request: CapturedNetworkRequest, path: string): boolean =>
  !NO_BODY_PATH.test(path) && typeof request.status === 'number' && request.status >= 400

/**
 * Replay's network entry for one request: the URL without query or fragment
 * (signed image URLs carry their HMAC in the query), the headers minus
 * {@link SECRET_HEADER}, and a body only when the request failed and is not on
 * {@link NO_BODY_PATH}. A failed call is the one whose payload explains what
 * went wrong; a successful one is the user's content.
 *
 * The recorder is configured to record headers and bodies (`recordHeaders`,
 * `recordBody`); this function is where that is narrowed, so it is also the
 * lock when a remote project setting turns recording up.
 */
export const maskReplayNetworkRequest = (request: CapturedNetworkRequest): CapturedNetworkRequest => {
  const name = stripUrlQuery(request.name)
  const keepBodies = mayKeepBodies(request, pathOf(name))
  return {
    ...request,
    name,
    requestHeaders: withoutSecretHeaders(request.requestHeaders),
    responseHeaders: withoutSecretHeaders(request.responseHeaders),
    requestBody: keepBodies ? request.requestBody : undefined,
    responseBody: keepBodies ? request.responseBody : undefined,
  }
}

/**
 * Elements the recorder replaces with a grey placeholder: whatever carries a
 * signed capability URL, in any attribute that can hold one, plain (`sig=`) or
 * percent-encoded as `next/image` writes it (`sig%3D`).
 */
export const SIGNED_URL_BLOCK_SELECTOR = ['src', 'srcset', 'href', 'data', 'poster']
  .flatMap((attribute) => [`[${attribute}*="sig=" i]`, `[${attribute}*="sig%3D" i]`])
  .join(', ')

/**
 * What the recorder may see.
 *
 * - `maskAllInputs` + `maskTextSelector: '*'`: every typed value and every text
 *   node is replaced by asterisks of its length. A replay shows layout, clicks,
 *   scrolling and rage, never a question, an answer or a document line. There
 *   is no unmask allow-list: posthog-js 1.428 has no unmask selector, and
 *   inventing one through `maskTextFn` would make the chrome/content boundary a
 *   regex nobody reviews. Lifting this is the owner's call (wave 2 brief).
 * - `blockSelector`: media is not text, so `maskTextSelector` leaves an `<img>`'s
 *   `src` in the recording. Images, video, canvas and frames are blocked
 *   outright, anything with a signed URL in an attribute is blocked even when it
 *   is not one of those ({@link SIGNED_URL_BLOCK_SELECTOR}), and the PDF and IFC
 *   viewers and the BYOK key input carry `ph-no-capture` (class) or
 *   `data-ph-no-capture` (attribute) themselves.
 * - `captureCanvas.recordCanvas: false`: the IFC model is a WebGL canvas; the
 *   local setting beats the project's remote one.
 * - Network: headers and failed-request bodies are recorded, narrowed by
 *   `maskReplayNetworkRequest`. Console log capture stays off in replay.
 * - `sampleRate` is the free-tier brake (5K recordings a month).
 */
export const buildSessionRecordingOptions = (sampleRate: number): SessionRecordingOptions => ({
  maskAllInputs: true,
  maskTextSelector: '*',
  blockClass: REPLAY_BLOCK_CLASS,
  blockSelector: `img, video, canvas, iframe, object, embed, [data-ph-no-capture], ${SIGNED_URL_BLOCK_SELECTOR}`,
  captureCanvas: { recordCanvas: false },
  recordHeaders: true,
  recordBody: true,
  maskCapturedNetworkRequestFn: maskReplayNetworkRequest,
  sampleRate,
})

/**
 * `before_send`: the last stop before an event leaves the browser. Removes the
 * secrets from every URL-shaped string in it (`posthog-scrub.ts`). A replay
 * chunk (`$snapshot`) is skipped for its payload only: that is megabytes of DOM
 * and it is covered by the block selector and the network mask instead.
 */
export const scrubEvent: BeforeSendFn = (capture) => {
  if (!capture) return capture
  const properties =
    capture.event === '$snapshot'
      ? Object.fromEntries(
          Object.entries(capture.properties).map(([key, value]) => [
            key,
            key === '$snapshot_data' ? value : scrubDeep(value),
          ])
        )
      : scrubDeep(capture.properties)
  return {
    ...capture,
    properties,
    ...(capture.$set ? { $set: scrubDeep(capture.$set) } : {}),
    ...(capture.$set_once ? { $set_once: scrubDeep(capture.$set_once) } : {}),
  }
}

/** The slice of the SDK {@link adoptServerIdentity} needs; a spec passes a fake. */
export interface IdentityClient {
  get_distinct_id: () => string
  reset: () => void
  identify: (distinctId: string) => void
}

/**
 * Make the SDK's person the one the server says is signed in.
 *
 * `bootstrap` covers a first visit and an anonymous visitor who signs in (the
 * SDK merges them). It does NOT cover a browser whose persisted identity is a
 * DIFFERENT signed-in person (a shared machine, a session that expired and was
 * replaced): there posthog-js keeps the old identity and only logs a warning,
 * which would attribute the new person's whole visit to the old one. Reset and
 * identify instead, so the old person's anonymous id is not merged into the new.
 */
export const adoptServerIdentity = (client: IdentityClient, distinctId: string): void => {
  if (client.get_distinct_id() === distinctId) return
  client.reset()
  client.identify(distinctId)
}

/**
 * The `posthog.init` options for one deployment's config. Pure, so the privacy
 * posture in the header is asserted by a spec rather than remembered.
 *
 * `identity` is the server-known session (signed-out visitors pass none): it
 * becomes `bootstrap`, so the first pageview already belongs to the person.
 */
export const buildPosthogInitOptions = (
  config: PostHogConfig,
  identity?: PostHogIdentity | null
): Partial<PostHogSdkConfig> => ({
  api_host: config.proxy ? POSTHOG_PROXY_PATH : config.host,
  // With a path as `api_host` the SDK cannot derive the app host any more; the
  // toolbar, heatmaps and replay links need it (PostHog docs, proxy-reference).
  ...(config.proxy ? { ui_host: posthogUiHost(config.host) } : {}),
  defaults: '2026-01-30',
  persistence: 'localStorage+cookie',
  cross_subdomain_cookie: true,
  person_profiles: 'identified_only',
  ...(identity
    ? {
        bootstrap: { distinctID: identity.distinctId, isIdentifiedID: true },
        loaded: (client: IdentityClient) => adoptServerIdentity(client, identity.distinctId),
      }
    : {}),
  capture_pageview: 'history_change',
  capture_heatmaps: true,
  capture_performance: true,
  capture_dead_clicks: true,
  // The SDK's own URL masking: query values named here become `<masked>` in
  // `$current_url`, `$referrer`, the campaign and `$initial_*` person properties,
  // heatmap URLs and the URLs a recording stores. `scrubEvent` below covers what
  // this does not reach (element href/src, `$external_click_url`, exception stacks).
  mask_personal_data_properties: true,
  custom_personal_data_properties: [...SENSITIVE_QUERY_KEYS],
  mask_all_text: false,
  mask_all_element_attributes: false,
  before_send: scrubEvent,
  capture_exceptions: {
    capture_unhandled_errors: true,
    capture_unhandled_rejections: true,
    capture_console_errors: false,
  },
  disable_session_recording: !config.sessionReplay,
  enable_recording_console_log: false,
  session_recording: buildSessionRecordingOptions(config.replaySampleRate),
  debug: process.env.NODE_ENV === 'development',
})

/**
 * Initialize the browser PostHog session. Idempotent — safe to call on every
 * render. No-op without both values (analytics disabled) and outside the
 * browser (server-side import safety).
 */
export const initPosthogClient = (config: PostHogConfig, identity?: PostHogIdentity | null): void => {
  if (initialized || typeof window === 'undefined') return
  if (!config.host || !config.projectToken) return
  posthog.init(config.projectToken, buildPosthogInitOptions(config, identity))
  initialized = true
}

/** Whether the client was initialized — i.e. whether events are being sent. */
export const isPosthogEnabled = (): boolean => initialized

/** Capture a product event. No-op when analytics is disabled. */
export const capturePosthog = (event: PostHogEvent, properties?: PostHogProperties): void => {
  if (!initialized) return
  posthog.capture(event, properties)
}

/**
 * Capture a caught exception for error tracking. No-op when disabled.
 *
 * Autocapture (`capture_exceptions` in {@link initPosthogClient}) sees what
 * reaches `window.onerror` and unhandled rejections. An error a React error
 * boundary catches never does: React hands it to the boundary, so the boundary
 * (`app/error.tsx`, `app/global-error.tsx`) reports it here.
 */
export const capturePosthogException = (error: unknown, properties?: PostHogProperties): void => {
  if (!initialized) return
  posthog.captureException(error, properties)
}

/**
 * Associate the session with the authenticated user. The WorkOS user id is the
 * only identity sent: no email, no name, so the profile is a pseudonym that only
 * someone holding WorkOS access can resolve. No-op when disabled.
 */
export const identifyPosthog = (distinctId: string): void => {
  if (!initialized) return
  posthog.identify(distinctId)
}

/**
 * The non-personal context stamped on every following event. A field that is
 * `null`/`undefined` removes its stamp, so a member who switches organization
 * does not carry the old name into the new one.
 */
export interface PostHogContext {
  organizationId?: string | null
  organizationName?: string | null
  role?: string | null
  locale?: string | null
}

const CONTEXT_PROPERTIES = {
  organizationId: 'organization_id',
  organizationName: 'organization_name',
  role: 'user_role',
  locale: 'locale',
} as const satisfies Record<keyof PostHogContext, string>

/**
 * Register {@link PostHogContext} as super properties, or drop the ones that are
 * empty. Super properties rather than groups: see the header. `reset()` clears
 * them with the rest of the identity. No-op when disabled.
 */
export const registerPosthogContext = (context: PostHogContext): void => {
  if (!initialized) return
  const present: Record<string, string> = {}
  for (const key of Object.keys(CONTEXT_PROPERTIES) as Array<keyof PostHogContext>) {
    const value = context[key]
    if (value) present[CONTEXT_PROPERTIES[key]] = value
    else posthog.unregister(CONTEXT_PROPERTIES[key])
  }
  if (Object.keys(present).length > 0) posthog.register(present)
}

/**
 * Stop capturing on this browser, now and on later visits: PostHog persists the
 * choice itself and honours it before anything is queued, recordings included.
 * The profile page's "usage analytics" switch. No-op when disabled.
 */
export const optOutPosthog = (): void => {
  if (!initialized) return
  posthog.opt_out_capturing()
}

/** Resume capturing after {@link optOutPosthog}. No-op when disabled. */
export const optInPosthog = (): void => {
  if (!initialized) return
  posthog.opt_in_capturing()
}

/** Whether this browser has opted out. `false` while analytics is disabled, because nothing is captured anyway. */
export const isPosthogOptedOut = (): boolean => {
  if (!initialized) return false
  return posthog.has_opted_out_capturing()
}

/** Clear the session (sign-out, account switch). No-op when disabled. */
export const resetPosthog = (): void => {
  if (!initialized) return
  posthog.reset()
}

const SESSION_ID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * The id of the current PostHog browser session, or `null` when analytics is
 * disabled or the SDK has none yet. Sent with each chat turn so Langfuse's
 * PostHog export can put the turn's traces on this session's recording
 * (`trace.metadata.$posthog_session_id` -> `$session_id`). Read per turn, not
 * once: the id rotates after 30 idle minutes and on `reset()`.
 *
 * Only a UUID-shaped value is returned. The backend checks it again (UUIDv7)
 * because it is browser input; this side just keeps garbage off the wire.
 */
export const getPosthogSessionId = (): string | null => {
  if (!initialized) return null
  const id = posthog.get_session_id()
  return typeof id === 'string' && SESSION_ID_SHAPE.test(id) ? id : null
}

/**
 * Open a PostHog Support ticket with `message`, always a NEW ticket (each
 * feedback report is its own thread). Resolves `true` only when PostHog took
 * it; `false` when analytics is off, Support is not enabled for the project or
 * not loaded yet, or the request failed. Never throws, because it runs beside
 * the first-party submit and must not be able to fail it.
 *
 * No traits are passed. posthog-js falls back to the person's `email`/`name`
 * properties when none are given; we never set them, so the ticket carries the
 * distinct id and the replay link, nothing else.
 */
export const sendPosthogSupportMessage = async (message: string): Promise<boolean> => {
  if (!initialized) return false
  try {
    const support = posthog.conversations
    if (!support?.isAvailable()) return false
    const response = await support.sendMessage(message, undefined, true)
    return response !== null
  } catch {
    return false
  }
}
