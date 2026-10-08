/**
 * MSW default for reading one conversation.
 *
 * The composer reads the server's record of the other projects that restrict
 * the open chat (`restrictingOtherProjects`) on mount and when a turn ends, so
 * any test that renders it fires a GET. Unhandled, that reaches `localhost` and
 * the refused socket surfaces as an unhandled `AggregateError` (see
 * `user-preferences.ts`). A 404 is the server's own answer for a chat it does
 * not have, and the reader keeps whatever it showed. A test that cares
 * overrides this with `server.use(...)`.
 */

import { http, HttpResponse } from 'msw'

export const conversationHandlers = [
  http.get('/api/conversations/:id', () => HttpResponse.json({ error: 'Not found' }, { status: 404 })),
]
