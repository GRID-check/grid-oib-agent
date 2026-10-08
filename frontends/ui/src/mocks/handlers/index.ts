/**
 * MSW Handler Exports
 *
 * Combines all MSW handlers for use in browser and server setups.
 */

import { conversationHandlers } from './conversations'
import { documentHandlers } from './documents'
import { userPreferencesHandlers } from './user-preferences'

export const handlers = [...documentHandlers, ...userPreferencesHandlers, ...conversationHandlers]

// Re-export individual handler groups for selective use in tests
export { conversationHandlers }
export { documentHandlers }
export { userPreferencesHandlers }
export { resetDocumentMockState } from './documents'

// Re-export database utilities for test isolation
export { resetDatabase } from '../database'
