/**
 * `GridCardItem`'s surface id: A2UI keys a surface by it, and `A2uiCard`
 * promises it is unique within the page.
 */
import { describe, expect, it } from 'vitest'
import { render, waitFor } from '@/test-utils'
import { GridCardItem } from './GridCards'
import { CARD_PREVIEW_FIXTURES } from '../preview-fixtures'

const CARD = CARD_PREVIEW_FIXTURES.calculation!

describe('GridCardItem', () => {
  it('gives two answers without a message id different surface ids', async () => {
    render(
      <>
        <GridCardItem card={CARD} index={0} />
        <GridCardItem card={CARD} index={0} />
      </>
    )
    await waitFor(() => expect(document.querySelectorAll('[data-a2ui-surface]')).toHaveLength(2))
    const ids = [...document.querySelectorAll('[data-a2ui-surface]')].map((node) => node.getAttribute('data-a2ui-surface'))
    expect(new Set(ids).size).toBe(2)
  })

  it('keys the surface by the message when there is one', async () => {
    render(<GridCardItem card={CARD} index={3} messageId="m7" />)
    await waitFor(() => expect(document.querySelector('[data-a2ui-surface="m7:3"]')).not.toBeNull())
  })
})
