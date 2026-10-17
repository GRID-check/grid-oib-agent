import type { APIRoute } from 'astro'
import { CONTACT_EMAIL } from '../../consts'
import { clientIp, handleContact, issueToken, readConfig } from '../../lib/contact.ts'

/**
 * The contact form's endpoint for a browser that runs the form's script.
 *
 * GET hands out the signed timestamp. The landing page is prerendered at build
 * time, so a timestamp in its HTML would be the build's; the script asks here
 * when the page loads instead. POST checks and sends, and answers JSON:
 * `{ outcome, fields? }` with the status from `STATUS` in `lib/contact.ts`.
 * A browser without script posts to `/kontakt/` instead, which renders a page.
 */
export const prerender = false

const json = (body: object, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers },
  })

export const GET: APIRoute = () => {
  const config = readConfig(process.env, CONTACT_EMAIL)
  if (!config) return json({ outcome: 'config' }, 503)
  return json({ token: issueToken(config.secret) }, 200)
}

export const POST: APIRoute = async ({ request, clientAddress }) => {
  const result = await handleContact(request, {
    env: process.env,
    defaultFrom: CONTACT_EMAIL,
    fetch,
    ip: clientIp(request.headers, clientAddress),
  })
  const retry: Record<string, string> = result.outcome === 'rate_limited' ? { 'Retry-After': '600' } : {}
  return json({ outcome: result.outcome, fields: result.fields }, result.status, retry)
}
