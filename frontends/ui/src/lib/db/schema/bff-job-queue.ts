import { integer, jsonb, pgTable, smallint, text, timestamp, uuid } from 'drizzle-orm/pg-core'

/**
 * The BFF's durable background-work queue (ADR-0079, migration 0104).
 *
 * One row is one job a `bff-jobs` replica claims and runs. The claim itself
 * (fair across lanes, `FOR UPDATE SKIP LOCKED`, heartbeat, release, dead rows)
 * is SQL in `workers/job-queue.js`, because the runner is a plain Node process
 * with no build step and the BFF must not carry a second copy of it. This file
 * is the typed shape of the rows for the BFF's own side: enqueueing, and
 * reading a job's state back.
 *
 * `lane` is the organization id: the unit of fairness AND of tenancy, which is
 * why the table's policy compares it to `grid_current_org()`.
 */

/** `0` goes before `1` inside one lane. A person's request is interactive, a sweep is bulk. */
export const BFF_JOB_PRIORITY = { interactive: 0, bulk: 1 } as const
export type BffJobPriorityName = keyof typeof BFF_JOB_PRIORITY
export type BffJobPriority = (typeof BFF_JOB_PRIORITY)[BffJobPriorityName]

/**
 * `dead` is a job that failed every claim it had; it stays for an operator until
 * its retention (`dead_at` plus `GRID_BFF_JOBS_DEAD_RETENTION_DAYS`), and nothing
 * claims it. Its payload is reduced to identifiers when it goes dead.
 */
export type BffJobStatus = 'queued' | 'claimed' | 'dead'

export const bffJobQueue = pgTable('bff_job_queue', {
  jobId: uuid('job_id').primaryKey().defaultRandom(),
  kind: text('kind').notNull(),
  lane: text('lane').notNull(),
  priority: smallint('priority').$type<BffJobPriority>().notNull().default(0),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
  status: text('status').$type<BffJobStatus>().notNull().default('queued'),
  attempts: integer('attempts').notNull().default(0),
  claimedBy: text('claimed_by'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  heartbeatAt: timestamp('heartbeat_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastError: text('last_error'),
  /** A failed job is not claimed again before this (the retry backoff, migration 0106); null is no wait. */
  notBefore: timestamp('not_before', { withTimezone: true }),
  /** When the job went dead, which its retention counts from; set exactly when `status = 'dead'`. */
  deadAt: timestamp('dead_at', { withTimezone: true }),
})

/** When each lane was last served: the claim's second ordering key. */
export const bffJobLaneTurns = pgTable('bff_job_lane_turns', {
  lane: text('lane').primaryKey(),
  lastClaimedAt: timestamp('last_claimed_at', { withTimezone: true }),
})

export type BffJobRow = typeof bffJobQueue.$inferSelect
export type NewBffJobRow = typeof bffJobQueue.$inferInsert
