/**
 * Skill-activity intermediate-step payloads (backend → UI wire contract).
 *
 * The agent narrates its skill decisions as custom NAT intermediate steps named
 * `skill:<skillname>` (one per skill) and `skill_selection` (the round as a
 * whole), whose payload is a JSON object described here. This is the ONLY place
 * that shape is asserted; everything downstream consumes the parsed result.
 *
 * Tolerance follows the rest of this adapter layer: every field beyond `phase`
 * is optional with its own `.catch(undefined)`, and the object is
 * `.passthrough()`, so a backend that grows a field or mistypes one degrades to
 * "that detail is absent" rather than throwing away the step. `phase` is the
 * one required field — a payload that cannot say WHICH decision it reports is
 * not a skill-activity payload at all, and the caller drops it.
 *
 * `name` is optional because `skill_selection` describes the round rather than
 * one skill; for `skill:<skillname>` steps the name is also carried by the step
 * name itself, which is the fallback when a payload is malformed or missing.
 */

import { z } from 'zod'

/**
 * The decision this step reports.
 *   offered   — the skill was put in front of the model (availability).
 *   activated — the model chose it (`use_skill`).
 *   loaded    — its instruction body actually entered the context.
 */
export const SkillActivityPhaseSchema = z.enum(['offered', 'activated', 'loaded'])

export type SkillActivityPhaseWire = z.infer<typeof SkillActivityPhaseSchema>

export const SkillActivityPayloadSchema = z
  .object({
    phase: SkillActivityPhaseSchema,
    /** Skill name (the `/name` identifier). Absent on `skill_selection`. */
    name: z.string().optional().catch(undefined),
    /** Human-authored display title, when the skill has one. */
    title: z.string().optional().catch(undefined),
    description: z.string().optional().catch(undefined),
    origin: z.string().optional().catch(undefined),
    /** True when the turn pinned this skill rather than the model picking it. */
    forced: z.boolean().optional().catch(undefined),
    /** How many skills were offered this round (`skill_selection`). */
    offered_count: z.number().optional().catch(undefined),
    /** Names pinned by the turn (`skill_selection`). */
    forced_names: z.array(z.string()).optional().catch(undefined),
    /** Size of the loaded instruction body, in characters. */
    body_chars: z.number().optional().catch(undefined),
  })
  .passthrough()

export type SkillActivityPayload = z.infer<typeof SkillActivityPayloadSchema>
