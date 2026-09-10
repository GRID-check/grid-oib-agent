/**
 * The `document_draft` card — what it reports, and what it must not offer yet.
 *
 * Two of the assertions here are the card's contract with the slice that has
 * not landed. „Ins Projekt übernehmen" is drawn and is INERT: a control that
 * became pressable by accident would call nothing and tell the reader their
 * draft is now a project document, which is the one thing a draft is not. So
 * both halves are pinned — the label is present, and the element is disabled.
 *
 * The byline is asserted by its WORDS rather than by the component being
 * imported, because the words are the point: a file says who wrote it the same
 * way here as it does in the Files grid (`documents/components/authorship-line`).
 *
 * Renders without an `I18nProvider`, so the dictionary falls back to `en`
 * (`src/i18n/context.tsx`) and the strings asserted below are the English ones.
 */

import { describe, expect, it } from 'vitest'
import { render, screen } from '@/test-utils'
import { DocumentDraftCard } from './DocumentDraftCard'

const DRAFT = {
  title: 'Aktenvermerk – Abweichung Fluchtweglänge',
  path: '/entwuerfe/aktenvermerk-fluchtweg.md',
  bytes: 4820,
  version: 3,
}

describe('DocumentDraftCard', () => {
  it('reports the draft: title, path, version and a human size', () => {
    render(<DocumentDraftCard {...DRAFT} />)

    expect(screen.getByText(DRAFT.title)).toBeInTheDocument()
    expect(screen.getByText(DRAFT.path)).toBeInTheDocument()
    expect(screen.getByText('v3')).toBeInTheDocument()
    // Decimal units, from the one byte formatter — never a raw 4820, and no
    // decimal below MB (`lib/format.ts`: "1.4 kB" is noise).
    expect(screen.getByText('5 kB')).toBeInTheDocument()
    expect(screen.queryByText(String(DRAFT.bytes))).not.toBeInTheDocument()
  })

  it('says who wrote it, in the Files feature’s own words', () => {
    render(<DocumentDraftCard {...DRAFT} />)
    expect(screen.getByText('Created by Piloti')).toBeInTheDocument()
  })

  it('draws the filing action and leaves it inert', () => {
    render(<DocumentDraftCard {...DRAFT} />)

    const action = screen.getByRole('button', { name: 'Add to the project' })
    expect(action).toBeDisabled()
  })

  it('renders a first version and a zero-byte draft without inventing anything', () => {
    // The leanest draft the schema allows: `bytes: 0` (an empty file was still
    // written) and `version: 1`. A card that only paints on rich values is a
    // card that paints nothing the day the tool writes an empty stub.
    render(<DocumentDraftCard title="Notiz.md" path="/entwuerfe/Notiz.md" bytes={0} version={1} />)

    expect(screen.getByText('v1')).toBeInTheDocument()
    expect(screen.getByText('0 B')).toBeInTheDocument()
  })
})
