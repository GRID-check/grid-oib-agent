/**
 * The spellings a legal-hold refusal travels under, declared once.
 *
 * `LEGAL_HOLD_SQLSTATE` is what the database's delete triggers raise
 * (`grid_refuse_held_delete`, migration 0093); `LEGAL_HOLD_REASON` is the
 * `details.reason` of the 409 a client keys its copy on. The service check
 * (`./holds`) and the route wrapper's mapping of the trigger
 * (`@/lib/api/handler`) both answer with it, so a hold reads the same whichever
 * layer caught it. No imports, so the route wrapper can read these without
 * pulling in the repository.
 */

/** This repository's own SQLSTATE; class `GL` is unassigned by the standard. */
export const LEGAL_HOLD_SQLSTATE = 'GLH01'

export const LEGAL_HOLD_REASON = 'legal_hold'

export const LEGAL_HOLD_MESSAGE = 'This item is under a legal hold and cannot be deleted.'
