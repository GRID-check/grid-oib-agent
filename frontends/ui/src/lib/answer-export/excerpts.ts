/**
 * The document's „Rechtsgrundlagen": the passages the answer quoted, each
 * under the source it was verified against.
 *
 * It used to be built from `legal_basis` cards. Answers are Markdown now, and a
 * quoted Fundstelle is a plain blockquote that ends in its citation
 * (`> „Fluchtwege müssen …" [3]`), which the app draws as an excerpt with its
 * source in the margin. The document keeps the section by reading the same
 * lines: a quote whose `[N]` resolves to a stored, numbered reference is a
 * Rechtsgrundlage; one whose number resolves to nothing is left in the prose
 * and not promoted, because a section under that heading claims its sources
 * were checked.
 */

import { marked, type Tokens } from 'marked'
import type { Translator } from '@/i18n/translate'
import { stripDirectives } from '@/lib/text/answer-directives'
import type { DocBlock } from './blocks'
import type { ReferenceEntry } from './citations'

/** One quoted passage and the citation it ends in. */
export interface QuotedPassage {
  text: string
  number: number
}

const TRAILING_CITATION = /\s*\[(\d+)\]\s*$/

/** Every blockquote of the answer that ends in `[N]`, in order, its marker removed. */
export function quotedPassages(markdown: string): QuotedPassage[] {
  const passages: QuotedPassage[] = []
  for (const token of marked.lexer(stripDirectives(markdown))) {
    if (token.type !== 'blockquote') continue
    const text = (token as Tokens.Blockquote).text.replace(/\s+/g, ' ').trim()
    const match = TRAILING_CITATION.exec(text)
    if (!match) continue
    passages.push({ text: text.slice(0, match.index).trim(), number: Number(match[1]) })
  }
  return passages
}

/** The „Rechtsgrundlagen" section, or nothing when no quote resolves to a stored reference. */
export function legalBasisBlocks(markdown: string, references: ReferenceEntry[], t: Translator): DocBlock[] {
  const byNumber = new Map(references.map((reference) => [reference.number, reference]))
  const blocks: DocBlock[] = []
  for (const passage of quotedPassages(markdown)) {
    const reference = byNumber.get(passage.number)
    if (!reference || !passage.text) continue
    const locator = [reference.label, reference.page].filter(Boolean).join(', ')
    blocks.push(
      { kind: 'paragraph', runs: [{ text: `[${passage.number}] `, bold: true }, { text: locator, bold: true }] },
      { kind: 'paragraph', runs: [{ text: passage.text }], style: 'quote' }
    )
  }
  return blocks.length > 0 ? [{ kind: 'heading', level: 2, text: t('legalBasis') }, ...blocks] : []
}
