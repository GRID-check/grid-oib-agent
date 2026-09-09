/**
 * PostHog product analytics — fail-open client wrapper.
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
 * `identifyPosthog` / `resetPosthog` directly and never touch `posthog-js`
 * or branch on configuration themselves.
 */

import posthog from 'posthog-js'

type PostHogProperties = Record<string, string | number | boolean | null | undefined>

/**
 * PostHog analytics configuration (fail-open). Empty host or token disables
 * the client. Produced server-side per request (layout `getAppConfig`) and
 * carried to the browser through `AppConfig`, so no rebuild is needed to
 * repoint a deployment.
 */
export interface PostHogConfig {
  /** Public PostHog host (e.g. `https://eu.i.posthog.com`). Empty = disabled. */
  host: string
  /** Public project token (`phc_…`). Empty = disabled. */
  projectToken: string
}

/**
 * Product events the UI emits. A closed union so a typo'd event name fails
 * the build instead of silently creating a second, almost-identical event in
 * PostHog. Add the name here when a call site starts emitting a new one.
 */
export type PostHogEvent =
  | 'organization_created'
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

let initialized = false

/** The disabled config: no host/token, every function below no-ops. */
export const DISABLED_POSTHOG_CONFIG: PostHogConfig = {
  host: '',
  projectToken: '',
}

/**
 * Initialize the browser PostHog session. Idempotent — safe to call on every
 * render. No-op without both values (analytics disabled) and outside the
 * browser (server-side import safety).
 */
export const initPosthogClient = (host: string, projectToken: string): void => {
  if (initialized || typeof window === 'undefined') return
  if (!host || !projectToken) return
  posthog.init(projectToken, {
    api_host: host,
    defaults: '2026-01-30',
    capture_exceptions: {
      capture_unhandled_errors: true,
      capture_unhandled_rejections: true,
      capture_console_errors: false,
    },
    debug: process.env.NODE_ENV === 'development',
  })
  initialized = true
}

/** Whether the client was initialized — i.e. whether events are being sent. */
export const isPosthogEnabled = (): boolean => initialized

/** Capture a product event. No-op when analytics is disabled. */
export const capturePosthog = (event: PostHogEvent, properties?: PostHogProperties): void => {
  if (!initialized) return
  posthog.capture(event, properties)
}

/** Associate the session with the authenticated user. No-op when disabled. */
export const identifyPosthog = (distinctId: string, traits?: PostHogProperties): void => {
  if (!initialized) return
  posthog.identify(distinctId, traits)
}

/** Clear the session (sign-out, account switch). No-op when disabled. */
export const resetPosthog = (): void => {
  if (!initialized) return
  posthog.reset()
}
