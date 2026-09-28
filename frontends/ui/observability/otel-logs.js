/**
 * Shared OTLP log bridge for the Node tiers (grid-ui BFF, workflow-scheduler,
 * purger) — ADR-0029 "future signal adoption is app-only work".
 *
 * Every tier logs with plain `console.*`; this module bridges those calls to
 * OTel log records so they land in the Aspire dashboard's "Strukturierte
 * Protokolle" next to the Python tiers' logs. The original console output is
 * preserved (kubectl logs keeps working).
 *
 * Severity follows the console method, with the exceptions listed at
 * NOT_AN_ERROR below — a few record shapes reach `console.error` without being
 * application errors, and ERROR is precisely what err2issue turns into a
 * GitHub issue.
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
 *   GRID_GIT_SHA                - resource service.version: the commit the image
 *     was built from (stamped by the Dockerfile). err2issue shows it as the
 *     issue's "Version"; without it a regression on a closed issue could not be
 *     told apart from a pod still running the image from before the fix.
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

// severityNumber/severityText per the OTel logs data model.
const SEVERITY = {
  debug: { severityNumber: 5, severityText: 'DEBUG' },
  log: { severityNumber: 9, severityText: 'INFO' },
  info: { severityNumber: 9, severityText: 'INFO' },
  warn: { severityNumber: 13, severityText: 'WARN' },
  error: { severityNumber: 17, severityText: 'ERROR' },
}

/**
 * Records that arrive on `console.error` without being application errors.
 *
 * ERROR is not a cosmetic level here: the collector drops everything below it
 * before the err2issue exporter (`deploy/pulumi/src/platform/otel-collector.ts`,
 * ADR-0031), so an ERROR record opens a GitHub issue while a WARN record still
 * reaches the Aspire dashboard in full. Nothing on this list is dropped or
 * sampled away — it is recorded at the severity it actually has, which is the
 * difference between "visible in the logs" and "someone is paged about it".
 *
 * Each entry earns its place with a real misfiled issue, and each is anchored
 * tightly enough that an application error cannot drift into it. When a pattern
 * stops matching (a Node or Next format change), the record simply stays ERROR:
 * this list fails towards reporting, never towards silence.
 */
const NOT_AN_ERROR = [
  {
    // Node prints its process warnings through `console.error` — the default
    // 'warning' handler in `lib/internal/process/warning.js` does exactly that
    // — so what reaches this bridge is a WARNING that merely chose the error
    // stream. Issue #230 was DEP0060 (`util._extend`, raised by http-proxy
    // 1.18.1 on the first request each pod proxies) filed nine times. Matching
    // Node's own prefix, anchored at the start of the record, means an
    // application error would have to open with a literal "(node:<pid>)
    // …Warning: " to be caught by this.
    reason: 'node-process-warning',
    match: /^\(\w+:\d+\) (\[[A-Z0-9_]+\] )?\w*Warning: /,
  },
  {
    // A 404 the application raised on purpose. `NotFoundError`
    // (`@/lib/api/errors`) is how every service answers "missing, or you may
    // not see it" — tenancy and permission denials included, so a response
    // never leaks whether a resource exists — and `errorResponse` in
    // `@/lib/api/handler` deliberately logs no `ApiError` at all: an expected
    // outcome is not a failure. A page render has no such wrapper, so the same
    // error escaping a server component is reported by Next's own error logger
    // and reached this bridge as ERROR (issue #262). The 404 the visitor got
    // was the correct answer; only the severity was wrong.
    //
    // Deliberately narrow: it matches the `ApiError` field envelope Node's
    // inspect output prints (status before code, the order the constructor
    // assigns them) and only for NOT_FOUND, so a 5xx, an upstream failure, or
    // any other code is untouched. A 404 that IS a bug — a server-side read of
    // something that should exist — is still recorded here in full, it just no
    // longer files an issue on its own; the signal that distinguishes it from a
    // visitor following a stale link is volume, which the dashboard shows and
    // a per-occurrence severity cannot.
    reason: 'expected-404',
    match: /status: 404,\s+code: 'NOT_FOUND'/,
  },
  {
    // The browser left while a page or RSC payload was still streaming: it
    // navigated away, or a prefetch was cancelled. React's server renderer
    // aborts the render with exactly this reason when the response it writes
    // to closes (`destination.on("close", …)` in react-server-dom-*), and Next
    // logs it with ⨯ because its `isAbortError` knows only the names
    // AbortError and ResponseAborted. It has no stack and no route because
    // React made the error itself. #578 filed it 28 times. The render stopped
    // because nobody was reading it, which is not an application error.
    // Anchored to the whole sentence Next prints, so an application error
    // would have to reuse React's wording to be caught.
    reason: 'client-disconnect',
    match: /^⨯ Error: The destination stream closed early\.(\s|$)/,
  },
  {
    // A page render that failed because the database was unreachable. The
    // outage itself is an ERROR, filed once by the API wrapper's fixed
    // `[db] database unavailable (<code>)` line (`lib/api/handler.ts`); this is
    // the same outage reported again by Next's own logger for every page that
    // rendered during it, each with its own query text, which is how one
    // restart became #734 and #737-#739 beside the API's own. Matched on the
    // driver's cause code as Node's inspect prints it, and only under a
    // `Failed query` that Next logged, so a bad query stays an ERROR.
    reason: 'database-unavailable-render',
    match:
      /^⨯ Error: Failed query:[\s\S]*\[cause\]:[\s\S]*code: '(08[0-9A-Z]{3}|57P0[123]|ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|CONNECTION_CLOSED|CONNECTION_ENDED|CONNECTION_DESTROYED|CONNECT_TIMEOUT)'/,
  },
]

/**
 * Severity for one console record: the console method's own level, unless the
 * body is one of the {@link NOT_AN_ERROR} shapes, which are recorded at WARN.
 */
function classifyConsoleRecord(method, body) {
  const known = method === 'error' && NOT_AN_ERROR.find((entry) => entry.match.test(body))
  if (!known) return SEVERITY[method]
  return { ...SEVERITY.warn, attributes: { 'grid.severity.reclassified': known.reason } }
}

/** Resource attributes for every exported record: which tier, which build. */
function resourceAttributes(env) {
  const attributes = { 'service.name': env.OTEL_SERVICE_NAME || 'grid-ui' }
  const sha = String(env.GRID_GIT_SHA ?? '').trim()
  if (sha) attributes['service.version'] = sha
  return attributes
}

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

  const resource = defaultResource().merge(resourceFromAttributes(resourceAttributes(process.env)))
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
        const body = util.format(...args)
        logger.emit({ ...classifyConsoleRecord(method, body), body })
      } catch {
        // Telemetry must never break the app.
      }
    }
  }
  return true
}

module.exports = { classifyConsoleRecord, initOtelLogs, logsUrl, resourceAttributes }
