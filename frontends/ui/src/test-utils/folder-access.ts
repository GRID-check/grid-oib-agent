/**
 * `@/lib/authz/folder-access` for a project where no folder has its own
 * access list (ADR-0084, ADR-0085), for specs that mock the database layer.
 *
 * Every read path that returns a project document asks the folder-access
 * decision point, which reads `project_folders`. A spec that stubs `@/lib/db`
 * for its own queries cannot answer that one, so it mocks the module whole:
 *
 *   vi.mock('@/lib/authz/folder-access', async () =>
 *     (await import('@/test-utils/folder-access')).openFolderAccessModule())
 *
 * A spec that tests restrictions overrides one function with `vi.mocked(…)`;
 * the pure rule stays real.
 */

import { vi } from 'vitest'
import type * as FolderAccess from '@/lib/authz/folder-access'
import * as rule from '@/lib/authz/folder-access-rule'

type FolderAccessModule = Pick<
  typeof FolderAccess,
  | 'getHiddenFolderIds'
  | 'getRestrictedFolderIds'
  | 'isFolderVisibleTo'
  | 'isFolderVisibleToClearance'
  | 'filterUsersWhoMayReadFolder'
  | 'placementCollectionFor'
  | 'getProjectFolderAccess'
  | 'currentRestrictedCollections'
  | 'clearanceOfMember'
  | 'requireFolderWrite'
  | 'canWriteFolder'
  | 'projectMayWriteDocuments'
  | 'readableFolderIdsFor'
  | 'sourceFoldersOfCollections'
  | 'customFolderNames'
>

/** The open answer `getProjectFolderAccess` gives for a project that restricts nothing. */
export function openFolderAccess(projectCollection: string): FolderAccess.ProjectFolderAccess {
  return {
    hiddenFolderIds: new Set<string>(),
    isVisible: () => true,
    levelOf: () => 'write',
    collectionFor: () => projectCollection,
    sourceFolderOf: () => null,
    clearedRestrictedCollections: [],
    anyRestricted: false,
  }
}

/**
 * The module, open: every loader answers as for a project with no own list,
 * and the pure rule (`folder-access-rule.ts`) is the real one, so a spec that
 * mocks the loaders still decides with the rule it ships with.
 */
export function openFolderAccessModule(): FolderAccessModule & typeof rule {
  return {
    ...rule,
    getHiddenFolderIds: vi.fn(async () => []),
    getRestrictedFolderIds: vi.fn(async () => []),
    isFolderVisibleTo: vi.fn(async () => true),
    isFolderVisibleToClearance: vi.fn(async () => true),
    filterUsersWhoMayReadFolder: vi.fn(
      async (_org: string, _project: string, _folder: string | null, userIds: readonly string[]) => new Set(userIds)
    ),
    placementCollectionFor: vi.fn(async (_org: string, _project: string, collection: string) => collection),
    getProjectFolderAccess: vi.fn(async (_session, _project: string, collection: string) => openFolderAccess(collection)),
    currentRestrictedCollections: vi.fn(async () => []),
    clearanceOfMember: vi.fn(async () => ({ roles: [], seesEverything: false })),
    // Writes are allowed in an open project; a spec that tests a read-only
    // folder overrides this one with `vi.mocked(…)`.
    requireFolderWrite: vi.fn(async () => undefined),
    canWriteFolder: vi.fn(async () => true),
    projectMayWriteDocuments: vi.fn(async () => true),
    readableFolderIdsFor: vi.fn(async () => []),
    sourceFoldersOfCollections: vi.fn(async () => new Map<string, string>()),
    customFolderNames: vi.fn(async () => new Map<string, string>()),
  }
}
