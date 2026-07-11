/**
 * Error Registry
 *
 * Centralized metadata for all error types used in the chat UI.
 * This registry makes it easy to maintain consistent error messages,
 * icons, and retry behavior across the application.
 */

import type { ErrorCode } from '../types'

/** Metadata for each error type */
export interface ErrorMeta {
  /** Alert status */
  status: 'error' | 'warning' | 'info'
  /** Human-readable title (English fallback when no `titleKey`). */
  title: string
  /** Default message (English fallback when no `messageKey`). */
  defaultMessage: string
  /**
   * `chat`-namespace i18n key for a localized title. When present the banner
   * renders `t(titleKey)` instead of the static English `title`. Optional so a
   * harness/test without an i18n provider still degrades to the English
   * `title` fallback.
   */
  titleKey?: string
  /**
   * `chat`-namespace i18n key for a localized default message. Used by the
   * banner when the caller does not pass an explicit (already-localized)
   * `message`. Optional so the English `defaultMessage` remains the fallback
   * when no provider is present. Interpolation still flows through the
   * caller-supplied `message` for dynamic details (e.g. retry seconds).
   */
  messageKey?: string
}

/**
 * Registry of all error types with their metadata.
 * Add new errors here to maintain consistency across the UI.
 *
 * Localization: every entry carries a `titleKey` + `messageKey` into the
 * `chat` i18n namespace (see `errorRegistry` in the chat dictionary), so the
 * banner renders localized copy for the German-speaking product. The static
 * English `title`/`defaultMessage` stay as fallbacks for a harness/test that
 * renders without an i18n provider. Keys are named per error code, so adding a
 * new code is a matter of adding one registry entry plus its EN/DE dictionary
 * pair — no ad-hoc per-entry wiring in the banner.
 */
export const ERROR_REGISTRY: Record<ErrorCode, ErrorMeta> = {
  // ============================================================
  // Connection Errors
  // ============================================================
  'connection.lost': {
    status: 'error',
    title: 'Connection Lost',
    titleKey: 'errorRegistry.connectionLost.title',
    defaultMessage: 'Lost connection to the server. Please check your network.',
    messageKey: 'errorRegistry.connectionLost.message',
  },
  'connection.failed': {
    status: 'error',
    title: 'Connection Failed',
    titleKey: 'errorRegistry.connectionFailed.title',
    defaultMessage: 'Unable to connect to the server. Please check your network connection.',
    messageKey: 'errorRegistry.connectionFailed.message',
  },
  'connection.timeout': {
    status: 'warning',
    title: 'Request Timeout',
    titleKey: 'errorRegistry.connectionTimeout.title',
    defaultMessage: 'The request took too long to complete.',
    messageKey: 'errorRegistry.connectionTimeout.message',
  },

  // ============================================================
  // Auth Errors
  // ============================================================
  'auth.session_expired': {
    status: 'error',
    title: 'Session Expired',
    titleKey: 'errorRegistry.sessionExpired.title',
    defaultMessage: 'Your session has expired. Please sign in again.',
    messageKey: 'errorRegistry.sessionExpired.message',
  },
  'auth.unauthorized': {
    status: 'error',
    title: 'Unauthorized',
    titleKey: 'errorRegistry.unauthorized.title',
    defaultMessage: 'You do not have permission to perform this action.',
    messageKey: 'errorRegistry.unauthorized.message',
  },

  // ============================================================
  // Agent Errors
  // ============================================================
  'agent.response_failed': {
    status: 'error',
    title: 'Response Failed',
    titleKey: 'errorRegistry.responseFailed.title',
    defaultMessage: 'The assistant encountered an error generating a response.',
    messageKey: 'errorRegistry.responseFailed.message',
  },
  'agent.response_interrupted': {
    status: 'warning',
    title: 'Response Interrupted',
    titleKey: 'errorRegistry.responseInterrupted.title',
    defaultMessage: 'Your previous request was not completed. Please resend your message.',
    messageKey: 'errorRegistry.responseInterrupted.message',
  },
  'agent.workflow_error': {
    status: 'error',
    title: 'Request Failed',
    titleKey: 'errorRegistry.workflowError.title',
    defaultMessage: 'The assistant hit an unexpected error while handling your request. Please try again.',
    messageKey: 'errorRegistry.workflowError.message',
  },
  'agent.deep_research_failed': {
    status: 'error',
    title: 'Deep Research Failed',
    titleKey: 'errorRegistry.deepResearchFailed.title',
    defaultMessage: 'The deep research process encountered an error.',
    messageKey: 'errorRegistry.deepResearchFailed.message',
  },
  'agent.deep_research_load_failed': {
    status: 'error',
    title: 'Research Data Unavailable',
    titleKey: 'errorRegistry.deepResearchLoadFailed.title',
    defaultMessage: 'Unable to load research data. The job may have expired or been deleted.',
    messageKey: 'errorRegistry.deepResearchLoadFailed.message',
  },

  // ============================================================
  // Budget Errors
  // ============================================================
  // Distinct from a network outage: the chat WS upgrade was refused because an
  // applicable LLM budget scope is exhausted. Non-retryable until an admin
  // raises the limit, so it must not read like a transient connection failure.
  // Title is localized via `titleKey`; the actionable message (member vs admin)
  // is supplied by the caller, already localized, so there is no `messageKey`.
  'budget.exhausted': {
    status: 'error',
    title: 'Budget exhausted',
    titleKey: 'budgetExhausted.title',
    defaultMessage:
      'Your LLM budget is exhausted. You can review your usage under Organization → Usage & budgets.',
  },

  // ============================================================
  // System Errors
  // ============================================================
  'system.unknown': {
    status: 'error',
    title: 'Something Went Wrong',
    titleKey: 'errorRegistry.unknown.title',
    defaultMessage: 'An unexpected error occurred. Please try again.',
    messageKey: 'errorRegistry.unknown.message',
  },
}

/**
 * Get error metadata by code.
 * Falls back to system.unknown if code not found.
 */
export const getErrorMeta = (code: ErrorCode): ErrorMeta => {
  return ERROR_REGISTRY[code] || ERROR_REGISTRY['system.unknown']
}
