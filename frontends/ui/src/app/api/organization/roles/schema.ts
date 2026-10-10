/**
 * The body both role routes read. WorkOS keeps names and descriptions short;
 * these bound what the editor sends, and the client reads the same limits.
 */

import { z } from 'zod'
import { ROLE_DESCRIPTION_MAX, ROLE_NAME_MAX } from '@/lib/authz/role-limits'

export const roleFieldsSchema = z.object({
  name: z.string().trim().min(1).max(ROLE_NAME_MAX),
  description: z
    .string()
    .trim()
    .max(ROLE_DESCRIPTION_MAX)
    .nullish()
    .transform((value): string | null => (value ? value : null)),
  permissions: z.array(z.string().trim().min(1).max(100)).max(50),
})
