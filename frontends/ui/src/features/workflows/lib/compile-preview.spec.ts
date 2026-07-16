import { describe, expect, test } from 'vitest'
import { compilePreview } from './compile-preview'
import type { WorkflowDefinition } from '@/adapters/api/workflows-client'

const define = (blocks: WorkflowDefinition['blocks']): WorkflowDefinition => ({
  version: 1,
  blocks,
})

describe('compilePreview', () => {
  test('emits all sections in fixed order with a numbered question list', () => {
    const output = compilePreview(
      define({
        objective: 'Summarize OIB-Richtlinie 2 changes',
        context: 'For a mixed-use project in Vienna',
        questions: ['What changed in 2023?', 'Impact on fire compartments?'],
        outputFormat: 'Executive summary plus a table of sources',
      }),
    )
    expect(output).toBe(
      [
        '# Objective\n\nSummarize OIB-Richtlinie 2 changes',
        '# Background & Context\n\nFor a mixed-use project in Vienna',
        '# Research questions\n\n1. What changed in 2023?\n2. Impact on fire compartments?',
        '# Output requirements\n\nExecutive summary plus a table of sources',
      ].join('\n\n'),
    )
  })

  test('omits empty and whitespace-only sections', () => {
    const output = compilePreview(
      define({ objective: 'Only an objective', context: '   ', questions: ['', '  '] }),
    )
    expect(output).toBe('# Objective\n\nOnly an objective')
    expect(output).not.toContain('Background')
    expect(output).not.toContain('Research questions')
  })

  test('trims each block and drops blank questions while renumbering', () => {
    const output = compilePreview(
      define({ objective: '  Trim me  ', questions: ['  first  ', '', 'second'] }),
    )
    expect(output).toContain('# Objective\n\nTrim me')
    expect(output).toContain('1. first\n2. second')
  })

  test('is deterministic — identical input yields identical output', () => {
    const def = define({
      objective: 'Objective',
      context: 'Context',
      questions: ['Q1', 'Q2'],
      outputFormat: 'Format',
    })
    expect(compilePreview(def)).toBe(compilePreview(def))
  })

  test('returns an empty string when nothing is filled in', () => {
    expect(compilePreview(define({ objective: '' }))).toBe('')
  })
})

// Drift guards: the client preview must stay byte-for-byte aligned with the
// server compiler and its length cap (the WYSIWYG contract, ADR-0023).
import { compileWorkflowPrompt } from '@/lib/workflows/compiler'
import { MAX_COMPILED_PROMPT_LENGTH as SERVER_MAX_COMPILED_PROMPT_LENGTH } from '@/lib/workflows/types'
import { MAX_COMPILED_PROMPT_LENGTH } from './compile-preview'

describe('server-compiler alignment', () => {
  test('length cap matches the server constant', () => {
    expect(MAX_COMPILED_PROMPT_LENGTH).toBe(SERVER_MAX_COMPILED_PROMPT_LENGTH)
  })

  test('preview output is byte-for-byte the server compiler output', () => {
    const definitions: WorkflowDefinition[] = [
      { version: 1, blocks: { objective: 'Study X' } },
      {
        version: 1,
        blocks: {
          objective: 'Study X',
          context: 'Background info\nwith lines',
          questions: ['Q1?', '  ', 'Q2?'],
          outputFormat: 'Executive summary',
        },
      },
      { version: 1, blocks: { objective: '  padded  ', questions: [] } },
    ]
    for (const definition of definitions) {
      expect(compilePreview(definition)).toBe(compileWorkflowPrompt(definition))
    }
  })
})
