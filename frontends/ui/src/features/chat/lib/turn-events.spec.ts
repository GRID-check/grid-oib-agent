/**
 * @vitest-environment node
 */

/**
 * Turn events — recognition and the live/technical boundary.
 *
 * These steps look like ordinary top-level functions to everything upstream
 * (`isFunctionStepName` returns true for `status:retrieval:0`), so if this
 * module fails to recognise them they do not disappear — they surface as raw
 * machine names in the "Ran:" chip row, which is the single most likely way the
 * integration ships looking broken.
 */

import { describe, test, expect } from 'vitest'
import {
  isStatusStepName,
  isTurnEventStepName,
  stepEventPayload,
  turnEventLiveText,
} from './turn-events'

const event = (functionName: string, ...payloads: Array<Record<string, unknown>>) => ({
  functionName,
  content: payloads.map((p) => JSON.stringify(p)).join('\n'),
})

describe('recognition', () => {
  test.each([
    ['status:routing', true],
    ['status:retrieval:0', true],
    ['status:retrieval:12', true],
    ['status:documents', true],
    ['status:citations', true],
    ['status:escalation', true],
    ['Tool: status:routing', true],
    ['knowledge_search_tool', false],
    ['skill:a', false],
  ])('isStatusStepName(%s) === %s', (name, expected) => {
    expect(isStatusStepName(name)).toBe(expected)
  })

  test('turn events are the status slots plus the skill events', () => {
    expect(isTurnEventStepName('status:routing')).toBe(true)
    expect(isTurnEventStepName('skill:oib-brandschutz')).toBe(true)
    expect(isTurnEventStepName('skill_selection')).toBe(true)
    expect(isTurnEventStepName('web_search_tool')).toBe(false)
    expect(isTurnEventStepName('use_skill')).toBe(false)
  })
})

describe('turnEventLiveText', () => {
  test('a live status hands over the backend sentence verbatim', () => {
    // The frontend cannot compose this: it names the corpus AND quotes the
    // query the model actually sent.
    expect(
      turnEventLiveText(
        event('status:retrieval:0', {
          kind: 'status',
          channel: 'live',
          slot: 'retrieval:0',
          text: 'Sucht im OIB-Wissen: „Fluchtweglänge GK4“',
          tools: ['knowledge_search'],
          query: 'Fluchtweglänge GK4',
        })
      )
    ).toBe('Sucht im OIB-Wissen: „Fluchtweglänge GK4“')
  })

  test('a technical event is refused even if it somehow carries text', () => {
    // `channel` is the contract; the absent `text` is the structural backup.
    // Belt and braces, because a leak here is the phantom-Websuche class of bug.
    expect(
      turnEventLiveText(
        event('status:routing', {
          kind: 'status',
          channel: 'technical',
          slot: 'routing',
          text: 'should never be shown',
        })
      )
    ).toBeNull()
  })

  test('the catalogue event says nothing — its size is availability', () => {
    expect(
      turnEventLiveText(
        event('skill_selection', {
          kind: 'skill',
          channel: 'technical',
          phase: 'offered',
          offered_count: 6,
          forced_names: ['oib-brandschutz'],
        })
      )
    ).toBeNull()
    // And a number the reader cannot act on never reaches a sentence.
    expect(
      turnEventLiveText(
        event('status:citations', {
          kind: 'status',
          channel: 'live',
          slot: 'citations',
          text: 'Belege werden geprüft …',
          source_count: 17,
        })
      )
    ).toBe('Belege werden geprüft …')
  })

  test('an ordinary tool step is not a turn event and says nothing here', () => {
    expect(turnEventLiveText(event('knowledge_search_tool', { anything: true }))).toBeNull()
  })

  test('the adaptor repeats the object under Function Output — still one sentence', () => {
    const payload = {
      kind: 'status',
      channel: 'live',
      slot: 'escalation',
      text: 'Kurzrecherche reicht nicht — Tiefenrecherche startet',
    }
    const step = {
      functionName: 'status:escalation',
      content: `**Function Input:**\n${JSON.stringify(payload)}\n**Function Output:**\n${JSON.stringify(payload)}`,
    }
    expect(turnEventLiveText(step)).toBe('Kurzrecherche reicht nicht — Tiefenrecherche startet')
  })
})

describe('stepEventPayload — decoded exactly once', () => {
  test('content is taken as-is: formatPayload already decoded it', () => {
    // Decoding again would turn `&amp;amp;` (a literal `&amp;` the sender meant)
    // into `&`.
    expect(stepEventPayload({ functionName: 'status:x', content: '{"a":"&amp; b"}' })).toBe(
      '{"a":"&amp; b"}'
    )
  })

  test('rawPayload is the untouched wire string and IS decoded', () => {
    expect(
      stepEventPayload({ functionName: 'status:x', content: '', rawPayload: '{"a":"&amp; b"}' })
    ).toBe('{"a":"& b"}')
  })

  test('no payload at all is undefined, not an empty parse', () => {
    expect(stepEventPayload({ functionName: 'status:x' })).toBeUndefined()
  })
})
