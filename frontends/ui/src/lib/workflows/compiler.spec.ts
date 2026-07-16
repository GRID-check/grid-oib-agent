import { describe, expect, it } from 'vitest'
import { compileWorkflowPrompt } from './compiler'
import { MAX_COMPILED_PROMPT_LENGTH, type WorkflowDefinition } from './types'
import { BadRequestError } from '@/lib/api/errors'

const def = (blocks: Partial<WorkflowDefinition['blocks']>): WorkflowDefinition => ({
  version: 1,
  blocks: { objective: 'Study X', ...blocks },
})

describe('compileWorkflowPrompt', () => {
  it('is deterministic — identical input yields byte-for-byte identical output', () => {
    const d = def({
      context: 'Some background',
      questions: ['Q1', 'Q2'],
      outputFormat: 'Executive summary',
    })
    expect(compileWorkflowPrompt(d)).toBe(compileWorkflowPrompt(d))
  })

  it('renders all sections in fixed order with a numbered question list', () => {
    const out = compileWorkflowPrompt(
      def({
        context: 'Regulatory context here.',
        questions: ['What is the load?', 'Which standard applies?'],
        outputFormat: 'Executive summary + table of sources',
      }),
    )
    expect(out).toBe(
      [
        '# Objective\n\nStudy X',
        '# Background & Context\n\nRegulatory context here.',
        '# Research questions\n\n1. What is the load?\n2. Which standard applies?',
        '# Output requirements\n\nExecutive summary + table of sources',
      ].join('\n\n'),
    )
  })

  it('omits empty sections entirely (no empty headings)', () => {
    const out = compileWorkflowPrompt(def({ objective: 'Only an objective' }))
    expect(out).toBe('# Objective\n\nOnly an objective')
    expect(out).not.toContain('Background')
    expect(out).not.toContain('Research questions')
    expect(out).not.toContain('Output requirements')
  })

  it('drops blank/whitespace-only questions and trims blocks', () => {
    const out = compileWorkflowPrompt(
      def({ objective: '  Trimmed objective  ', questions: ['Real question', '   ', ''] }),
    )
    expect(out).toBe('# Objective\n\nTrimmed objective\n\n# Research questions\n\n1. Real question')
  })

  it('omits the questions section when the list has no non-empty entries', () => {
    const out = compileWorkflowPrompt(def({ questions: ['', '   '] }))
    expect(out).toBe('# Objective\n\nStudy X')
  })

  it('throws when the objective is effectively empty', () => {
    expect(() => compileWorkflowPrompt(def({ objective: '   ' }))).toThrow(BadRequestError)
  })

  it('enforces the compiled-length cap', () => {
    const huge = 'x'.repeat(MAX_COMPILED_PROMPT_LENGTH + 1)
    expect(() => compileWorkflowPrompt(def({ objective: huge }))).toThrow(BadRequestError)
  })

  it('accepts a brief exactly at the length cap', () => {
    // '# Objective\n\n' is 13 chars; pad the objective so the total equals the cap.
    const objective = 'x'.repeat(MAX_COMPILED_PROMPT_LENGTH - '# Objective\n\n'.length)
    const out = compileWorkflowPrompt(def({ objective }))
    expect(out.length).toBe(MAX_COMPILED_PROMPT_LENGTH)
  })
})
