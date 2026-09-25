/**
 * @vitest-environment node
 */
/**
 * What an observer is allowed to see, and what they must never be shown.
 *
 * The valuable cases here are the two that would be invisible in a demo and
 * obvious in production: a terminal frame that arrives empty (must not blank the
 * answer that streamed) and a second turn's frames arriving on the same
 * subscription (must not append to the first turn's answer).
 */

import { beforeEach, describe, expect, it } from 'vitest'
import {
  EMPTY_SPECTATED_TURN,
  __resetSpectatorStepIdsForTests,
  reduceSpectatedFrame,
  type SpectatedTurnState,
} from './spectator-frames'

function response(
  text: string,
  status: 'in_progress' | 'complete',
  parentId = 'turn-1'
): unknown {
  return {
    type: 'system_response_message',
    id: `${parentId}-${status}-${text.length}`,
    parent_id: parentId,
    content: { text },
    status,
  }
}

function step(name: string, payload = '', status = 'in_progress'): unknown {
  return {
    type: 'system_intermediate_message',
    id: `step-${name}`,
    content: { name, payload },
    status,
  }
}

function fold(frames: unknown[], from: SpectatedTurnState = EMPTY_SPECTATED_TURN) {
  return frames.reduce<SpectatedTurnState>(
    (state, frame) => reduceSpectatedFrame(state, frame),
    from
  )
}

describe('reduceSpectatedFrame', () => {
  beforeEach(() => {
    __resetSpectatorStepIdsForTests()
  })

  it('accumulates in-progress deltas into one answer', () => {
    const state = fold([
      response('Die OIB-', 'in_progress'),
      response('Richtlinie 2 ', 'in_progress'),
      response('regelt…', 'in_progress'),
    ])
    expect(state.answer).toBe('Die OIB-Richtlinie 2 regelt…')
    expect(state.done).toBe(false)
  })

  it('lets the terminal frame replace what streamed', () => {
    const state = fold([
      response('Die OIB-', 'in_progress'),
      response('Die OIB-Richtlinie 2 regelt den Brandschutz.', 'complete'),
    ])
    expect(state.answer).toBe('Die OIB-Richtlinie 2 regelt den Brandschutz.')
    expect(state.done).toBe(true)
  })

  it('lets a settled snapshot replace what streamed (ADR-0066)', () => {
    const snapshot = {
      ...(response('R 90 [1].\n\n## Quellen\n- [1] oib.pdf', 'in_progress') as object),
      stream_replace: true,
    }
    const state = fold([response('R 90 [1', 'in_progress'), response('].', 'in_progress'), snapshot])
    expect(state.answer).toBe('R 90 [1].\n\n## Quellen\n- [1] oib.pdf')
    expect(state.done).toBe(false)
  })

  it('carries the masthead, the verified sources and the cards the asker gets (ADR-0066)', () => {
    const masthead = { ...(response('', 'in_progress') as object), answer_meta: { v: 1, kind: 'ruling', topic: 'Fluchtweg' } }
    // The snapshot re-states the masthead it kept after re-gating it.
    const snapshot = {
      ...(response('R 90 [1].', 'in_progress') as object),
      stream_replace: true,
      answer_meta: { v: 1, kind: 'ruling', topic: 'Fluchtweg' },
      sources: [{ number: 1, citation_key: 'oib.pdf, p.3', file_name: 'oib.pdf', page: 3, kind: 'baurecht' }],
    }
    const cards = {
      ...(response('', 'in_progress') as object),
      cards: [{ type: 'summary', title: 'Zusammenfassung', content: 'Alles gut.' }],
    }

    const head = fold([masthead])
    // Before the first word, the masthead alone is something to show.
    expect(head.answerMeta?.topic).toBe('Fluchtweg')
    expect(head.answer).toBe('')

    const state = fold([masthead, response('R 90 [1', 'in_progress'), snapshot, cards])
    expect(state.answer).toBe('R 90 [1].')
    expect(state.answerMeta?.kind).toBe('ruling')
    expect(state.citations?.[0]).toEqual(expect.objectContaining({ fileName: 'oib.pdf', page: 3 }))
    expect(state.cards?.map((card) => card?.type)).toEqual(['summary'])
  })

  it('lets a terminal without the live cards or masthead take them back', () => {
    const masthead = { ...(response('', 'in_progress') as object), answer_meta: { v: 1, kind: 'direct', topic: 'Kurz' } }
    const cards = {
      ...(response('', 'in_progress') as object),
      cards: [{ type: 'summary', title: 'Zusammenfassung', content: 'Alles gut.' }],
    }
    const state = fold([masthead, response('Kurz.', 'in_progress'), cards, response('Kurz.', 'complete')])
    expect(state.cards).toBeUndefined()
    expect(state.answerMeta).toBeUndefined()
    expect(state.done).toBe(true)
  })

  it('lets a settled snapshot without the masthead take it back', () => {
    // The backend re-gates the masthead against the snapshot's prose. A
    // snapshot that omits it gated it out, and the observer must not keep
    // reading a verdict the asker no longer sees.
    const masthead = { ...(response('', 'in_progress') as object), answer_meta: { v: 1, kind: 'ruling', topic: 'Fluchtweg' } }
    const snapshot = {
      ...(response('Kommt darauf an [1].', 'in_progress') as object),
      stream_replace: true,
      sources: [{ number: 1, citation_key: 'oib.pdf, p.3', file_name: 'oib.pdf', page: 3, kind: 'baurecht' }],
    }
    const state = fold([masthead, response('Kommt darauf an [1', 'in_progress'), snapshot])
    expect(state.answer).toBe('Kommt darauf an [1].')
    expect(state.answerMeta).toBeUndefined()
  })

  it('lets an empty snapshot take back a streamed round, as the asker sees it', () => {
    // A streamed call that turned out to call tools is retracted with an empty
    // snapshot (content "", sources []). Folded as "nothing to show" it was
    // dropped, and the observer kept reading the round's prose as the answer.
    const snapshot = {
      ...(response('R 90 [1].', 'in_progress') as object),
      stream_replace: true,
      answer_meta: { v: 1, kind: 'ruling', topic: 'Fluchtweg' },
      sources: [{ number: 1, citation_key: 'oib.pdf, p.3', file_name: 'oib.pdf', page: 3, kind: 'baurecht' }],
    }
    const retraction = { ...(response('', 'in_progress') as object), stream_replace: true, sources: [] }
    const state = fold([response('R 90 [1', 'in_progress'), snapshot, retraction])
    expect(state.answer).toBe('')
    expect(state.answerMeta).toBeUndefined()
    expect(state.citations).toBeUndefined()
  })

  it('lets an empty snapshot take back the cards a retracted round streamed', () => {
    // The round that turned out to call tools is dead, its cards with it: the
    // asker's store drops them, so the observer must not keep reading them.
    const cards = {
      ...(response('', 'in_progress') as object),
      cards: [{ type: 'summary', title: 'Zusammenfassung', content: 'Tote Runde.' }],
    }
    const retraction = { ...(response('', 'in_progress') as object), stream_replace: true, sources: [] }
    const state = fold([response('R 90', 'in_progress'), cards, retraction])
    expect(state.cards).toBeUndefined()
  })

  it('keeps the live cards across a snapshot that has prose', () => {
    const cards = {
      ...(response('', 'in_progress') as object),
      cards: [{ type: 'summary', title: 'Zusammenfassung', content: 'Alles gut.' }],
    }
    const snapshot = { ...(response('R 90.', 'in_progress') as object), stream_replace: true }
    const state = fold([response('R 9', 'in_progress'), cards, snapshot])
    expect(state.cards?.map((card) => card?.type)).toEqual(['summary'])
  })

  it('never hands an observer a card that acts, and keeps every position (ADR-0039 §5)', () => {
    // A memory proposal or a file operation proposes a write in the ASKER's
    // name. Drawn for an observer it was a button that wrote into the
    // observer's organization and project.
    const complete = {
      ...(response('Fertig [[card:3]].', 'complete') as object),
      cards: [
        { type: 'memory_proposal', title: 'Merken?', content: 'REI 90 für GK4.', kind: 'preference', confidence: 'high' },
        {
          type: 'file_operation_proposal',
          title: 'Verschieben',
          operation: 'move',
          operations: [{ document: 'EG.pdf', source: 'projekt', current: '', target_folder: 'Einreichung' }],
        },
        { type: 'summary', title: 'Zusammenfassung', content: 'Alles gut.' },
      ],
    }
    const state = fold([complete])
    expect(state.cards).toHaveLength(3)
    expect(state.cards?.map((card) => card?.type)).toEqual([undefined, undefined, 'summary'])
  })

  it('keeps the streamed answer when the terminal frame is empty', () => {
    // The single most damaging failure mode available here: a backend that
    // finishes with an empty `complete` would otherwise blank a finished answer
    // in front of the observer a fraction of a second before the persisted one
    // arrives.
    const state = fold([
      response('Ja, ab drei Geschossen.', 'in_progress'),
      response('', 'complete'),
    ])
    expect(state.answer).toBe('Ja, ab drei Geschossen.')
    expect(state.done).toBe(true)
  })

  it('starts a new turn when the parent id changes', () => {
    const first = fold([response('Erste Antwort.', 'complete', 'turn-1')])
    const second = fold([response('Zweite ', 'in_progress', 'turn-2')], first)
    expect(second.answer).toBe('Zweite ')
    expect(second.parentId).toBe('turn-2')
    expect(second.done).toBe(false)
  })

  it('merges a Function Start/Complete pair onto one step', () => {
    const state = fold([
      step('Function Start: web_search_tool', 'querying'),
      step('Function Complete: web_search_tool', 'three results', 'complete'),
    ])
    expect(state.steps).toHaveLength(1)
    expect(state.steps[0].functionName).toBe('web_search_tool')
    expect(state.steps[0].isComplete).toBe(true)
  })

  it('closes every open step when the turn completes', () => {
    // A step left open renders as a spinner that never resolves, which reads as a
    // hung turn under a finished answer.
    const state = fold([
      step('Function Start: web_search_tool', 'querying'),
      response('Fertig.', 'complete'),
    ])
    expect(state.steps.every((s) => s.isComplete)).toBe(true)
  })

  it('reports a prompt as something to read, not to answer', () => {
    const state = fold([
      {
        type: 'system_interaction_message',
        id: 'p1',
        parent_id: 'turn-1',
        content: { input_type: 'text', text: 'Welches Bundesland?' },
        status: 'in_progress',
      },
    ])
    expect(state.waitingOn).toBe('Welches Bundesland?')
    // Nothing in the state can be turned into a control: there is no prompt id
    // and no options, on purpose.
    expect(Object.keys(state)).not.toContain('promptId')
  })

  it('clears the wait as soon as the agent does anything again', () => {
    // The asker's answer to the prompt travels their own input channel, which an
    // observer does not subscribe to, so a step frame is the only evidence they
    // ever get that the pause is over. Clearing only on a response frame left an
    // observer reading "Piloti asked a question and is waiting" for as long as
    // the agent then spent running tools.
    const waiting = fold([
      {
        type: 'system_interaction_message',
        id: 'p1',
        parent_id: 'turn-1',
        content: { input_type: 'text', text: 'Welches Bundesland?' },
        status: 'in_progress',
      },
    ])
    expect(waiting.waitingOn).toBe('Welches Bundesland?')

    const answered = reduceSpectatedFrame(waiting, step('Function Start: web_search_tool', 'Wien'))
    expect(answered.waitingOn).toBeNull()
  })

  it('marks an error turn as finished and failed', () => {
    const state = fold([
      response('Teilantwort', 'in_progress'),
      { type: 'error_message', id: 'e1', content: { code: 'unknown_error', message: 'boom' } },
    ])
    expect(state.failed).toBe(true)
    expect(state.done).toBe(true)
  })

  it('reads the GenerateResponse `output` shape shallow answers use', () => {
    // Not an exotic case: shallow/meta answers arrive as `{output}` rather than
    // `{text}`, and `output` MUST win — `SystemResponseContent` has only optional
    // fields, so it also matches `{output: …}` and would parse it to `{}`,
    // silently discarding the answer.
    const state = fold([
      {
        type: 'system_response_message',
        id: 'g1',
        parent_id: 'turn-1',
        content: { output: 'Kurz: ja.' },
        status: 'in_progress',
      },
    ])
    expect(state.answer).toBe('Kurz: ja.')
  })

  it('reads a bare string content', () => {
    const state = fold([
      {
        type: 'system_response_message',
        id: 's1',
        parent_id: 'turn-1',
        content: 'Direkt als String.',
        status: 'in_progress',
      },
    ])
    expect(state.answer).toBe('Direkt als String.')
  })

  it('survives a response frame whose content carries no text at all', () => {
    const before = fold([response('Bisher.', 'in_progress')])
    const after = reduceSpectatedFrame(before, {
      type: 'system_response_message',
      id: 'empty',
      parent_id: 'turn-1',
      content: {},
      status: 'in_progress',
    })
    expect(after.answer).toBe('Bisher.')
  })

  it('accumulates a legacy string intermediate step into one generic step', () => {
    // Older backends send the step payload as a bare string with no function
    // name. It still has to reach the Herleitung, and consecutive strings belong
    // in ONE step rather than one step per line.
    const state = fold([
      { type: 'system_intermediate_message', id: 'l1', content: 'Suche läuft', status: 'in_progress' },
      { type: 'system_intermediate_message', id: 'l2', content: 'Treffer geprüft', status: 'in_progress' },
    ])
    expect(state.steps).toHaveLength(1)
    expect(state.steps[0].functionName).toBe('unknown')
    expect(state.steps[0].content).toBe('Suche läuft\nTreffer geprüft\n')
  })

  it('starts a fresh generic step after a named one closed', () => {
    const state = fold([
      { type: 'system_intermediate_message', id: 'l1', content: 'Zuerst', status: 'in_progress' },
      step('Function Start: web_search_tool', 'querying'),
      { type: 'system_intermediate_message', id: 'l2', content: 'Danach', status: 'in_progress' },
    ])
    expect(state.steps).toHaveLength(3)
    expect(state.steps.map((s) => s.functionName)).toEqual([
      'unknown',
      'web_search_tool',
      'unknown',
    ])
  })

  it('ignores a blank legacy step rather than opening an empty one', () => {
    const before = fold([response('Etwas', 'in_progress')])
    const after = reduceSpectatedFrame(before, {
      type: 'system_intermediate_message',
      id: 'blank',
      content: '   ',
      status: 'in_progress',
    })
    expect(after.steps).toHaveLength(0)
  })

  it('is inert for a frame it cannot parse', () => {
    const before = fold([response('Etwas', 'in_progress')])
    for (const junk of [null, undefined, 42, 'nonsense', {}, { type: 'unknown_frame' }]) {
      expect(reduceSpectatedFrame(before, junk)).toBe(before)
    }
  })
})
