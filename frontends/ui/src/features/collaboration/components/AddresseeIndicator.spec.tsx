import { describe, expect, test } from 'vitest'
import { render, screen } from '@/test-utils'

import { AGENT_MENTION_ID } from '@/lib/mentions/types'
import type { DraftMention } from '../lib/mention-text'
import { AddresseeIndicator } from './AddresseeIndicator'

const ANNA: DraftMention = { targetId: 'u-anna', display: 'Anna Weber' }
const MARKUS: DraftMention = { targetId: 'u-markus', display: 'Markus Hofer' }
const PILOTI: DraftMention = { targetId: AGENT_MENTION_ID, display: 'Piloti' }

const line = () => screen.getByTestId('composer-addressee')

describe('AddresseeIndicator — the composer says where the message goes', () => {
  test('defaults to the agent, so "Piloti is next" is never an inference', () => {
    render(<AddresseeIndicator mentions={[]} awaitingHuman={false} />)
    expect(line()).toHaveTextContent('Goes to Piloti')
    expect(line()).toHaveAttribute('data-mode', 'agent')
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
    expect(line()).toHaveTextContent('Goes to the chat')
    expect(line()).toHaveAttribute('data-mode', 'thread')
  })

  test('an explicit @Piloti overrides the wait — that is the documented way back', () => {
    render(<AddresseeIndicator mentions={[PILOTI]} awaitingHuman />)
    expect(line()).toHaveTextContent('Goes to Piloti')
    expect(line()).toHaveAttribute('data-mode', 'agent')
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
