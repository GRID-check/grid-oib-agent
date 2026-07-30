/**
 * Platform → answer feedback → the plain-language digest.
 *
 * Its own route rather than a field on the health response, because the two have
 * different costs and different failure modes: the numbers are four SQL queries
 * and always arrive, the digest is an LLM call that can time out. Folding it in
 * would make a slow model delay a page that does not need it, and a broken model
 * take that page down with it.
 *
 * Declared through `apiRoute` (ADR-0017) like its siblings, so session auth and
 * error mapping live in the factory; the owner gate itself is inside
 * `getAnswerFeedbackDigest`, and the only translation left is the typed denial.
 */

import { NextResponse } from 'next/server'
import { ForbiddenError } from '@/lib/api/errors'
import { apiRoute } from '@/lib/api/handler'
import { PlatformAccessDeniedError } from '@/lib/authz/platform'
import { getAnswerFeedbackDigest } from '@/lib/feedback/service'
import { parseFeedbackFilters } from '@/lib/feedback/query'

export const GET = apiRoute(async ({ request, session }) => {
  const params = new URL(request.url).searchParams
  const filters = parseFeedbackFilters(params)
  try {
    const result = await getAnswerFeedbackDigest(session, filters, {
      locale: params.get('locale') ?? 'de',
      refresh: params.get('refresh') === '1',
    })

    // 200 even when there is no digest. `no_feedback` and `too_few_votes` are
    // ordinary states of a young window, and the client renders a sentence for
    // each — a 4xx would send it down the "something is broken" path instead.
    //
    // Returned as a Response rather than a plain object only for the header: the
    // digest is cached server-side with its own TTL, and a browser cache on top
    // would make the refresh button lie.
    return NextResponse.json(result, { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    if (error instanceof PlatformAccessDeniedError) throw new ForbiddenError()
    throw error
  }
})
