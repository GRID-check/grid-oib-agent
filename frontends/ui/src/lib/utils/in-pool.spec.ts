import { describe, expect, it } from 'vitest'
import { inPool } from './in-pool'

describe('inPool', () => {
  it('never runs more than the limit at once, and keeps the results in the order of the items', async () => {
    let running = 0
    let most = 0
    const results = await inPool([5, 1, 4, 2, 3], 2, async (n) => {
      running += 1
      most = Math.max(most, running)
      await new Promise((resolve) => setTimeout(resolve, n))
      running -= 1
      return n * 10
    })
    expect(most).toBe(2)
    expect(results).toEqual([50, 10, 40, 20, 30])
  })

  it('runs nothing for no items', async () => {
    expect(await inPool([], 4, async () => 1)).toEqual([])
  })
})
