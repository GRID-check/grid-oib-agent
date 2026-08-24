/**
 * @vitest-environment node
 */
/**
 * The cutoff's CAUSE and its COST, declared on the terminal frame.
 *
 * `research_truncated` has ridden the terminal chunk since the answer first
 * learned to say it was cut off. The backend records two more facts about the
 * same event — `truncation_reason` (`wall_clock` / `step_limit`) and
 * `degraded_reasons` (`no_report_file`, `no_valid_citations`) — and an
 * UNDECLARED field is not tolerated by this schema, it is silently stripped.
 * That is exactly how a lifted extra reaches the client and then vanishes with
 * nothing failing anywhere (see `research-truncated-wire.spec.ts`, and the
 * `skills_hidden` loss before it).
 *
 * Both are typed as plain strings rather than enums, and that is a decision, not
 * an oversight: the WORDS belong to the frontend dictionary, so a token this
 * build cannot phrase already renders nothing. An enum here would drop it one
 * layer earlier for no reader-visible difference — while turning every new
 * backend token into a schema change, and, for the array, discarding the tokens
 * this build DOES know because one entry beside them was new.
 */
import { describe, expect, test } from 'vitest'

import {
  NATMessageType,
  NATSystemResponseMessageSchema,
  WebSocketMessageStatus,
} from './schemas'

const base = {
  type: NATMessageType.SYSTEM_RESPONSE,
  status: WebSocketMessageStatus.COMPLETE,
  content: 'die Antwort',
}

describe('the cutoff cause and the degradations cross the wire', () => {
  test('both are declared, so neither is stripped on the way in', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      research_truncated: true,
      truncation_reason: 'wall_clock',
      degraded_reasons: ['no_report_file', 'no_valid_citations'],
    })

    expect(parsed.research_truncated).toBe(true)
    expect(parsed.truncation_reason).toBe('wall_clock')
    expect(parsed.degraded_reasons).toEqual(['no_report_file', 'no_valid_citations'])
  })

  test('a run that finished carries neither', () => {
    const parsed = NATSystemResponseMessageSchema.parse(base)
    expect(parsed.truncation_reason).toBeUndefined()
    expect(parsed.degraded_reasons).toBeUndefined()
  })

  test('a token this build has never heard of still arrives', () => {
    // The producer adds tokens on its own release train. Keeping it here is
    // free — the renderer is where the allow-list lives, and it renders an
    // unmapped token as nothing rather than as an identifier.
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      truncation_reason: 'tool_budget',
      degraded_reasons: ['quantum_flux', 'no_report_file'],
    })

    expect(parsed.truncation_reason).toBe('tool_budget')
    expect(parsed.degraded_reasons).toEqual(['quantum_flux', 'no_report_file'])
  })

  test('a malformed one degrades to absent without taking the answer with it', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      truncation_reason: 17,
      degraded_reasons: 'no_report_file',
      research_truncated: true,
    })

    expect(parsed.content).toBe('die Antwort')
    expect(parsed.research_truncated).toBe(true)
    expect(parsed.truncation_reason).toBeUndefined()
    expect(parsed.degraded_reasons).toBeUndefined()
  })
})
