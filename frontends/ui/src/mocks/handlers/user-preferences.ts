/**
 * MSW handlers for the user-preferences endpoint.
 *
 * A default so no test hits the real network for preferences. Several hooks
 * hydrate a preference on mount (theme, the reasoning-skills toggle), and any
 * component that renders one of them — `AgentResponse` renders the
 * reasoning-skills disclosure — fires a GET on mount. With MSW set to
 * `onUnhandledRequest: 'bypass'`, an unhandled GET reaches `localhost` and the
 * refused socket surfaces as an unhandled `AggregateError` that fails the whole
 * run, even though `fetchUserPreferences` itself swallows the error. Answering
 * it here keeps that fetch inside MSW: empty prefs, so every hydration lands on
 * its default. A test that cares about a specific preference overrides this
 * with `server.use(...)`.
 */

import { http, HttpResponse } from 'msw'

export const userPreferencesHandlers = [
  http.get('/api/user/preferences', () => HttpResponse.json({ prefs: {} })),
  http.post('/api/user/preferences', () => HttpResponse.json({ ok: true })),
]
