import { describe, test, expect } from 'vitest'
import {
  distributeBatchBytes,
  isDeterminate,
  shouldEmitProgress,
  summarizeTransfer,
  TransferRateEstimator,
  uploadedBytes,
  uploadPercent,
  uploadPhase,
  type ProgressFile,
} from './upload-progress'

const file = (overrides: Partial<ProgressFile> = {}): ProgressFile => ({
  id: 'f1',
  fileName: 'Brandschutzkonzept.pdf',
  fileSize: 1_000_000,
  status: 'uploading',
  progress: 0,
  ...overrides,
})

describe('uploadPhase', () => {
  test('a file with no slot yet is queued, not uploading', () => {
    expect(uploadPhase(file({ status: 'uploading' }))).toBe('queued')
  })

  test('a file that has a slot is uploading even before its first byte', () => {
    expect(uploadPhase(file({ status: 'uploading', uploadStartedAt: 1, bytesUploaded: 0 }))).toBe('uploading')
  })

  test.each([
    ['ingesting', 'processing'],
    ['deleting', 'processing'],
    ['success', 'ready'],
    ['failed', 'failed'],
    ['canceled', 'canceled'],
  ] as const)('%s maps to %s', (status, expected) => {
    expect(uploadPhase(file({ status }))).toBe(expected)
  })
})

describe('isDeterminate', () => {
  test('only bytes in flight have a real percentage', () => {
    expect(isDeterminate('uploading')).toBe(true)
    for (const phase of ['queued', 'processing', 'ready', 'failed', 'canceled'] as const) {
      expect(isDeterminate(phase)).toBe(false)
    }
  })
})

describe('uploadPercent', () => {
  test('reports the share of bytes sent while uploading', () => {
    expect(uploadPercent(file({ uploadStartedAt: 1, bytesUploaded: 250_000 }))).toBe(25)
  })

  test('is null in every phase that cannot be measured — never a stand-in number', () => {
    expect(uploadPercent(file({ status: 'ingesting' }))).toBeNull()
    expect(uploadPercent(file({ status: 'uploading' }))).toBeNull()
    expect(uploadPercent(file({ status: 'success' }))).toBeNull()
  })

  test('clamps a byte count that overshoots the declared size', () => {
    expect(uploadPercent(file({ uploadStartedAt: 1, bytesUploaded: 2_000_000 }))).toBe(100)
  })

  test('a zero-byte file has no percentage to report', () => {
    expect(uploadPercent(file({ fileSize: 0, uploadStartedAt: 1 }))).toBeNull()
  })
})

describe('uploadedBytes', () => {
  test('a file past the upload counts whole, however the last event landed', () => {
    expect(uploadedBytes(file({ status: 'ingesting', bytesUploaded: 10 }))).toBe(1_000_000)
    expect(uploadedBytes(file({ status: 'success', bytesUploaded: undefined }))).toBe(1_000_000)
  })

  test('a failure keeps what it managed to send, so the batch bar never runs backwards', () => {
    expect(uploadedBytes(file({ status: 'failed', bytesUploaded: 1_000_000 }))).toBe(1_000_000)
    expect(uploadedBytes(file({ status: 'failed', bytesUploaded: 400_000 }))).toBe(400_000)
  })
})

describe('summarizeTransfer', () => {
  test('counts each phase and totals bytes', () => {
    const summary = summarizeTransfer([
      file({ id: 'a', status: 'uploading', uploadStartedAt: 1, bytesUploaded: 500_000 }),
      file({ id: 'b', status: 'uploading' }),
      file({ id: 'c', status: 'ingesting' }),
      file({ id: 'd', status: 'success' }),
      file({ id: 'e', status: 'failed', bytesUploaded: 0 }),
    ])

    expect(summary).toMatchObject({
      total: 5,
      queued: 1,
      uploading: 1,
      processing: 1,
      ready: 1,
      failed: 1,
      settled: 2,
      stage: 'transferring',
      isSettled: false,
    })
    expect(summary.totalBytes).toBe(5_000_000)
    expect(summary.uploadedBytes).toBe(2_500_000)
    expect(summary.bytesPercent).toBe(50)
  })

  test('tracks bytes, not file count, so one huge file cannot be masked by many small ones', () => {
    const summary = summarizeTransfer([
      file({ id: 'model', fileSize: 150_000_000, status: 'uploading', uploadStartedAt: 1, bytesUploaded: 0 }),
      ...Array.from({ length: 11 }, (_, i) => file({ id: `p${i}`, fileSize: 200_000, status: 'success' })),
    ])

    // 11 of 12 files are done, but almost none of the payload has moved.
    expect(summary.ready).toBe(11)
    expect(summary.bytesPercent).toBe(1)
  })

  test('a canceled file leaves the denominator so the batch bar does not freeze', () => {
    const summary = summarizeTransfer([
      file({ id: 'a', status: 'success' }),
      file({ id: 'b', status: 'canceled', bytesUploaded: 100 }),
    ])

    expect(summary.totalBytes).toBe(1_000_000)
    expect(summary.bytesPercent).toBe(100)
    expect(summary.canceled).toBe(1)
  })

  test('stage moves transferring → processing → settled', () => {
    expect(summarizeTransfer([file({ status: 'uploading' })]).stage).toBe('transferring')
    expect(summarizeTransfer([file({ status: 'ingesting' })]).stage).toBe('processing')
    expect(summarizeTransfer([file({ status: 'success' })]).stage).toBe('settled')
    expect(summarizeTransfer([file({ status: 'success' })]).isSettled).toBe(true)
  })

  test('an empty batch is settled with no percentage', () => {
    const summary = summarizeTransfer([])
    expect(summary.isSettled).toBe(true)
    expect(summary.bytesPercent).toBeNull()
  })
})

describe('shouldEmitProgress', () => {
  test('coalesces sub-percent deltas on a large file', () => {
    expect(shouldEmitProgress(0, 1_000, 100_000_000)).toBe(false)
    expect(shouldEmitProgress(0, 1_000_000, 100_000_000)).toBe(true)
  })

  test('a small file still animates — the floor is 64 KB, not one percent', () => {
    expect(shouldEmitProgress(0, 70_000, 200_000)).toBe(true)
  })

  test('the final byte always lands, whatever the step', () => {
    expect(shouldEmitProgress(999_999, 1_000_000, 1_000_000)).toBe(true)
  })

  test('never moves backwards', () => {
    expect(shouldEmitProgress(500, 400, 1_000)).toBe(false)
    expect(shouldEmitProgress(500, 500, 1_000)).toBe(false)
  })
})

describe('distributeBatchBytes', () => {
  test('fills the parts in wire order', () => {
    expect(distributeBatchBytes(150, 300, [100, 100, 100])).toEqual([100, 50, 0])
  })

  test('scales out the multipart framing so no file reads ahead of the truth', () => {
    // 300 payload bytes in a 600-byte body: half the body sent is 150 payload.
    expect(distributeBatchBytes(300, 600, [100, 100, 100])).toEqual([100, 50, 0])
  })

  test('never exceeds a part, even when the whole body has been sent', () => {
    expect(distributeBatchBytes(600, 600, [100, 100, 100])).toEqual([100, 100, 100])
  })

  test('degenerate inputs produce zeroes rather than NaN', () => {
    expect(distributeBatchBytes(10, 0, [100])).toEqual([0])
    expect(distributeBatchBytes(10, 100, [0, 0])).toEqual([0, 0])
  })
})

describe('TransferRateEstimator', () => {
  test('withholds a rate until there is enough signal to state one', () => {
    const estimator = new TransferRateEstimator()
    expect(estimator.bytesPerSecond()).toBeNull()
    estimator.sample(0, 1_000)
    expect(estimator.bytesPerSecond()).toBeNull()
    estimator.sample(1_000, 1_100) // only 100 ms of evidence
    expect(estimator.bytesPerSecond()).toBeNull()
  })

  test('reports bytes per second over the window', () => {
    const estimator = new TransferRateEstimator()
    estimator.sample(0, 1_000)
    estimator.sample(2_000_000, 3_000)
    expect(estimator.bytesPerSecond()).toBe(1_000_000)
  })

  test('forgets samples outside the window, so a rate change is followed', () => {
    const estimator = new TransferRateEstimator(2_000)
    estimator.sample(0, 0)
    estimator.sample(10_000_000, 1_000) // a fast first second
    estimator.sample(10_100_000, 3_000)
    estimator.sample(10_200_000, 5_000) // then 50 KB/s
    expect(estimator.bytesPerSecond()).toBe(50_000)
  })

  test('an ETA is a division, and it is null when the rate is unknown', () => {
    const estimator = new TransferRateEstimator()
    expect(estimator.etaSeconds(1_000_000)).toBeNull()
    estimator.sample(0, 1_000)
    estimator.sample(1_000_000, 2_000)
    expect(estimator.etaSeconds(5_000_000)).toBe(5)
    expect(estimator.etaSeconds(0)).toBe(0)
  })

  test('a rewind (a reused estimator, a new batch) resets rather than going negative', () => {
    const estimator = new TransferRateEstimator()
    estimator.sample(5_000_000, 1_000)
    estimator.sample(0, 2_000)
    estimator.sample(1_000_000, 3_000)
    expect(estimator.bytesPerSecond()).toBe(1_000_000)
  })

  test('a stalled transfer reports no rate rather than a stale one', () => {
    const estimator = new TransferRateEstimator(2_000)
    estimator.sample(1_000_000, 0)
    estimator.sample(1_000_000, 4_000)
    expect(estimator.bytesPerSecond()).toBeNull()
  })
})
