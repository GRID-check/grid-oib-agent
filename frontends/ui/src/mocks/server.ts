/**
 * MSW Server Setup
 *
 * Configures MSW for Node environment (SSR, tests).
 * Uses node interceptors instead of service worker.
 */

import { setupServer } from 'msw/node'
import { handlers } from './handlers'

export const server = setupServer(...handlers)
