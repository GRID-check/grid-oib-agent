/**
 * What the contact form tells the visitor for each server outcome
 * (`Outcome` in `lib/contact.ts`). Its own module, free of `node:` imports,
 * because the browser script and the server page both read it.
 *
 * Every refusal a person could cause by accident (a timestamp too old, too
 * new or missing) asks them to send again; everything else that failed shows
 * the mail address, so a message is never stuck behind the form.
 */
export type ContactStatus = 'sent' | 'invalid' | 'retry' | 'rateLimited' | 'failed'

export function statusFor(outcome: string | undefined): ContactStatus {
  switch (outcome) {
    case 'sent':
      return 'sent'
    case 'invalid':
      return 'invalid'
    case 'token_missing':
    case 'token_expired':
    case 'too_fast':
      return 'retry'
    case 'rate_limited':
      return 'rateLimited'
    default:
      return 'failed'
  }
}

/** A message split around `{email}`, so either side can put a mailto link there. */
export function splitEmail(message: string): [string, string] | [string] {
  const at = message.indexOf('{email}')
  return at < 0 ? [message] : [message.slice(0, at), message.slice(at + '{email}'.length)]
}
