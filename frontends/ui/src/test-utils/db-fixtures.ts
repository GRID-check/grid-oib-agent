/**
 * Complete database-row fixtures for specs that mock the repository layer.
 *
 * A repository mock has to resolve to a whole row — the service code under test
 * reads fields the assertion does not care about. Specs used to paper over that
 * with `{ collectionName: 'x' } as any`, which meant a schema change could not
 * break them. These factories return real rows, so a renamed or retyped column
 * surfaces as a compile error, while `overrides` keeps each test's intent to
 * the one or two fields it is actually about.
 */

import type { getDb } from '@/lib/db'
import type { Document, Project, ProjectMemoryItem } from '@/lib/db/schema'

/**
 * The one place a hand-built drizzle query-builder stub widens to the real
 * database handle.
 *
 * A spec that mocks `getDb` asserts on which chain the code under test walks
 * (`select().from().where()`, `update().set().where()`, …) and on the conditions
 * it builds, so each stub implements only the links its test traverses — no
 * partial stub can satisfy drizzle's own type. Keeping the assertion here rather
 * than re-deriving it per spec means the escape hatch stays a single audited
 * boundary instead of drifting into a different shape in every file.
 */
export const asDb = (stub: Record<string, unknown>): ReturnType<typeof getDb> =>
  stub as unknown as ReturnType<typeof getDb>

/** A `projects` row as `findProjectInOrg` returns it. */
export const makeProject = (overrides: Partial<Project> = {}): Project => ({
  id: 'proj-1',
  organizationId: 'org-1',
  name: 'Test project',
  createdBy: 'user-1',
  collectionName: 'proj_abc',
  workosResourceId: null,
  profile: { facts: {}, goals: {}, unknowns: [], assumptions: {} },
  profileVersion: 1,
  profilePromptView: null,
  profileDisplay: null,
  profileUpdatedAt: null,
  deletedAt: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
})

/** A `project_memory` row as the memory service returns it. */
export const makeMemoryItem = (
  overrides: Partial<ProjectMemoryItem> = {},
): ProjectMemoryItem => ({
  id: 'item-1',
  scope: 'project',
  projectId: 'proj-1',
  organizationId: 'org-1',
  kind: 'derived_fact',
  content: 'The roof load is 2 kN/m2.',
  status: 'active',
  confidence: 'medium',
  verification: 'unverified',
  provenanceType: 'agent',
  sourceConversationId: null,
  supersedesId: null,
  salience: 0.5,
  pinned: false,
  createdBy: null,
  lastReferencedAt: null,
  createdAt: new Date('2026-07-01T00:00:00Z'),
  updatedAt: new Date('2026-07-01T00:00:00Z'),
  ...overrides,
})

/** A `documents` row as `findDocumentInOrg` returns it. */
export const makeDocument = (overrides: Partial<Document> = {}): Document => ({
  id: 'doc-1',
  organizationId: 'org-1',
  projectId: 'proj-1',
  scope: 'project',
  // Only a `scope: 'session'` row names a conversation (migration 0049's CHECK
  // constraint says so in both directions), and the default fixture is an
  // ordinary project document.
  conversationId: null,
  createdBy: 'user-1',
  // A person uploaded it, which is what every row means until a commissioned run
  // writes one. `documents_authorship_requires_provenance` ties the other two to
  // that choice, so an override that makes this anything but `user` has to set
  // both of them or the fixture describes a row the database would reject
  // (migration 0063).
  authoredBy: 'user',
  authoredByProducer: null,
  authoredByRunId: null,
  filename: 'plan.pdf',
  // Not renamed — what every document is until somebody renames it.
  displayName: null,
  storageKey: 'org/org-1/project/proj-1/doc/doc-1/plan.pdf',
  // NULL is what every row written before migration 0033 carries, and it means
  // the shared bucket — so it is the right default for a fixture standing in
  // for "an ordinary existing document".
  storageBucket: null,
  collectionName: 'proj_abc',
  fileSize: 1024,
  contentType: 'application/pdf',
  status: 'completed',
  deletedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z'),
  errorMessage: null,
  metadata: null,
  folderId: null,
  ...overrides,
  visibility: overrides.visibility ?? 'project',
})
