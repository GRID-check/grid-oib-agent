/**
 * Stored Herleitung rows for reader specs, built the way the fold builds them:
 * a wire `Step` parsed by the generated schema, projected by `toStoredStep`.
 *
 * `fixtureSteps` reads a recorded turn from `shared/wire/v2/` at runtime,
 * walking up from `process.cwd()` (`shared/` is outside the image's build
 * context, see `card-json-schema.ts`). The same id again replaces the row,
 * newest wins, exactly as the fold keeps `steps`.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { stepFinishedSchema } from '@/adapters/api/wire-v2.generated'
import type { Step } from '@/adapters/api/wire-v2'
import { toStoredStep, type StoredThinkingStep } from '@/features/chat/lib/turn-events'

const AT = { userMessageId: 'msg-1', timestamp: '2026-09-27T10:00:00.000Z' }

/** One stored row from a wire step as a producer writes it (defaults restored). */
export const storedStep = (
  raw: Record<string, unknown>,
  at: Partial<typeof AT> = {}
): StoredThinkingStep =>
  toStoredStep(stepFinishedSchema.shape.step.parse(raw) as Step, { ...AT, ...at })

/** The rows a list of wire steps folds to: same id replaces, first position kept. */
export const storedSteps = (raws: Record<string, unknown>[]): StoredThinkingStep[] => {
  const byId = new Map<string, StoredThinkingStep>()
  for (const raw of raws) {
    const step = storedStep(raw)
    byId.set(step.id, step)
  }
  return [...byId.values()]
}

const fixtureDir = (): string => {
  let dir = process.cwd()
  for (;;) {
    const candidate = join(dir, 'shared', 'wire', 'v2')
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) throw new Error(`shared/wire/v2 not found above ${process.cwd()}`)
    dir = parent
  }
}

/** The stored rows of one recorded turn (`turn-answered.jsonl`, …). */
export const fixtureSteps = (file: string): StoredThinkingStep[] =>
  storedSteps(
    readFileSync(join(fixtureDir(), file), 'utf8')
      .split('\n')
      .filter((line) => line.trim())
      .map((line) => JSON.parse(line) as { type: string; step?: Record<string, unknown> })
      .filter((event) => event.type === 'STEP_STARTED' || event.type === 'STEP_FINISHED')
      .map((event) => event.step as Record<string, unknown>)
  )
