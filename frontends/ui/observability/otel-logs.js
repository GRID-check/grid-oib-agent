/**
 * Shared OTLP log bridge for the Node tiers (grid-ui BFF, workflow-scheduler,
 * purger) — ADR-0029 "future signal adoption is app-only work".
 *
 * Every tier logs with plain `console.*`; this module bridges those calls to
 * OTel log records so they land in the Aspire dashboard's "Strukturierte
 * Protokolle" next to the Python tiers' logs. The original console output is
 * preserved (kubectl logs keeps working).
 *
 * Capability doctrine: no OTEL_EXPORTER_OTLP_ENDPOINT (local dev, compose
 * without the observability tier) => clean no-op, zero overhead. There is no
 * separate opt-in flag.
 *
 * Environment:
 *   OTEL_EXPORTER_OTLP_ENDPOINT - collector BASE URL (http://otel-collector:4318);
 *     the /v1/logs signal path is derived (any /v1/traces suffix is replaced,
 *     so the backend-style full path works too).
 *   OTEL_SERVICE_NAME           - resource service.name (default "grid-ui").
 */

const util = require('node:util')

let initialized = false

/** Derive the OTLP/HTTP logs URL from the configured endpoint (base or traces path). */
function logsUrl(endpoint) {
  const trimmed = String(endpoint).trim().replace(/\/+$/, '')
  if (trimmed.endsWith('/v1/logs')) return trimmed
  if (trimmed.endsWith('/v1/traces')) return `${trimmed.slice(0, -'/v1/traces'.length)}/v1/logs`
  return `${trimmed}/v1/logs`
}

// severityNumber per the OTel logs data model.
const SEVERITY = { debug: 5, log: 9, info: 9, warn: 13, error: 17 }

/**
 * Initialize OTLP log export and patch console.* to also emit OTel log
 * records. Idempotent. Returns true when export was enabled.
 */
function initOtelLogs() {
  if (initialized) return false
  const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT
  if (!endpoint || !endpoint.trim()) return false
  initialized = true

  const { logs } = require('@opentelemetry/api-logs')
  const { OTLPLogExporter } = require('@opentelemetry/exporter-logs-otlp-http')
  const { BatchLogRecordProcessor, LoggerProvider } = require('@opentelemetry/sdk-logs')
  const { defaultResource, resourceFromAttributes } = require('@opentelemetry/resources')

  const resource = defaultResource().merge(
    resourceFromAttributes({ 'service.name': process.env.OTEL_SERVICE_NAME || 'grid-ui' }),
  )
  const provider = new LoggerProvider({
    resource,
    // SDK 2.x: the exporter goes in an options object — positional
    // construction leaves _exporter undefined and every flush throws inside
    // the processor (swallowed by diag), silently dropping all records.
    processors: [new BatchLogRecordProcessor({ exporter: new OTLPLogExporter({ url: logsUrl(endpoint) }) })],
  })
  logs.setGlobalLoggerProvider(provider)

  const logger = logs.getLogger('grid-console')
  for (const method of Object.keys(SEVERITY)) {
    const original = console[method].bind(console)
    console[method] = (...args) => {
      original(...args)
      try {
        logger.emit({
          severityNumber: SEVERITY[method],
          severityText: method === 'log' ? 'INFO' : method.toUpperCase(),
          body: util.format(...args),
        })
      } catch {
        // Telemetry must never break the app.
      }
    }
  }
  return true
}

module.exports = { initOtelLogs, logsUrl }
