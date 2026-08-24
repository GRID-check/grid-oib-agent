/**
 * @vitest-environment node
 */
import { describe, expect, test } from 'vitest'
import { mapHumanPromptType } from './use-websocket-chat'
import { HumanPromptType } from '@/adapters/api/websocket-client'

describe('mapHumanPromptType', () => {
  test.each([
    HumanPromptType.RADIO,
    HumanPromptType.CHECKBOX,
    HumanPromptType.DROPDOWN,
    // Legacy alias for the same choice rendering.
    HumanPromptType.MULTIPLE_CHOICE,
  ])('choice-shaped input %s maps to "choice" (OptionsList)', (inputType) => {
    expect(mapHumanPromptType(inputType)).toBe('choice')
  })

  test('text maps to "text-input"', () => {
    expect(mapHumanPromptType(HumanPromptType.TEXT)).toBe('text-input')
  })

  test.each([HumanPromptType.BINARY_CHOICE, HumanPromptType.APPROVAL])(
    '%s maps to "approval"',
    (inputType) => {
      expect(mapHumanPromptType(inputType)).toBe('approval')
    }
  )

  test('an unknown input type falls back to "clarification"', () => {
    expect(mapHumanPromptType('something_new')).toBe('clarification')
  })
})
