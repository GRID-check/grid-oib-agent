import { z } from 'zod'

export const turnContextRequestSchema = z.object({
  query: z.string().trim().max(2000).optional(),
}).strict()

export const turnContextResponseSchema = z.object({
  projectContext: z.string().nullable(),
  projectMemory: z.string().nullable(),
  orgInstructions: z.string().nullable(),
}).strict()

export const turnContextApiResponseSchema = z.object({ data: turnContextResponseSchema }).strict()

export type TurnContextRequest = z.infer<typeof turnContextRequestSchema>
export type TurnContextResponse = z.infer<typeof turnContextResponseSchema>
export type TurnContextApiResponse = z.infer<typeof turnContextApiResponseSchema>
