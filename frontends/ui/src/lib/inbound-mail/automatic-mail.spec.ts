/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { bytes, INBOUND_DOMAIN, message, multipart, textPart, type Part } from './__fixtures__/hostile'
import { classifyAutomaticMail, type AutomaticMailInput } from './automatic-mail'
import { rawHeaderFields } from './mime'

function classify(headers: Record<string, string | null>, envelopeFrom: string | null = 'anna@buero-muster.at', root?: Part) {
  const input: AutomaticMailInput = {
    headers: rawHeaderFields(bytes(message(root, headers))),
    envelopeFrom,
    inboundDomain: INBOUND_DOMAIN,
  }
  return classifyAutomaticMail(input)
}

describe('classifyAutomaticMail: dropped (RFC 3834, RFC 3464, RFC 8098)', () => {
  it.each([
    ['Auto-Submitted: auto-replied', { 'Auto-Submitted': 'auto-replied' }],
    ['Auto-Submitted with a parameter', { 'Auto-Submitted': 'Auto-Replied; owner-email="a@b"' }],
    ['Precedence: auto_reply', { Precedence: 'auto_reply' }],
    ['X-Autoreply: yes', { 'X-Autoreply': 'yes' }],
    ['X-Autorespond', { 'X-Autorespond': 'Vacation' }],
  ])('drops an auto-reply marked by %s', (_label, headers) => {
    expect(classify(headers)).toEqual({ outcome: 'drop', reason: 'auto_reply' })
  })

  it('drops a delivery status notification and a read receipt', () => {
    const dsn = multipart('report', [textPart('text/plain', 'Undeliverable')], '; report-type=delivery-status')
    expect(classify({}, '', dsn)).toEqual({ outcome: 'drop', reason: 'delivery_report' })
    const mdn = multipart('report', [textPart('text/plain', 'Gelesen')], '; report-type="disposition-notification"')
    expect(classify({}, 'anna@buero-muster.at', mdn)).toEqual({ outcome: 'drop', reason: 'delivery_report' })
  })

  it('drops mail from a MAILER-DAEMON', () => {
    expect(classify({ From: 'Mail Delivery System <MAILER-DAEMON@mx.example.com>' })).toEqual({ outcome: 'drop', reason: 'delivery_report' })
  })

  it('drops a loop through our own domain, by From or by envelope', () => {
    expect(classify({ From: `wohnbau.zzzzzzzzzzzz@${INBOUND_DOMAIN}` })).toEqual({ outcome: 'drop', reason: 'self_loop' })
    expect(classify({}, `bounce@mail.${INBOUND_DOMAIN}`)).toEqual({ outcome: 'drop', reason: 'self_loop' })
  })
})

describe('classifyAutomaticMail: kept and flagged automatic', () => {
  it("keeps a scanner's auto-generated mail: that is how a drawing arrives from the plotter room", () => {
    expect(classify({ 'Auto-Submitted': 'auto-generated' })).toEqual({ outcome: 'keep', automatic: true, signals: ['auto_generated'] })
  })

  it('keeps list and bulk mail, flagged', () => {
    expect(classify({ Precedence: 'bulk' })).toMatchObject({ outcome: 'keep', automatic: true, signals: ['precedence_bulk'] })
    expect(classify({ 'List-Id': '<news.example.com>', 'List-Unsubscribe': '<mailto:u@example.com>' })).toMatchObject({
      automatic: true,
      signals: ['list_headers'],
    })
    expect(classify({ 'X-Auto-Response-Suppress': 'All' })).toMatchObject({ automatic: true, signals: ['auto_response_suppress'] })
  })

  it('keeps a null reverse-path that says nothing else, flagged rather than dropped', () => {
    expect(classify({}, '<>')).toEqual({ outcome: 'keep', automatic: true, signals: ['null_sender'] })
  })

  it('keeps a person\'s mail plain, and Auto-Submitted: no is a person', () => {
    expect(classify({})).toEqual({ outcome: 'keep', automatic: false, signals: [] })
    expect(classify({ 'Auto-Submitted': 'no' })).toEqual({ outcome: 'keep', automatic: false, signals: [] })
    expect(classify({ 'X-Autoreply': 'no' })).toEqual({ outcome: 'keep', automatic: false, signals: [] })
  })

  it('does not take a lookalike of our domain for ours', () => {
    expect(classify({ From: `x@not${INBOUND_DOMAIN}` })).toMatchObject({ outcome: 'keep' })
  })

  it('keeps a mail whose header block could not be read, for a person to see', () => {
    expect(classifyAutomaticMail({ headers: null, envelopeFrom: '', inboundDomain: INBOUND_DOMAIN })).toEqual({
      outcome: 'keep',
      automatic: false,
      signals: [],
    })
  })
})
