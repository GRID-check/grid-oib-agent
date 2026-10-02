/**
 * `@/lib/authz/folder-access` for a project that restricts no folder
 * (ADR-0078), for specs that mock the database layer.
 *
 * Every read path that returns a project document asks the folder-access
 * decision point, which reads `project_folders`. A spec that stubs `@/lib/db`
 * for its own queries cannot answer that one, so it mocks the module whole:
 *
 *   vi.mock('@/lib/authz/folder-access', async () =>
 *     (await import('@/test-utils/folder-access')).openFolderAccessModule())
 *
 * A spec that tests restrictions overrides one function with `vi.mocked(…)`.
 */

import { vi } from 'vitest'
import type * as FolderAccess from '@/lib/authz/folder-access'

type FolderAccessModule = Pick<
  typeof FolderAccess,
  | 'getHiddenFolderIds'
  | 'getRestrictedFolderIds'
  | 'isFolderVisibleTo'
  | 'isFolderVisibleToClearance'
  | 'placementCollectionFor'
  | 'getProjectFolderAccess'
  | 'currentRestrictedCollections'
  | 'restrictedCollectionsAbove'
>

/** The open answer `getProjectFolderAccess` gives for a project that restricts nothing. */
export function openFolderAccess(projectCollection: string): FolderAccess.ProjectFolderAccess {
  return {
    hiddenFolderIds: new Set<string>(),
    isVisible: () => true,
    collectionFor: () => projectCollection,
    clearedRestrictedCollections: [],
    anyRestricted: false,
  }
}

export function openFolderAccessModule(): FolderAccessModule {
  return {
    getHiddenFolderIds: vi.fn(async () => []),
    getRestrictedFolderIds: vi.fn(async () => []),
    isFolderVisibleTo: vi.fn(async () => true),
    isFolderVisibleToClearance: vi.fn(async () => true),
    placementCollectionFor: vi.fn(async (_org: string, _project: string, collection: string) => collection),
    getProjectFolderAccess: vi.fn(async (_session, _project: string, collection: string) => openFolderAccess(collection)),
    currentRestrictedCollections: vi.fn(async () => []),
    restrictedCollectionsAbove: vi.fn(async () => []),
  }
}
