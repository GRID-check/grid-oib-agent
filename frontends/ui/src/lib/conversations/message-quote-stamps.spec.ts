import { describe, expect, it } from 'vitest'

import { sanitizeQuoteStamps, stampForQuote } from './message-quote-stamps'

describe('sanitizeQuoteStamps', () => {
  it('reads the wire spelling and keeps the closed key set', () => {
    expect(
      sanitizeQuoteStamps([
        { text: ' Wände sind in REI 90 auszuführen. ', status: 'verbatim', number: 1, file_name: 'oib.pdf', page: 4, punkt: '3.1', title: 'OIB-RL 2', extra: 'x' },
      ])
    ).toEqual([{ text: 'Wände sind in REI 90 auszuführen.', status: 'verbatim', number: 1, fileName: 'oib.pdf', page: 4, punkt: '3.1', title: 'OIB-RL 2' }])
  })

  it('drops what cannot be a stamp', () => {
    expect(sanitizeQuoteStamps([{ text: '', status: 'verbatim' }, { text: 'x', status: 'maybe' }, null, 'x'])).toBeNull()
    expect(sanitizeQuoteStamps({ text: 'x' })).toBeNull()
    expect(sanitizeQuoteStamps([{ text: 'x', status: 'verbatim', page: 0, number: -1, url: 'javascript:alert(1)' }])).toEqual([
      { text: 'x', status: 'verbatim' },
    ])
  })

  it('bounds the list', () => {
    expect(sanitizeQuoteStamps(Array.from({ length: 100 }, () => ({ text: 'x', status: 'unchecked' })))).toHaveLength(40)
  })
})

describe('stampForQuote', () => {
  const stamps = sanitizeQuoteStamps([
    { text: 'Andere Stelle.', status: 'not_found', number: 2 },
    { text: 'Wände sind in REI 90 auszuführen.', status: 'verbatim', number: 1 },
  ])

  it('matches a quote line by its wording, marks and case aside', () => {
    expect(stampForQuote(stamps ?? [], '„wände sind in REI 90 auszuführen" [1]', 1)?.status).toBe('verbatim')
    expect(stampForQuote(stamps ?? [], '„Nichts davon." [1]', 1)).toBeNull()
    expect(stampForQuote(undefined, 'x')).toBeNull()
  })
})
