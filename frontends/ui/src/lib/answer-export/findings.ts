/**
 * The Befundmatrix as document blocks: one table, the same four columns the
 * screen shows, in the reader's words. Read defensively like the cards — a
 * stored payload from any build still exports.
 */

import type { DocBlock } from './blocks'
import { cell } from './blocks'
import { sanitizeFindings } from '@/lib/conversations/message-findings'

type Translator = (key: string, values?: Record<string, string | number>) => string

export function findingsBlocks(findings: unknown, t: Translator): DocBlock[] {
  const sanitized = sanitizeFindings(findings)
  if (!sanitized) return []
  const rows = sanitized.items.map((item) => {
    const reference = item.reference
      ? [
          item.reference.document,
          item.reference.section,
          item.reference.page ? `S. ${item.reference.page}` : undefined,
        ]
          .filter(Boolean)
          .join(' · ')
      : ''
    const citations = item.citations.map((n) => `[${n}]`).join('')
    const status = t(`findingsMatrix.status.${item.status}`)
    const grounding =
      item.grounding === 'belegt' ? '' : ` (${t(`findingsMatrix.grounding.${item.grounding}`)})`
    return [
      cell(item.area ? `${item.requirement} — ${item.area}` : item.requirement),
      cell(item.value ?? ''),
      cell([reference, citations].filter(Boolean).join(' ')),
      cell(`${status}${grounding}${item.comment ? ` — ${item.comment}` : ''}`),
    ]
  })
  return [
    { kind: 'heading', level: 2, text: t('findingsMatrix.title') },
    {
      kind: 'table',
      head: [
        t('findingsMatrix.requirement'),
        t('findingsMatrix.value'),
        t('findingsMatrix.reference'),
        t('findingsMatrix.status.label'),
      ],
      rows,
    },
  ]
}
