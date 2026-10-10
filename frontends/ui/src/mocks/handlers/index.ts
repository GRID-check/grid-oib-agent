/**
 * MSW Handler Exports
 *
 * Combines all MSW handlers for use in browser and server setups.
 */

import { documentHandlers } from './documents'
import { uploadScreeningHandlers } from './upload-screening'
import { userPreferencesHandlers } from './user-preferences'

export const handlers = [...documentHandlers, ...userPreferencesHandlers, ...uploadScreeningHandlers]

// Re-export individual handler groups for selective use in tests
export { documentHandlers }
export { userPreferencesHandlers }
export { uploadScreeningHandlers }
export { resetDocumentMockState } from './documents'

// Re-export database utilities for test isolation
export { resetDatabase } from '../database'
