import { describe, expect, it } from 'vitest'
import { newChatDropsFilePreview } from './ask-arrival'

describe('newChatDropsFilePreview', () => {
  it('drops the peek for an empty new chat', () => {
    expect(newChatDropsFilePreview(null)).toBe(true)
    expect(newChatDropsFilePreview('')).toBe(true)
    expect(newChatDropsFilePreview('   ')).toBe(true)
  })

  it('keeps the peek when the new chat is about a file', () => {
    expect(newChatDropsFilePreview('doc-9')).toBe(false)
  })
})
