/**
 * The contact form, enhanced: the signed timestamp fetched from the endpoint
 * (the landing page is prerendered, so its HTML cannot carry one), the fields
 * checked here with the site's own messages, the send done with fetch, and the
 * outcome said in the form's live region.
 *
 * Focus follows the outcome: to the first field that needs attention, or to
 * the status line. Nothing moves or fades; the words carry the change.
 * Without this script the form still posts to `/kontakt/` and works.
 */
import { splitEmail, statusFor, type ContactStatus } from '../lib/contact-status'

interface Messages {
  endpoint: string
  email: string
  sending: string
  submit: string
  errors: Record<'required' | 'email' | 'too_long', string>
  status: Record<ContactStatus, string>
}

type Field = HTMLInputElement | HTMLTextAreaElement
const FIELDS = ['name', 'email', 'office', 'message'] as const

function enhance(form: HTMLFormElement) {
  const messages = JSON.parse(form.dataset.contact ?? '{}') as Messages
  const token = form.elements.namedItem('token') as HTMLInputElement
  const status = form.querySelector<HTMLElement>('[role="status"]')
  const button = form.querySelector<HTMLButtonElement>('button[type="submit"]')
  if (!status || !button) return

  form.noValidate = true
  const refresh = () => fetchToken(messages.endpoint).then((t) => t && (token.value = t))
  if (!token.value) void refresh()

  for (const name of FIELDS) {
    field(form, name).addEventListener('input', () => showError(form, name, undefined, messages))
  }

  let busy = false
  form.addEventListener('submit', async (event) => {
    event.preventDefault()
    if (busy) return
    const invalid = checkFields(form, messages)
    if (invalid) {
      say(status, 'invalid', messages)
      invalid.focus()
      return
    }
    busy = true
    button.setAttribute('aria-busy', 'true')
    button.textContent = messages.sending
    const answer = await send(form, messages.endpoint)
    busy = false
    button.removeAttribute('aria-busy')
    button.textContent = messages.submit
    await settle(form, answer, status, messages, refresh)
  })
}

async function settle(
  form: HTMLFormElement,
  answer: { outcome?: string; fields?: Record<string, string> },
  status: HTMLElement,
  messages: Messages,
  refresh: () => Promise<unknown>,
) {
  const kind = statusFor(answer.outcome)
  if (kind === 'invalid' && answer.fields) {
    const first = FIELDS.find((name) => answer.fields?.[name])
    for (const name of FIELDS) showError(form, name, answer.fields[name], messages)
    say(status, kind, messages)
    if (first) return field(form, first).focus()
  }
  if (kind === 'sent') form.reset()
  // A used or stale timestamp is spent either way: the next message needs a new one.
  if (kind === 'sent' || kind === 'retry') await refresh()
  say(status, kind, messages)
  status.focus()
}

async function fetchToken(endpoint: string) {
  try {
    const res = await fetch(endpoint, { headers: { Accept: 'application/json' }, cache: 'no-store' })
    return res.ok ? ((await res.json()) as { token?: string }).token : undefined
  } catch {
    return undefined
  }
}

async function send(form: HTMLFormElement, endpoint: string) {
  const body = new URLSearchParams()
  for (const [key, value] of new FormData(form)) body.append(key, String(value))
  try {
    const res = await fetch(endpoint, { method: 'POST', headers: { Accept: 'application/json' }, body })
    return (await res.json()) as { outcome?: string; fields?: Record<string, string> }
  } catch {
    return { outcome: 'network' }
  }
}

function field(form: HTMLFormElement, name: string) {
  return form.elements.namedItem(name) as Field
}

/** Marks every field the browser finds invalid; returns the first. */
function checkFields(form: HTMLFormElement, messages: Messages) {
  let first: Field | undefined
  for (const name of FIELDS) {
    const el = field(form, name)
    const blank = el.required && el.value.trim() === ''
    const kind = blank || el.validity.valueMissing ? 'required' : el.validity.typeMismatch ? 'email' : el.validity.tooLong ? 'too_long' : undefined
    showError(form, name, kind, messages)
    if (kind && !first) first = el
  }
  return first
}

function showError(form: HTMLFormElement, name: string, kind: string | undefined, messages: Messages) {
  const el = field(form, name)
  const note = form.querySelector<HTMLElement>(`#kontakt-${name}-error`)
  if (!note) return
  const text = kind ? messages.errors[kind as keyof Messages['errors']] : undefined
  note.textContent = text ? text.replace('{max}', String(el.maxLength)) : ''
  note.hidden = !text
  if (text) el.setAttribute('aria-invalid', 'true')
  else el.removeAttribute('aria-invalid')
}

/** Writes the status line; `{email}` becomes the mail address as a link. */
function say(status: HTMLElement, kind: ContactStatus, messages: Messages) {
  const [before, after] = splitEmail(messages.status[kind])
  status.dataset.status = kind
  status.replaceChildren(before)
  if (after === undefined) return
  const link = document.createElement('a')
  link.href = `mailto:${messages.email}`
  link.className = 'font-semibold underline underline-offset-2'
  link.textContent = messages.email
  status.append(link, after)
}

document.querySelectorAll<HTMLFormElement>('form[data-contact]').forEach(enhance)
