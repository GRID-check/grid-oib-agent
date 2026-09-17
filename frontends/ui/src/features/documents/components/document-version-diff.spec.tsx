/**
 * The rendering half of the version diff.
 *
 * `version-diff.spec.ts` pins the alignment; this pins what a reader actually
 * gets, and in particular the two things that are easy to lose in a retune:
 *
 *   - **no chroma.** The design language spends colour on provenance alone, so
 *     a green or red wash creeping in here is a real regression and not a taste
 *     question. Asserted on the class list, because that is where it would
 *     arrive.
 *   - **the difference does not depend on seeing anything.** The `+`/`−`
 *     markers are `aria-hidden`, so each changed row carries its word.
 */

import { describe, expect, it } from 'vitest'
import { render, screen, within } from '@/test-utils'
import { DocumentVersionDiff } from './document-version-diff'

const renderDiff = (from: string, to: string) =>
  render(
    <DocumentVersionDiff
      from={{ versionNumber: 1, content: from }}
      to={{ versionNumber: 2, content: to }}
    />,
  )

const rowKinds = (): (string | null)[] =>
  screen.getAllByTestId('document-version-diff-row').map((row) => row.getAttribute('data-kind'))

describe('DocumentVersionDiff', () => {
  it('marks a replaced line as one removal and one addition, in reading order', () => {
    renderDiff('Gebäudeklasse 4\n', 'Gebäudeklasse 5\n')

    expect(rowKinds()).toEqual(['removed', 'added'])
    expect(screen.getByTestId('document-version-diff-counts')).toHaveTextContent('1 line added')
    expect(screen.getByTestId('document-version-diff-counts')).toHaveTextContent('1 line removed')
  })

  it('leaves an unchanged line unmarked when one is inserted above it', () => {
    // The case the old side-by-side view refused to fake.
    renderDiff('eins\nzwei\n', 'eins\nneu\nzwei\n')

    expect(rowKinds()).toEqual(['context', 'added', 'context'])
  })

  it('names the two versions it is comparing', () => {
    renderDiff('a\n', 'b\n')

    expect(screen.getByTestId('document-version-diff')).toHaveTextContent('Version 1 → version 2')
  })

  it('says so rather than showing an empty list when the versions are identical', () => {
    renderDiff('unverändert\n', 'unverändert\n')

    expect(screen.getByTestId('document-version-diff-identical')).toBeInTheDocument()
    expect(screen.queryByTestId('document-version-diff-rows')).not.toBeInTheDocument()
    expect(screen.queryByTestId('document-version-diff-counts')).not.toBeInTheDocument()
  })

  it('folds a long unchanged run into one counted gap', () => {
    const filler = Array.from({ length: 40 }, (_, index) => `Zeile ${index + 1}`)
    renderDiff([...filler, 'Schluss'].join('\n'), [...filler, 'Schluss, neu'].join('\n'))

    const gaps = screen.getAllByTestId('document-version-diff-gap')
    expect(gaps).toHaveLength(1)
    expect(gaps[0]).toHaveTextContent('37 lines unchanged')
  })

  it('carries a word for every marker, because the markers are aria-hidden', () => {
    renderDiff('alt\n', 'neu\n')

    const [removed, added] = screen.getAllByTestId('document-version-diff-row')
    expect(within(removed).getByText(/removed/)).toBeInTheDocument()
    expect(within(added).getByText(/added/)).toBeInTheDocument()
  })

  it('spends no chroma: an added line is ink and a fill, never green, and a removed one never red', () => {
    renderDiff('alt\n', 'neu\n')

    const classes = screen
      .getAllByTestId('document-version-diff-row')
      .map((row) => row.className)
      .join(' ')

    // The whole family of colour utilities a diff renderer reaches for by
    // reflex, plus the two source signals the wrong choice would collide with.
    expect(classes).not.toMatch(/green|red|emerald|rose|destructive|source-project|signal-error/)
    // What carries the difference instead: a left rule, solid vs dashed.
    expect(classes).toMatch(/border-l-2/)
    expect(classes).toMatch(/border-dashed/)
  })

  it('renders a blank line as a row rather than collapsing it away', () => {
    // An emptied paragraph is a change somebody made on purpose.
    renderDiff('eins\n\nzwei\n', 'eins\nzwei\n')

    expect(rowKinds()).toContain('removed')
  })
})
