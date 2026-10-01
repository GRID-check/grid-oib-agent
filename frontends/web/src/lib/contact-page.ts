import { CONTACT_EMAIL } from '../consts'
import type { Locale } from '../i18n/ui'
import { getLocalizedPath } from '../i18n/utils'
import { clientIp, handleContact, issueToken, readConfig, type FieldError, type FieldName, type Values } from './contact.ts'
import { statusFor, type ContactStatus } from './contact-status.ts'

/** What `/kontakt/` renders: the form's props, and the HTTP status to answer with. */
export interface ContactPageState {
  status: number
  form: {
    token?: string
    values?: Partial<Values>
    fields?: Partial<Record<FieldName, FieldError>>
    status?: ContactStatus
  }
}

/** Where a sent message lands: the page again, saying so, and safe to reload. */
export const sentPath = (locale: Locale) => `${getLocalizedPath('/kontakt/', locale)}?gesendet`

/**
 * `/kontakt/` for a browser without script. GET renders the form with a fresh
 * timestamp; POST runs the same checks as `/api/kontakt` and either redirects
 * (303, so a reload does not send twice) or renders the form again with what
 * was entered, what went wrong, and a new timestamp. A form posted from the
 * prerendered landing page arrives without a timestamp; it comes back filled
 * in, asking to be sent once more.
 */
export async function contactPage(request: Request, clientAddress: string, url: URL, locale: Locale) {
  const config = readConfig(process.env, CONTACT_EMAIL)
  const token = config ? issueToken(config.secret) : undefined
  if (request.method !== 'POST') {
    const state: ContactPageState = { status: 200, form: { token, status: url.searchParams.has('gesendet') ? 'sent' : undefined } }
    return state
  }
  const result = await handleContact(request, {
    env: process.env,
    defaultFrom: CONTACT_EMAIL,
    fetch,
    ip: clientIp(request.headers, clientAddress),
  })
  if (result.outcome === 'sent') return { redirect: sentPath(locale) }
  const status = statusFor(result.outcome)
  // Asking to send again is not an error: the page answers 200 then.
  const state: ContactPageState = {
    status: status === 'retry' ? 200 : result.status,
    form: { token, values: result.values, fields: result.fields, status },
  }
  return state
}
