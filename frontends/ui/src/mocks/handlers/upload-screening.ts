/**
 * MSW handler for the office's upload-screening policy (ADR-0086).
 *
 * Every upload path reads the policy before it sends anything, and a policy
 * that cannot be read sends nothing: the browser no longer screens with
 * Piloti's suggestion in its place. A test that renders an upload surface
 * therefore needs an answer here, or every upload in it is refused. The
 * default is an office that kept Piloti's suggested list. A test that cares
 * about a specific policy, or about the policy being unreadable, overrides
 * this with `server.use(...)`.
 */

import { http, HttpResponse } from 'msw'
import { SUGGESTED_SCREENING_POLICY } from '@/lib/upload-screening/policy'

export const uploadScreeningHandlers = [
  http.get('/api/organization/upload-screening', () =>
    HttpResponse.json({ policy: SUGGESTED_SCREENING_POLICY, suggested: true, suggestion: SUGGESTED_SCREENING_POLICY })
  ),
]
