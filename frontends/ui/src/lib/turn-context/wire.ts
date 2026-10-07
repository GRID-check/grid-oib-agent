import { z } from 'zod'

export const turnContextRequestSchema = z.object({
  query: z.string().trim().max(2000).optional(),
}).strict()

export const turnContextResponseSchema = z.object({
  projectContext: z.string().nullable(),
  projectMemory: z.string().nullable(),
  orgInstructions: z.string().nullable(),
  /**
   * The conversation drew on another project that still restricts its readers
   * (an active one, ADR-0085): the turn starts with every door a whole project
   * reads shut, memory included, instead of learning it from a refusal. Content
   * from a closed project does not count.
   */
  drewOnOtherProjects: z.boolean(),
  /**
   * The office's reference projects, one line each: the closed projects most
   * like this one (`lib/cross-project/reference-brief.ts`), so the agent can
   * look there unasked. Null when the office has none.
   */
  referenceProjects: z.string().nullable(),
}).strict()

export const turnContextApiResponseSchema = z.object({ data: turnContextResponseSchema }).strict()

export type TurnContextRequest = z.infer<typeof turnContextRequestSchema>
export type TurnContextResponse = z.infer<typeof turnContextResponseSchema>
export type TurnContextApiResponse = z.infer<typeof turnContextApiResponseSchema>
