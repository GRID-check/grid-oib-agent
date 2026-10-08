/**
 * What the database answers when something is filed into a deleted folder
 * (migration 0113, `grid_refuse_write_into_deleted_folder`): its own SQLSTATE
 * (class `GF`, unassigned by the standard), which `lib/api/handler.ts` answers
 * as the folder being gone. Kept apart, like `legal-hold-codes.ts`, so the
 * handler imports a constant and not the bin's services.
 */

export const FOLDER_DELETED_SQLSTATE = 'GFD01'

/** `details.reason` on that answer. */
export const FOLDER_DELETED_REASON = 'folder_deleted'
