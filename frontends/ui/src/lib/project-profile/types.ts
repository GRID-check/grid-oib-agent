import { z } from 'zod'

export const ProjectPrimitiveValueSchema = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.null()])

export const ProjectFactSchema = z.object({
  value: ProjectPrimitiveValueSchema,
  confidence: z.literal('confirmed'),
  source: z.enum(['onboarding', 'user_confirmed', 'admin_edit']),
  updatedAt: z.string(),
})

export const ProjectAssumptionSchema = z.object({
  value: ProjectPrimitiveValueSchema,
  status: z.literal('unconfirmed'),
  reason: z.string(),
  source: z.enum(['agent_suggested', 'onboarding_default']),
  updatedAt: z.string(),
})

export const ProjectProfileSchema = z.object({
  facts: z.record(z.string(), ProjectFactSchema).default({}),
  goals: z.record(z.string(), ProjectPrimitiveValueSchema).default({}),
  unknowns: z.array(z.string()).default([]),
  assumptions: z.record(z.string(), ProjectAssumptionSchema).default({}),
})

export const ProjectProfileDisplaySchema = z.object({
  title: z.string(),
  summary: z.string(),
  keyFacts: z.array(z.object({ label: z.string(), value: z.string() })),
  missingInfo: z.array(z.string()),
})

export const safePatchPath = /^\/(facts|goals|unknowns|assumptions)(\/.*)?$/

export const ProjectProfilePatchOperationSchema = z.object({
  op: z.enum(['add', 'replace', 'remove']),
  path: z.string().refine((path) => safePatchPath.test(path), 'Unsafe project profile patch path')
    .refine((path) => !path.split('/').includes('..'), 'Path must not contain .. segments'),
  value: z.unknown().optional(),
})

export type ProjectPrimitiveValue = z.infer<typeof ProjectPrimitiveValueSchema>
export type ProjectFact = z.infer<typeof ProjectFactSchema>
export type ProjectAssumption = z.infer<typeof ProjectAssumptionSchema>
export type ProjectProfile = z.infer<typeof ProjectProfileSchema>
export type ProjectProfileDisplay = z.infer<typeof ProjectProfileDisplaySchema>
export type ProjectProfilePatchOperation = z.infer<typeof ProjectProfilePatchOperationSchema>
