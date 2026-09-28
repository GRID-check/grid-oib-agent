import { afterEach, describe, expect, it, vi } from 'vitest'
import { MERMAID_TASK_TIMEOUT_MS, serialized, withMermaid } from './render-diagram'

describe('mermaid renders one at a time', () => {
  it('never starts a task before the previous one finished', async () => {
    // The shape of the bug: configure a global, await, read it back. Run
    // concurrently, the second configure lands inside the first's await.
    let global = ''
    const events: string[] = []
    const render = serialized(async (theme: string) => {
      global = theme
      await new Promise((resolve) => setTimeout(resolve, theme === 'dark' ? 20 : 1))
      events.push(`${theme}:${global}`)
      return global
    })
    const results = await Promise.all([render('dark'), render('light'), render('dark')])
    expect(results).toEqual(['dark', 'light', 'dark'])
    expect(events).toEqual(['dark:dark', 'light:light', 'dark:dark'])
  })

  it('keeps going after a task fails', async () => {
    const render = serialized(async (fail: boolean) => {
      if (fail) throw new Error('broken mermaid')
      return 'drawn'
    })
    await expect(render(true)).rejects.toThrow('broken mermaid')
    await expect(render(false)).resolves.toBe('drawn')
  })
})

describe('the mermaid lock', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('is released by a task that never settles, so the next diagram still draws', async () => {
    vi.useFakeTimers()
    const stuck = withMermaid(() => new Promise<string>(() => {}))
    const next = withMermaid(async () => 'drawn')
    const failed = expect(stuck).rejects.toThrow(/in time/)
    await vi.advanceTimersByTimeAsync(MERMAID_TASK_TIMEOUT_MS)
    await failed
    await expect(next).resolves.toBe('drawn')
  })
})
