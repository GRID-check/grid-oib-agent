/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { closesCodeFence, fencedBlock, openingCodeFence } from './code-fence'

describe('fencedBlock', () => {
  it('uses three backticks for text without any', () => {
    expect(fencedBlock('hello @maria #12')).toBe('```text\nhello @maria #12\n```')
  })

  it('outruns the longest backtick run, so the text cannot close it', () => {
    const text = 'before\n````\nafter'
    const block = fencedBlock(text)
    const lines = block.split('\n')
    const fence = openingCodeFence(lines[0]!)
    expect(fence).toEqual({ char: '`', length: 5 })
    // Only the last line closes it: the quoted run is too short.
    expect(lines.slice(1).map((line) => closesCodeFence(line, fence!))).toEqual([false, false, false, true])
  })
})
