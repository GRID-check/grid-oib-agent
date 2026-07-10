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
  /** Default message if none provided */
  defaultMessage: string
  /**
   * Optional `chat`-namespace i18n key for a localized title. When present the
   * banner renders `t(titleKey)` instead of the static English `title`. Kept
   * optional so existing codes keep their current (English) titles unchanged.
   */
  titleKey?: string
}

/**
 * Registry of all error types with their metadata.
 * Add new errors here to maintain consistency across the UI.
 */
export const ERROR_REGISTRY: Record<ErrorCode, ErrorMeta> = {
  // ============================================================
  // Connection Errors
  // ============================================================
  'connection.lost': {
    status: 'error',
    title: 'Connection Lost',
    defaultMessage: 'Lost connection to the server. Please check your network.',
  },
  'connection.failed': {
    status: 'error',
    title: 'Connection Failed',
    defaultMessage: 'Unable to connect to the server. Please check your network connection.',
  },
  'connection.timeout': {
    status: 'warning',
    title: 'Request Timeout',
    defaultMessage: 'The request took too long to complete.',
  },

  // ============================================================
  // Auth Errors
  // ============================================================
  'auth.session_expired': {
    status: 'error',
    title: 'Session Expired',
    defaultMessage: 'Your session has expired. Please sign in again.',
  },
  'auth.unauthorized': {
    status: 'error',
    title: 'Unauthorized',
    defaultMessage: 'You do not have permission to perform this action.',
  },

  // ============================================================
  // Agent Errors
  // ============================================================
  'agent.response_failed': {
    status: 'error',
    title: 'Response Failed',
    defaultMessage: 'The assistant encountered an error generating a response.',
  },
  'agent.response_interrupted': {
    status: 'warning',
    title: 'Response Interrupted',
    defaultMessage: 'Your previous request was not completed. Please resend your message.',
  },
  'agent.workflow_error': {
    status: 'error',
    title: 'Request Failed',
    defaultMessage: 'The assistant hit an unexpected error while handling your request. Please try again.',
  },
  'agent.deep_research_failed': {
    status: 'error',
    title: 'Deep Research Failed',
    defaultMessage: 'The deep research process encountered an error.',
  },
  'agent.deep_research_load_failed': {
    status: 'error',
    title: 'Research Data Unavailable',
    defaultMessage: 'Unable to load research data. The job may have expired or been deleted.',
  },

  // ============================================================
  // Budget Errors
  // ============================================================
  // Distinct from a network outage: the chat WS upgrade was refused because an
  // applicable LLM budget scope is exhausted. Non-retryable until an admin
  // raises the limit, so it must not read like a transient connection failure.
  // Title is localized via `titleKey`; the actionable message (member vs admin)
  // is supplied by the caller, already localized.
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
    defaultMessage: 'An unexpected error occurred. Please try again.',
  },
}

/**
 * Get error metadata by code.
 * Falls back to system.unknown if code not found.
 */
export const getErrorMeta = (code: ErrorCode): ErrorMeta => {
  return ERROR_REGISTRY[code] || ERROR_REGISTRY['system.unknown']
}
