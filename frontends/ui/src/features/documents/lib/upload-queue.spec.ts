import { describe, test, expect, vi } from 'vitest'
import { runWithConcurrency, UPLOAD_CONCURRENCY } from './upload-queue'

/** A worker that never resolves until the test releases it. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runWithConcurrency', () => {
  test('never runs more than the limit at once', async () => {
    const gates = [deferred<string>(), deferred<string>(), deferred<string>(), deferred<string>()]
    let started = 0
    let peak = 0

    const pending = runWithConcurrency([0, 1, 2, 3], 2, async (index) => {
      started += 1
      peak = Math.max(peak, started)
      const value = await gates[index].promise
      started -= 1
      return value
    })

    expect(peak).toBe(2)
    gates.forEach((gate, index) => gate.resolve(`v${index}`))
    await pending
    expect(peak).toBe(2)
  })

  test('a slot freed by one item is taken by the next', async () => {
    const order: number[] = []
    await runWithConcurrency([0, 1, 2, 3, 4], 2, async (index) => {
      order.push(index)
      return index
    })

    expect(order).toEqual([0, 1, 2, 3, 4])
  })

  test('results keep input order regardless of completion order', async () => {
    const results = await runWithConcurrency([30, 10, 20], 3, async (delay) => {
      await new Promise((resolve) => setTimeout(resolve, delay))
      return delay
    })

    expect(results).toEqual([
      { status: 'fulfilled', value: 30 },
      { status: 'fulfilled', value: 10 },
      { status: 'fulfilled', value: 20 },
    ])
  })

  test('one rejection does not take the batch down with it', async () => {
    const worker = vi.fn(async (index: number) => {
      if (index === 1) throw new Error('refused')
      return index
    })

    const results = await runWithConcurrency([0, 1, 2], 2, worker)

    expect(worker).toHaveBeenCalledTimes(3)
    expect(results[0]).toEqual({ status: 'fulfilled', value: 0 })
    expect(results[1]).toMatchObject({ status: 'rejected' })
    expect(results[2]).toEqual({ status: 'fulfilled', value: 2 })
  })

  test('an empty batch does nothing and returns nothing', async () => {
    const worker = vi.fn()
    await expect(runWithConcurrency([], 3, worker)).resolves.toEqual([])
    expect(worker).not.toHaveBeenCalled()
  })

  test('the shipped limit leaves room for the polling that runs alongside it', () => {
    // Browsers allow six connections per host; the ingest-status poll and the
    // page's own traffic share the same budget.
    expect(UPLOAD_CONCURRENCY).toBeLessThan(6)
    expect(UPLOAD_CONCURRENCY).toBeGreaterThan(1)
  })
})
