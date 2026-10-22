/**
 * PostHog from the BFF — the server-side twin of `posthog.ts` (ADR-0100).
 *
 * Every server path that sends something to PostHog (a server-decided product
 * event) goes through this module, so there is one place that decides whether
 * PostHog is on and how a server event is shaped. Request errors are the one
 * path with a client of its own, `@posthog/next`'s (`request-error.ts`), and it
 * takes its settings and its scrubber from here.
 *
 * Fail-open like the browser client: it reads the same
 * `NEXT_PUBLIC_POSTHOG_HOST` / `NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN` the layout
 * hands the browser, and with either unset every function is a no-op. The
 * project token is public by design, so the server needs no secret of its own
 * to capture.
 *
 * Server events carry no GeoIP: the caller is our cluster, not the user, so a
 * lookup would attribute every event to the data centre. They carry the
 * deployed commit and the service as super properties (`register`), and a
 * system event has no distinct id at all: posthog-node then sends it under a
 * fresh id with `$process_person_profile: false`, so no person is minted.
 */
import 'server-only'

import { PostHog } from 'posthog-node'

import { configuredAppOrigin } from '@/lib/app-origin'
import { deployedSha } from '@/lib/boot'

import { scrubServerEvent } from './scrub-server-event'

type ServerProperties = Record<string, unknown>

/** What a server event may carry: scalars only, so a nested object cannot smuggle free text. */
export type ServerEventProperties = Record<string, string | number | boolean | null | undefined>

/**
 * Product events the BFF emits, a closed union like the browser's
 * `PostHogEvent` (`posthog.ts`) so a typo'd name fails the build instead of
 * minting a second, almost-identical event in PostHog. Add the name here when a
 * call site starts emitting a new one, and its row to
 * `docs/observability/posthog-events.md`.
 *
 * These are the events the server is the truth for: the browser cannot see
 * them (a scheduled run, an ingest finishing), or could be wrong or blocked by
 * an ad blocker (a sign-in, an organization created, a budget refusal).
 *
 * Properties are non-personal by rule: ids of our own rows, kinds, counts,
 * durations and statuses. Never a document name, a question, an email, a URL.
 */
export type ServerEvent =
  | 'user_signed_in'
  | 'organization_created'
  | 'resource_shared'
  | 'task_assigned'
  | 'mention_released'
  | 'job_run_started'
  | 'job_run_finished'
  | 'document_ingest_finished'
  | 'bim_query_executed'
  | 'budget_blocked'
  | 'budget_threshold_crossed'
  | 'push_device_registered'
  | 'push_device_removed'
  | 'push_notification_sent'
  | 'annotation_due_reminders_sent'
  | 'annotation_created'
  | 'annotation_closed'
  | 'annotation_carried'
  | 'llm_usage_hourly'
  | 'organization_budget_snapshot'
  | 'agent_operation_called'
  | 'agent_operation_missing'
  | 'product_feedback_ticket_opened'
  | 'product_feedback_reply_sent'
  // The E-Mail-Eingang (ADR-0134). Codes, counts and buckets only: a mail is a
  // stranger's, and no sender, subject, file name or address is ever a property.
  | 'inbound_mail_received'
  | 'inbound_mail_refused'
  | 'inbound_mail_dropped'
  | 'inbound_mail_decided'
  | 'inbound_mail_address_rotated'
  | 'mail_thread_followed'
  | 'mail_thread_original_downloaded'

let client: PostHog | null = null
let resolved = false

/** The host and project token, read at call time; `null` unless both are set. */
export const posthogServerSettings = (): { host: string; projectToken: string } | null => {
  const host = (process.env.NEXT_PUBLIC_POSTHOG_HOST ?? '').trim().replace(/\/+$/, '')
  const projectToken = (process.env.NEXT_PUBLIC_POSTHOG_PROJECT_TOKEN ?? '').trim()
  if (!host || !projectToken) return null
  return { host, projectToken }
}

/** Whether the BFF sends anything to PostHog: both settings reached it. */
export const isPosthogServerEnabled = (): boolean => posthogServerSettings() !== null

/**
 * What every server event carries: the deployed commit, which process sent it,
 * and which deployment it came from. Staging and production share one PostHog
 * project and both run `APP_ENV=production`, so `app_host` (the app's own host,
 * from the pinned redirect URI) is what tells their server events apart, the
 * way `$host` does for the browser's. Absent when the deployment pins no origin.
 */
export const serverSuperProperties = (): { release: string; service: string; app_host?: string } => {
  const origin = configuredAppOrigin()
  return {
    release: deployedSha(),
    service: process.env.OTEL_SERVICE_NAME ?? 'grid-ui',
    ...(origin ? { app_host: new URL(origin).host } : {}),
  }
}

/** The process-wide client, built on first use; `null` while PostHog is off. */
export const getPosthogServer = (): PostHog | null => {
  if (resolved) return client
  const config = posthogServerSettings()
  if (config) {
    client = new PostHog(config.projectToken, {
      host: config.host,
      disableGeoip: true,
      // Every event passes the scrubber last, whichever path queued it: a
      // credential in a URL must not depend on each caller remembering.
      before_send: scrubServerEvent,
      // Batch small: the BFF is long-lived, but a scale-down must not lose a
      // feedback vote that sat in a large buffer.
      flushAt: 20,
      flushInterval: 5_000,
    })
    // Synchronous for this client (memory persistence is ready at construction).
    void client.register(serverSuperProperties())
  }
  resolved = true
  return client
}

export interface ServerCapture {
  event: ServerEvent
  /** The acting WorkOS user id. `null` sends a personless event (no person minted): a system action. */
  distinctId: string | null
  /**
   * The WorkOS organization the event happened in, sent as the
   * `organization_id` property. A property rather than a PostHog group: group
   * analytics is a paid add-on, and the browser registers the same property.
   */
  organizationId?: string | null
  properties?: ServerEventProperties
}

/**
 * Queue one event; whether it was queued. Never throws, and returns before
 * anything is sent (the client batches), so a call site can call it inline and
 * ignore the answer: a failure here must not change a route's behaviour or
 * latency.
 */
export const captureServer = ({ event, distinctId, organizationId, properties }: ServerCapture): boolean => {
  const posthog = getPosthogServer()
  if (!posthog) return false
  const props: ServerProperties = { ...properties }
  if (organizationId) props.organization_id = organizationId
  try {
    // No distinct id for a system action: posthog-node makes the event personless.
    posthog.capture({ event, distinctId: distinctId ?? undefined, properties: props })
    return true
  } catch (error) {
    console.debug('[posthog] could not queue event', event, error)
    return false
  }
}

/**
 * A client of its own for one export run (`usage-export.ts`), unlike the shared
 * fire-and-forget one: it never flushes by itself, so every event reaches
 * PostHog through `flush()`, which rejects when the send failed. The export only
 * moves its cursor after that resolves, which is what keeps an hour from being
 * lost or sent twice. Each event carries its own `timestamp` (the hour it sums)
 * and is personless. `null` while PostHog is off.
 */
export interface PosthogBatch {
  capture(event: ServerCapture & { timestamp: Date }): void
  /** Send what is queued; rejects when PostHog did not take it. */
  flush(): Promise<void>
  close(): Promise<void>
}

/** Larger than the exporter's flush chunk, so nothing queued is ever dropped. */
const BATCH_QUEUE_LIMIT = 2_000

export const createPosthogBatch = (): PosthogBatch | null => {
  const config = posthogServerSettings()
  if (!config) return null
  const posthog = new PostHog(config.projectToken, {
    host: config.host,
    disableGeoip: true,
    before_send: scrubServerEvent,
    flushAt: BATCH_QUEUE_LIMIT,
    flushInterval: 0,
    maxQueueSize: BATCH_QUEUE_LIMIT,
  })
  void posthog.register(serverSuperProperties())
  return {
    capture: ({ event, distinctId, organizationId, properties, timestamp }) => {
      const props: ServerProperties = { ...properties }
      if (organizationId) props.organization_id = organizationId
      posthog.capture({ event, distinctId: distinctId ?? undefined, properties: props, timestamp })
    },
    flush: () => posthog.flush(),
    close: async () => {
      try {
        await posthog.shutdown()
      } catch (error) {
        console.debug('[posthog] export client shutdown failed', error)
      }
    },
  }
}

/** Flush and stop. Called from the shutdown path; safe to call twice. */
export const shutdownPosthogServer = async (): Promise<void> => {
  if (!client) return
  try {
    await client.shutdown()
  } catch (error) {
    console.debug('[posthog] shutdown failed', error)
  }
}

/** Forget the cached client so a spec can change the environment. */
export const resetPosthogServerForTests = (): void => {
  client = null
  resolved = false
}
