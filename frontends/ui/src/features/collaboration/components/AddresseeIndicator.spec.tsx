import { describe, expect, test, vi } from 'vitest'
import userEvent from '@testing-library/user-event'
import { render, screen } from '@/test-utils'

import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import type { DraftMention } from '../lib/mention-text'
import { AddresseeIndicator } from './AddresseeIndicator'

const ANNA: DraftMention = { targetId: 'u-anna', display: 'Anna Weber' }
const MARKUS: DraftMention = { targetId: 'u-markus', display: 'Markus Hofer' }
const PILOTI: DraftMention = { targetId: AGENT_MENTION_ID, display: 'Piloti' }

const line = () => screen.getByTestId('composer-addressee')

describe('AddresseeIndicator — the composer says where the message goes', () => {
  test('says nothing in the default case — silence is what makes the rest legible', () => {
    render(<AddresseeIndicator mentions={[]} awaitingHuman={false} />)
    // The routing is unchanged and still reported as `agent`; what went is the
    // sentence about it. A statement made on every thread forever is furniture,
    // and it sat under a composer that has none left.
    expect(line()).toHaveAttribute('data-mode', 'agent')
    // Nothing at all here: this render passes no `onMentionSomeone`, so not even
    // the `@` offer is on the line (a solo thread grows no furniture, NF-8).
    expect(line()).toBeEmptyDOMElement()
    // Nothing to announce, so nothing announces itself.
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  test('names the tagged person, with their avatar', () => {
    render(<AddresseeIndicator mentions={[ANNA]} awaitingHuman={false} />)
    expect(line()).toHaveTextContent('Goes to Anna Weber')
    expect(line()).toHaveAttribute('data-mode', 'people')
    expect(screen.getAllByTestId('person-avatar')).toHaveLength(1)
  })

  test('names several tagged people in the order they were tagged', () => {
    render(<AddresseeIndicator mentions={[MARKUS, ANNA]} awaitingHuman={false} />)
    expect(line()).toHaveTextContent('Goes to Markus Hofer, Anna Weber')
  })

  test('says the message goes to the CHAT while the thread awaits a person', () => {
    render(<AddresseeIndicator mentions={[]} awaitingHuman />)
    expect(line()).toHaveTextContent('Goes to everyone in the chat')
    expect(line()).toHaveAttribute('data-mode', 'thread')
  })

  test('an explicit @Piloti overrides the wait — that is the documented way back', () => {
    render(<AddresseeIndicator mentions={[PILOTI]} awaitingHuman />)
    // The routing still changes out of `thread`, which is the load-bearing part
    // (MN-9.3). It simply no longer says so: the user typed the mention, so the
    // line would be reading their own keystroke back to them.
    expect(line()).toHaveAttribute('data-mode', 'agent')
    expect(line()).not.toHaveTextContent('everyone in the chat')
  })

  test('tagging a person AND the agent names both, because both are addressed (MN-1)', () => {
    render(<AddresseeIndicator mentions={[ANNA, PILOTI]} awaitingHuman={false} />)
    expect(line()).toHaveTextContent('Goes to Anna Weber, Piloti')
  })

  test('is a status region carrying the addressee in its accessible name', () => {
    render(<AddresseeIndicator mentions={[ANNA]} awaitingHuman={false} />)
    expect(screen.getByRole('status')).toHaveAccessibleName(
      'Recipient of this message: Goes to Anna Weber',
    )
  })

  test('is not interactive — it is a statement standing among buttons', () => {
    render(<AddresseeIndicator mentions={[]} awaitingHuman={false} />)
    expect(screen.queryByRole('button')).not.toBeInTheDocument()
  })
})

/**
 * The `@` affordance (spec MN-3's missing discovery story).
 *
 * Nothing in the product taught that you can tag a colleague — no button, no icon,
 * no tooltip, no onboarding. A user had to already know to type `@`, which means the
 * feature this whole slice is built around was reachable only by people who had been
 * told about it. It sits on the line that already states the routing, because "this
 * goes to Piloti" is exactly the moment somebody might want it to go to a person.
 */
describe('AddresseeIndicator — teaching that @ exists', () => {
  test('offers it in the default state', async () => {
    const user = userEvent.setup()
    const onMentionSomeone = vi.fn()
    render(
      <AddresseeIndicator mentions={[]} awaitingHuman={false} onMentionSomeone={onMentionSomeone} />,
    )

    const hint = screen.getByTestId('composer-mention-offer')
    expect(hint).toHaveTextContent('mention a colleague')

    await user.click(hint)
    expect(onMentionSomeone).toHaveBeenCalled()
  })

  test('is absent without the callback — a solo thread grows no furniture (NF-8)', () => {
    render(<AddresseeIndicator mentions={[]} awaitingHuman={false} />)
    expect(screen.queryByTestId('composer-mention-offer')).not.toBeInTheDocument()
  })

  test('steps aside once somebody is already tagged', () => {
    // The line has something more important to say, and the picker is one keystroke
    // away regardless.
    render(
      <AddresseeIndicator
        mentions={[{ targetId: 'u-anna', display: 'Anna Weber' }]}
        awaitingHuman={false}
        onMentionSomeone={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('composer-mention-offer')).not.toBeInTheDocument()
  })

  test('steps aside while the thread waits on someone', () => {
    render(
      <AddresseeIndicator mentions={[]} awaitingHuman onMentionSomeone={vi.fn()} />,
    )
    expect(screen.queryByTestId('composer-mention-offer')).not.toBeInTheDocument()
  })

  test('steps aside when Piloti is explicitly tagged', () => {
    render(
      <AddresseeIndicator
        mentions={[{ targetId: AGENT_MENTION_ID, display: 'Piloti' }]}
        awaitingHuman={false}
        onMentionSomeone={vi.fn()}
      />,
    )
    expect(screen.queryByTestId('composer-mention-offer')).not.toBeInTheDocument()
  })
})
