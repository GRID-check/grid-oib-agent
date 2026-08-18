/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import {
  ANSWER_CONFIDENCE_REASON_MAX_CHARS,
  HumanPromptType,
  NATHumanPromptSchema,
  NATIncomingMessageSchema,
  NATMessageType,
  NATSystemResponseMessageSchema,
  WebSocketMessageStatus,
} from './schemas'

describe('NATSystemResponseMessageSchema content union', () => {
  const base = {
    type: NATMessageType.SYSTEM_RESPONSE,
    status: WebSocketMessageStatus.COMPLETE,
  }

  test('GenerateResponse content ({output}) is preserved, not stripped to {}', () => {
    // Regression: SystemResponseContent has only optional fields and zod strips
    // unknown keys, so if it is tried first it matches {output: ...} and parses
    // to {} — silently discarding the response text.
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      content: { output: 'hello world' },
    })
    expect(parsed.content).toEqual({ output: 'hello world' })
  })

  test('SystemResponseContent ({text}) still parses to the text branch', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      content: { text: 'a shallow answer' },
    })
    expect(parsed.content).toEqual({ text: 'a shallow answer' })
  })

  test('string content still parses', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      content: 'plain string',
    })
    expect(parsed.content).toBe('plain string')
  })
})

describe('NATSystemResponseMessageSchema answer_confidence', () => {
  const base = {
    type: NATMessageType.SYSTEM_RESPONSE,
    status: WebSocketMessageStatus.COMPLETE,
    content: 'an answer',
  }

  test.each(['low', 'medium', 'high'] as const)('accepts %s', (level) => {
    const parsed = NATSystemResponseMessageSchema.parse({ ...base, answer_confidence: level })
    expect(parsed.answer_confidence).toBe(level)
  })

  test('omitted answer_confidence parses to undefined (backward compatible)', () => {
    const parsed = NATSystemResponseMessageSchema.parse(base)
    expect(parsed.answer_confidence).toBeUndefined()
  })

  test('an out-of-enum level degrades to undefined without dropping the message', () => {
    // `.catch(undefined)` keeps the message parseable (text preserved) and just
    // omits the confidence chip, rather than throwing away the whole response.
    const parsed = NATSystemResponseMessageSchema.parse({ ...base, answer_confidence: 'certain' })

    expect(parsed.answer_confidence).toBeUndefined()
    expect(parsed.content).toBe('an answer')
  })
})

describe('NATSystemResponseMessageSchema transparency extras (WP-A → WP-B)', () => {
  const base = {
    type: NATMessageType.SYSTEM_RESPONSE,
    status: WebSocketMessageStatus.COMPLETE,
    content: 'an answer',
  }

  test('all new terminal-chunk extras parse when present', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      routing_decision: 'deep',
      routing_reason: 'Die Frage erfordert eine tiefere Recherche.',
      escalation_reason: 'Die erste Antwort war unzureichend.',
      answer_confidence_capped_reason: 'ungrounded',
      citations_removed: { count: 2, reasons: ['not found', 'stale'] },
      job_admission_rejected: true,
      retry_after_seconds: 30,
    })

    expect(parsed.routing_decision).toBe('deep')
    expect(parsed.routing_reason).toBe('Die Frage erfordert eine tiefere Recherche.')
    expect(parsed.escalation_reason).toBe('Die erste Antwort war unzureichend.')
    expect(parsed.answer_confidence_capped_reason).toBe('ungrounded')
    expect(parsed.citations_removed).toEqual({ count: 2, reasons: ['not found', 'stale'] })
    expect(parsed.job_admission_rejected).toBe(true)
    expect(parsed.retry_after_seconds).toBe(30)
  })

  test('extras are all optional — omitting them stays backward compatible', () => {
    const parsed = NATSystemResponseMessageSchema.parse(base)
    expect(parsed.routing_decision).toBeUndefined()
    expect(parsed.routing_reason).toBeUndefined()
    expect(parsed.escalation_reason).toBeUndefined()
    expect(parsed.answer_confidence_capped_reason).toBeUndefined()
    expect(parsed.citations_removed).toBeUndefined()
    expect(parsed.job_admission_rejected).toBeUndefined()
    expect(parsed.retry_after_seconds).toBeUndefined()
  })

  test('a malformed extra degrades to undefined without dropping the response text', () => {
    // Per-field `.catch(undefined)`: a bad `routing_decision` and a
    // wrong-shaped `citations_removed` must NOT kill the whole frame.
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      routing_decision: 'sideways', // out of enum
      citations_removed: 'nope', // wrong shape
      routing_reason: 'still valid',
    })
    expect(parsed.content).toBe('an answer')
    expect(parsed.routing_decision).toBeUndefined()
    expect(parsed.citations_removed).toBeUndefined()
    expect(parsed.routing_reason).toBe('still valid')
  })

  test('answer_confidence_capped_reason parses both grounding and quote causes', () => {
    const ungrounded = NATSystemResponseMessageSchema.parse({
      ...base,
      answer_confidence_capped_reason: 'ungrounded',
    })
    expect(ungrounded.answer_confidence_capped_reason).toBe('ungrounded')

    const quoteUnverified = NATSystemResponseMessageSchema.parse({
      ...base,
      answer_confidence_capped_reason: 'quote_unverified',
    })
    expect(quoteUnverified.answer_confidence_capped_reason).toBe('quote_unverified')
  })

  test('an unknown answer_confidence_capped_reason degrades to undefined (catch)', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      answer_confidence_capped_reason: 'made_up_reason', // out of enum
    })
    expect(parsed.content).toBe('an answer')
    expect(parsed.answer_confidence_capped_reason).toBeUndefined()
  })

  test('answer_confidence_reason parses when present', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      answer_confidence_reason: 'Direkt durch OIB-RL 2 belegt',
    })
    expect(parsed.answer_confidence_reason).toBe('Direkt durch OIB-RL 2 belegt')
  })

  test('answer_confidence_reason at exactly the wire cap is preserved', () => {
    const atCap = 'x'.repeat(ANSWER_CONFIDENCE_REASON_MAX_CHARS)
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      answer_confidence_reason: atCap,
    })
    expect(parsed.answer_confidence_reason).toBe(atCap)
  })

  test('answer_confidence_reason one char over the wire cap degrades to undefined (catch)', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      answer_confidence_reason: 'x'.repeat(ANSWER_CONFIDENCE_REASON_MAX_CHARS + 1),
    })
    expect(parsed.content).toBe('an answer')
    expect(parsed.answer_confidence_reason).toBeUndefined()
  })

  test('a non-string answer_confidence_reason degrades to undefined (catch)', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      answer_confidence_reason: 42,
    })
    expect(parsed.content).toBe('an answer')
    expect(parsed.answer_confidence_reason).toBeUndefined()
  })
})

describe('NATSystemResponseMessageSchema sources per-entry tolerance', () => {
  const base = {
    type: NATMessageType.SYSTEM_RESPONSE,
    status: WebSocketMessageStatus.COMPLETE,
    content: 'an answer',
  }

  test('a single malformed source is dropped while the valid ones survive', () => {
    const parsed = NATSystemResponseMessageSchema.parse({
      ...base,
      sources: [
        { title: 'Good A', url: 'https://a.example' },
        'totally malformed', // non-object entry
        { title: 'Good B', citation_key: 'B-1' },
      ],
    })

    expect(Array.isArray(parsed.sources)).toBe(true)
    expect(parsed.sources).toHaveLength(2)
    expect(parsed.sources?.map((s) => s?.title)).toEqual(['Good A', 'Good B'])
    // Response text is never dropped by a bad source entry.
    expect(parsed.content).toBe('an answer')
  })
})

describe('NATIncomingMessageSchema variant tolerance', () => {
  test('an observability_trace_message frame is accepted (not dropped)', () => {
    const result = NATIncomingMessageSchema.safeParse({
      type: NATMessageType.OBSERVABILITY_TRACE,
      id: 'trace-1',
      content: { span: 'orchestration', arbitrary: { nested: true } },
    })
    expect(result.success).toBe(true)
  })

  test('an unknown message type does not throw and is reported as unparseable', () => {
    // The client tolerates this (logs once + ignores); at the schema level it
    // must fail cleanly via safeParse rather than throwing.
    const result = NATIncomingMessageSchema.safeParse({
      type: 'brand_new_frame_type',
      content: 'whatever',
    })
    expect(result.success).toBe(false)
  })
})

describe('NATHumanPromptSchema option shapes', () => {
  /**
   * The regression this exists to prevent: NAT serialises a picker's choices as
   * objects, the schema demanded strings, and because `NATIncomingMessageSchema`
   * is a discriminated union that `websocket-client` safeParses, the WHOLE
   * system_interaction frame was discarded as unrecognised. The prompt never
   * rendered and the turn sat on its HITL future until the 30-minute timeout —
   * a failure with no error anywhere, which is why it needs a test and not a
   * comment.
   */
  test('accepts the object options a HumanPromptRadio actually emits', () => {
    const parsed = NATHumanPromptSchema.parse({
      input_type: 'radio',
      text: 'Welches Modell?',
      options: [
        { id: '1', label: 'AC20-Institute-Var-2.ifc', value: 'AC20-Institute-Var-2.ifc', description: '' },
        { id: '2', label: 'Ifc2x3_SampleCastle.ifc', value: 'Ifc2x3_SampleCastle.ifc', description: '' },
      ],
    })
    expect(parsed.options).toEqual(['AC20-Institute-Var-2.ifc', 'Ifc2x3_SampleCastle.ifc'])
  })

  test('still accepts bare string options', () => {
    const parsed = NATHumanPromptSchema.parse({
      input_type: 'radio',
      text: 'pick one',
      options: ['Alpha', 'Beta'],
    })
    expect(parsed.options).toEqual(['Alpha', 'Beta'])
  })

  /**
   * `value` is what the agent tier expects back — NAT re-wraps the reply into
   * `HumanResponse*.selected_option.value`. Normalising on `label` would send a
   * string the backend does not recognise.
   */
  test('normalises on value, so the answer round-trips even when the label differs', () => {
    const parsed = NATHumanPromptSchema.parse({
      input_type: 'dropdown',
      text: 'pick one',
      options: [{ label: 'Gebäudeklasse 4', value: 'GK4' }],
    })
    expect(parsed.options).toEqual(['GK4'])
  })

  test('rejects an option with no value rather than inventing one', () => {
    const result = NATHumanPromptSchema.safeParse({
      input_type: 'radio',
      text: 'pick one',
      options: [{ label: 'no value here' }],
    })
    expect(result.success).toBe(false)
  })
})

describe('NATHumanPromptSchema.input_type enum alignment', () => {
  test.each([
    HumanPromptType.TEXT,
    HumanPromptType.NOTIFICATION,
    HumanPromptType.BINARY_CHOICE,
    HumanPromptType.RADIO,
    HumanPromptType.CHECKBOX,
    HumanPromptType.DROPDOWN,
    HumanPromptType.OAUTH_CONSENT,
    // Legacy values kept for back-compat.
    HumanPromptType.MULTIPLE_CHOICE,
    HumanPromptType.APPROVAL,
  ])('accepts input_type %s', (inputType) => {
    const parsed = NATHumanPromptSchema.parse({ input_type: inputType, text: 'pick one' })
    expect(parsed.input_type).toBe(inputType)
  })

  test('rejects an input_type outside the enum', () => {
    const result = NATHumanPromptSchema.safeParse({ input_type: 'freeform', text: 'x' })
    expect(result.success).toBe(false)
  })
})
