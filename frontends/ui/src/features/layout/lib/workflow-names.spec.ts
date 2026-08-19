/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { de, en } from '@/i18n/dictionaries'
import { createTranslator } from '@/i18n/translate'
import { getWorkflowLabel, getWorkflowTitle } from './workflow-names'

const tDe = createTranslator(de, 'research')
const tEn = createTranslator(en, 'research')

describe('getWorkflowLabel', () => {
  test('names every role the deep-research graph declares', () => {
    // The four names `aiq_agent/agents/deep_researcher/factory.py` gives its
    // subagents — the only values the backend's `_is_agent_like` rule lets
    // through for this graph.
    expect(getWorkflowLabel('planner-agent', tDe)).toBe('Planung')
    expect(getWorkflowLabel('researcher-agent', tDe)).toBe('Recherche')
    expect(getWorkflowLabel('source-router-agent', tDe)).toBe('Quellenauswahl')
    expect(getWorkflowLabel('writer-agent', tDe)).toBe('Berichtstext')

    expect(getWorkflowLabel('planner-agent', tEn)).toBe('Planning')
    expect(getWorkflowLabel('researcher-agent', tEn)).toBe('Research')
    expect(getWorkflowLabel('source-router-agent', tEn)).toBe('Source selection')
    expect(getWorkflowLabel('writer-agent', tEn)).toBe('Report writing')
  })

  test('an identifier this build cannot name never reaches the reader', () => {
    // The backend attributes work to any enclosing chain whose name merely
    // contains "agent", so a framework span name really does arrive here — and
    // an id is not prose, in either locale.
    expect(getWorkflowLabel('ClassificationAssistant', tDe)).toBe('intern')
    expect(getWorkflowLabel('some-new-agent', tDe)).toBe('intern')
    expect(getWorkflowLabel('ClassificationAssistant', tEn)).toBe('internal')
  })

  test('is not confused by the casing or the padding the wire may carry', () => {
    expect(getWorkflowLabel('  Researcher-Agent ', tDe)).toBe('Recherche')
  })
})

describe('getWorkflowTitle', () => {
  test('names the known roles exactly as the sentence form does', () => {
    // One role, one wording, whether it heads a card in the Agenten tab or
    // completes „Schritt: …" on a thought card.
    expect(getWorkflowTitle('planner-agent', tDe)).toBe('Planung')
    expect(getWorkflowTitle('writer-agent', tDe)).toBe('Berichtstext')
    expect(getWorkflowTitle('source-router-agent', tEn)).toBe('Source selection')
    expect(getWorkflowTitle('  Researcher-Agent ', tDe)).toBe('Recherche')
  })

  test('spells the noun out for an unknown role, because a heading has no sentence', () => {
    // „intern läuft" is not something anybody says.
    expect(getWorkflowTitle('some-new-agent', tDe)).toBe('Interner Schritt')
    expect(getWorkflowTitle('ClassificationAssistant', tEn)).toBe('Internal step')
  })
})
