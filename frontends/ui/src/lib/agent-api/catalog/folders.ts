/**
 * The folders, documents, uploads and holds operations (ADR-0122). See `projects.ts` for the shape
 * and `docs/architecture/agent-surface.md` for the rules.
 *
 * Folder access is readable here (project-folder-access-get); changing it stays with a person.
 * The mail import's byte protocol is three operations: start, part upload (raw), complete.
 */

import { z } from 'zod'
import { projectMarksQuerySchema } from '@/lib/annotations/project-types'
import { createHoldSchema } from '@/lib/compliance/hold-wire'
import { declareDocumentRoleSchema } from '@/lib/document-roles/role-wire'
import {
  createFolderSchema,
  ensureFoldersSchema,
  folderListQuerySchema,
  updateFolderSchema,
} from '@/lib/documents/folder-wire'
import { documentListQuerySchema } from '@/lib/documents/list-query'
import { applyRootSortRequestSchema } from '@/lib/filing/root-sort-wire'
import { folderAccessSchema } from '@/lib/projects/folder-access-wire'
import { binListQuerySchema } from '@/lib/projects/folder-bin-wire'
import {
  openUploadBatchSchema,
  sealUploadBatchSchema,
  uploadHistoryQuerySchema,
} from '@/lib/upload-batches/batch-wire'
import {
  MAIL_IMPORT_LIST_PAGE_MAX,
  MAIL_IMPORT_LIST_PAGE_SIZE,
  mailImportListQuerySchema,
  startMailImportSchema,
} from '@/lib/mail-import/types'
import type { AgentOperation } from '../operation'
import { rawBodySchema } from '../upload-wire'

const projectParams = z.object({ id: z.string().describe('The project id, from project-list.') })
const folderParams = projectParams.extend({
  folderId: z
    .string()
    .describe('The folder id, from project-folder-list or project-folder-bin-list.'),
})
const officeFolderParams = z.object({
  folderId: z.string().describe('The office shelf folder id, from office-shelf-folder-list.'),
})
const bindingParams = projectParams.extend({
  bindingId: z.string().describe('The role binding id, from document-role-list.'),
})
const mailImportParams = projectParams.extend({
  importId: z.string().describe('The mail import id, from mail-import-list.'),
})
const batchParams = z.object({
  id: z.string().describe('The upload batch id, the uuid given to upload-batch-open.'),
})
const rootSortRunParams = z.object({
  runId: z.string().describe('The root-sort run id, from project-root-sort-start, office-shelf-root-sort-start or their -get.'),
})
const holdParams = z.object({ id: z.string().describe('The legal hold id, from hold-list.') })

export const foldersOperations = [
  {
    name: 'project-folder-list',
    domain: 'folders',
    summary: 'List a project’s folders',
    description:
      "The project's folder tree in one call: every folder the person may read, with its id, name, parent, path and " +
      "the person's own access, plus `rootAccess`. `counts: true` adds each folder's `documentCount` and `rootDocumentCount`. " +
      'Folder ids feed project-folder-update, project-folder-delete and `folderId` of document-list.',
    method: 'GET',
    path: '/api/projects/[id]/folders',
    params: projectParams,
    query: folderListQuerySchema,
    load: () => import('@/app/api/projects/[id]/folders/route'),
  },
  {
    name: 'project-folder-create',
    domain: 'folders',
    summary: 'Create a folder in a project',
    description:
      'Creates one folder under `parentId` (null or absent: the project root). Refused with a message ' +
      'when a sibling already has the name; to get-or-create whole paths use project-folder-ensure. ' +
      'Returns `{ folder }`. Needs write access on the parent folder.',
    method: 'POST',
    path: '/api/projects/[id]/folders',
    params: projectParams,
    body: createFolderSchema,
    load: () => import('@/app/api/projects/[id]/folders/route'),
  },
  {
    name: 'project-folder-ensure',
    domain: 'folders',
    summary: 'Resolve folder paths, creating the missing',
    description:
      'Takes directory paths (relative to `parentId`, null: the root) and returns the folders plus `folderIdByPath`, ' +
      'creating what is missing; an existing folder is success. Safe to repeat.',
    method: 'POST',
    path: '/api/projects/[id]/folders/ensure',
    params: projectParams,
    body: ensureFoldersSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/folders/ensure/route'),
  },
  {
    name: 'project-folder-update',
    domain: 'folders',
    summary: 'Rename, move or describe a project folder',
    description:
      "Changes a folder's `name`, `parentId` (null: the project root) or `description` (null clears it); send only what " +
      'changes. A move that changes who can open the subtree needs project:manage.',
    method: 'PATCH',
    path: '/api/projects/[id]/folders/[folderId]',
    params: folderParams,
    body: updateFolderSchema,
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/folders/[folderId]/route'),
  },
  {
    name: 'project-folder-delete',
    domain: 'folders',
    summary: 'Move a project folder to the bin',
    description:
      "Moves the folder with its subfolders and documents to the project's bin. It stays " +
      'restorable (project-folder-restore) until the `purgeAfter` date the response names, then is ' +
      'purged. Returns `{ documentsBinned, foldersBinned, purgeAfter }`. Needs write access on the ' +
      'folder and everything below it.',
    method: 'DELETE',
    path: '/api/projects/[id]/folders/[folderId]',
    params: folderParams,
    load: () => import('@/app/api/projects/[id]/folders/[folderId]/route'),
  },
  {
    name: 'project-folder-bin-list',
    domain: 'folders',
    summary: 'List a project’s bin: deleted folders and documents',
    description:
      "The project's bin, newest first, paged (`nextCursor`): deleted folders, who deleted each, when it is purged. An entry " +
      'with `document` is one document: restore it with document-restore; a folder with project-folder-restore.',
    method: 'GET',
    path: '/api/projects/[id]/bin',
    params: projectParams,
    query: binListQuerySchema,
    load: () => import('@/app/api/projects/[id]/bin/route'),
  },
  {
    name: 'project-folder-restore',
    domain: 'folders',
    summary: 'Restore a folder from the bin',
    description:
      'Brings a deleted folder back with its access, subfolders and documents. The response says ' +
      "`restoredTo: 'root'` when its former parent no longer exists. Folder ids come from " +
      'project-folder-bin-list.',
    method: 'POST',
    path: '/api/projects/[id]/bin/[folderId]/restore',
    params: folderParams,
    load: () => import('@/app/api/projects/[id]/bin/[folderId]/restore/route'),
  },
  {
    name: 'project-folder-bin-purge',
    domain: 'folders',
    summary: 'Purge a folder from the bin now',
    description:
      'Deletes a binned folder for good, with its subfolders and documents, instead of waiting for the ' +
      'grace period. This cannot be undone. Needs project:manage; a legal hold refuses it with 409 ' +
      'without naming the hold. Folder ids come from project-folder-bin-list.',
    method: 'DELETE',
    path: '/api/projects/[id]/bin/[folderId]',
    params: folderParams,
    destructive: true,
    load: () => import('@/app/api/projects/[id]/bin/[folderId]/route'),
  },
  {
    name: 'office-shelf-folder-list',
    domain: 'folders',
    summary: 'List the office shelf folders',
    description:
      'Every folder of the office shelf, in the same shape as ' +
      'project-folder-list. Any member may read. Folder ids feed office-shelf-folder-update, ' +
      'office-shelf-folder-delete and the `folderId` filter of document-list.',
    method: 'GET',
    path: '/api/office-shelf/folders',
    load: () => import('@/app/api/office-shelf/folders/route'),
  },
  {
    name: 'office-shelf-folder-create',
    domain: 'folders',
    summary: 'Create an office shelf folder',
    description:
      'Creates one folder under `parentId` (null or absent: the shelf root). Needs ' +
      'org:office_shelf:manage. Refused when a sibling has the name; use office-shelf-folder-ensure to ' +
      'get-or-create paths. Returns `{ folder }`.',
    method: 'POST',
    path: '/api/office-shelf/folders',
    body: createFolderSchema,
    load: () => import('@/app/api/office-shelf/folders/route'),
  },
  {
    name: 'office-shelf-folder-ensure',
    domain: 'folders',
    summary: 'Resolve office shelf folder paths, creating the missing',
    description:
      'Takes directory paths (relative to `parentId`, null: the shelf root), returns the folders plus ' +
      '`folderIdByPath`, and creates whatever is missing. An existing folder counts as success. Needs ' +
      'org:office_shelf:manage. Safe to repeat.',
    method: 'POST',
    path: '/api/office-shelf/folders/ensure',
    body: ensureFoldersSchema,
    idempotent: true,
    load: () => import('@/app/api/office-shelf/folders/ensure/route'),
  },
  {
    name: 'office-shelf-folder-update',
    domain: 'folders',
    summary: 'Rename, move or describe an office shelf folder',
    description:
      "Changes a folder's `name`, `parentId` (null: the shelf root) or `description` (null clears it); send only what " +
      'changes. Needs org:office_shelf:manage.',
    method: 'PATCH',
    path: '/api/office-shelf/folders/[folderId]',
    params: officeFolderParams,
    body: updateFolderSchema,
    idempotent: true,
    load: () => import('@/app/api/office-shelf/folders/[folderId]/route'),
  },
  {
    name: 'office-shelf-folder-delete',
    domain: 'folders',
    summary: 'Delete an office shelf folder',
    description:
      'Deletes the folder; its documents and subfolders are re-filed one level up, not deleted. Returns ' +
      '`{ documentsMoved, foldersMoved }`. Folder ids come from office-shelf-folder-list. Needs ' +
      'org:office_shelf:manage.',
    method: 'DELETE',
    path: '/api/office-shelf/folders/[folderId]',
    params: officeFolderParams,
    load: () => import('@/app/api/office-shelf/folders/[folderId]/route'),
  },
  {
    name: 'document-list',
    domain: 'documents',
    links: 'document',
    summary: 'List the documents of a project or the office shelf',
    description:
      'One page of a shelf’s documents with name, folder, author, lifecycle and version state: a project’s (`projectId`, from ' +
      'project-list) or the office shelf’s (`scope: office_shelf`). 100 a page by default, `limit` up to 500; `folderId` (a ' +
      'folder id or `root`) reads one folder level, else the whole shelf. Filter with `q`, `state`, `authoredBy`; order with ' +
      '`sort` and `dir`. Follow `nextCursor` (pass it as `cursor`) until it is null.',
    method: 'GET',
    path: '/api/documents',
    query: documentListQuerySchema,
    load: () => import('@/app/api/documents/route'),
  },
  {
    name: 'document-role-list',
    domain: 'documents',
    summary: 'List a project’s document roles',
    description:
      'The role bindings of the project (which document is the Baugenehmigung, the Lageplan and so on) ' +
      'in `roles`, plus `missing`: the roles Piloti expects the project to hold and does not. Binding ' +
      'ids feed document-role-clear.',
    method: 'GET',
    path: '/api/projects/[id]/document-roles',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/document-roles/route'),
  },
  {
    name: 'document-role-declare',
    domain: 'documents',
    summary: 'Declare a document’s role in a project',
    description:
      "Binds `documentId` to a `role` of the project's vocabulary (optionally for one " +
      "`scopeInstanceId`). Your call counts as a person's confirmation. Returns the binding. Document " +
      'ids come from document-list.',
    method: 'POST',
    path: '/api/projects/[id]/document-roles',
    params: projectParams,
    body: declareDocumentRoleSchema,
    load: () => import('@/app/api/projects/[id]/document-roles/route'),
  },
  {
    name: 'document-role-clear',
    domain: 'documents',
    summary: 'Clear a document-role binding',
    description:
      'Removes one role binding; the document itself stays. Binding ids come from document-role-list. ' +
      'Declare the role again with document-role-declare.',
    method: 'DELETE',
    path: '/api/projects/[id]/document-roles/[bindingId]',
    params: bindingParams,
    load: () => import('@/app/api/projects/[id]/document-roles/[bindingId]/route'),
  },
  {
    name: 'mail-import-list',
    domain: 'documents',
    summary: 'List a project’s mail imports',
    description:
      "The project's Outlook archive imports with their status and counts, newest first, " +
      `${MAIL_IMPORT_LIST_PAGE_SIZE} a page by default and at most ${MAIL_IMPORT_LIST_PAGE_MAX} (\`limit\`); pass \`nextCursor\` back ` +
      'as `cursor` for the next page, null on the last. Import ids feed ' +
      'mail-import-get and mail-import-cancel.',
    method: 'GET',
    path: '/api/projects/[id]/mail-imports',
    params: projectParams,
    query: mailImportListQuerySchema,
    load: () => import('@/app/api/projects/[id]/mail-imports/route'),
  },
  {
    name: 'mail-import-get',
    domain: 'documents',
    summary: 'Read one mail import',
    description:
      'One Outlook archive import, as the upload plan: which parts the store already holds. Use it to ' +
      'check progress or to resume a send that broke off. Import ids come from mail-import-list.',
    method: 'GET',
    path: '/api/projects/[id]/mail-imports/[importId]',
    params: mailImportParams,
    load: () => import('@/app/api/projects/[id]/mail-imports/[importId]/route'),
  },
  {
    name: 'mail-import-cancel',
    domain: 'documents',
    summary: 'Cancel a mail import',
    description:
      'Cancels an import for good: the parts already sent and the staged archive are discarded, and it cannot be resumed. ' +
      'Mails already filed stay in the project (move them to the bin with document-bin). Only the person who started it, or an org ' +
      'project administrator, may cancel. Import ids come from mail-import-list.',
    method: 'DELETE',
    path: '/api/projects/[id]/mail-imports/[importId]',
    params: mailImportParams,
    load: () => import('@/app/api/projects/[id]/mail-imports/[importId]/route'),
  },
  {
    name: 'project-upload-list',
    domain: 'documents',
    summary: 'List a project’s upload history',
    description:
      'Who brought how many files into the project when, and how each upload ended, one page at a time; ' +
      'follow `nextCursor` (pass it as `cursor`) until it is null. Per-file detail is in ' +
      'upload-batch-get, which only the uploader may read.',
    method: 'GET',
    path: '/api/projects/[id]/uploads',
    params: projectParams,
    query: uploadHistoryQuerySchema,
    load: () => import('@/app/api/projects/[id]/uploads/route'),
  },
  {
    name: 'upload-batch-open',
    domain: 'documents',
    summary: 'Open an upload batch',
    description:
      'Announces an upload before its first file: pass a fresh uuid `id`, the `scope` (project, ' +
      'office_shelf or session), `projectId` for a project upload, and `expectedCount`. The server then ' +
      'knows when all files are read and keeps the upload history. Seal it with upload-batch-seal after ' +
      'the last file.',
    method: 'POST',
    path: '/api/upload-batches',
    body: openUploadBatchSchema,
    load: () => import('@/app/api/upload-batches/route'),
  },
  {
    name: 'upload-batch-seal',
    domain: 'documents',
    summary: 'Seal an upload batch',
    description:
      'Closes an upload batch after the last file: `unchanged` and `failed` count the files that wrote ' +
      'no row, `excluded` the names the screening refused as terms and counts. Only the uploader may ' +
      'seal. The id is the one given to upload-batch-open.',
    method: 'POST',
    path: '/api/upload-batches/[id]/seal',
    params: batchParams,
    body: sealUploadBatchSchema,
    load: () => import('@/app/api/upload-batches/[id]/seal/route'),
  },
  {
    name: 'upload-batch-get',
    domain: 'documents',
    summary: 'Read one upload’s summary',
    description:
      'What arrived in one upload, where it was filed, what each file is and what was held back and ' +
      'why. Only the uploader may read it; anyone else is answered as if it did not exist.',
    method: 'GET',
    path: '/api/upload-batches/[id]',
    params: batchParams,
    load: () => import('@/app/api/upload-batches/[id]/route'),
  },
  {
    name: 'quarantine-list',
    domain: 'documents',
    summary: 'List the quarantine queue',
    description:
      'Documents the content check held back that the person may allow or delete: org admins see the ' +
      "organization's queue, project admins their projects' part, everyone else an empty `items` list.",
    method: 'GET',
    path: '/api/quarantine',
    spansProjects: 'always',
    load: () => import('@/app/api/quarantine/route'),
  },
  {
    name: 'hold-list',
    domain: 'documents',
    summary: 'List open legal holds',
    description:
      'The open legal holds of the organization, each with its entity, reason and id. Needs the ' +
      'compliance permission.',
    method: 'GET',
    path: '/api/holds',
    spansProjects: 'always',
    load: () => import('@/app/api/holds/route'),
  },
  {
    name: 'hold-create',
    domain: 'documents',
    summary: 'Place a legal hold',
    description:
      'Preserves an entity (`entityType` project, document, conversation, organization, user or folder, ' +
      'and its `entityId`) and blocks its purge, with a `reason`. Needs the compliance permission. ' +
      'Returns the hold. Lifting it is a separate, sensitive decision.',
    method: 'POST',
    path: '/api/holds',
    body: createHoldSchema,
    load: () => import('@/app/api/holds/route'),
  },
  {
    name: 'hold-release',
    domain: 'documents',
    summary: 'Release a legal hold',
    description:
      'Lifts a legal hold so the held data can be purged again on its normal schedule. Needs the ' +
      'compliance permission. Hold ids come from hold-list.',
    method: 'POST',
    path: '/api/holds/[id]/release',
    params: holdParams,
    destructive: true,
    sensitivity: 'control',
    load: () => import('@/app/api/holds/[id]/release/route'),
  },
  {
    name: 'deletion-list',
    domain: 'documents',
    summary: 'List pending and failed deletions',
    description:
      "The organization's pending and failed deletions behind the Recently deleted view; failed rows " +
      'are purges that got stuck. Needs the compliance permission.',
    method: 'GET',
    path: '/api/deletions',
    spansProjects: 'always',
    load: () => import('@/app/api/deletions/route'),
  },
  {
    name: 'project-annotation-list',
    domain: 'review',
    summary: 'List a project’s open points',
    description:
      "The project's open items: the live annotations across every document the person may see, a " +
      'page at a time. Filter with `status` (open, proposed, all-live), `assignee` (me or a user id), ' +
      '`due` (overdue, soon) and `order`; follow `nextCursor` (pass it as `cursor`).',
    method: 'GET',
    path: '/api/projects/[id]/annotations',
    params: projectParams,
    query: projectMarksQuerySchema,
    load: () => import('@/app/api/projects/[id]/annotations/route'),
  },
  {
    name: 'mail-import-start',
    domain: 'documents',
    summary: 'Start an Outlook archive import',
    description:
      'Registers a .pst or .ost archive (`filename`, `sizeBytes`, up to 25 GB) and answers the upload plan `{ import, partSize, ' +
      'partCount, uploadedParts }`. Send the parts with mail-import-part-upload, then call mail-import-complete. The mails are ' +
      'then filed with no proposal to approve, into the project folder "E-Mail-Import/<archive name>" as the person who started ' +
      'the import, each file through the same checks as any upload.',
    method: 'POST',
    path: '/api/projects/[id]/mail-imports',
    params: projectParams,
    body: startMailImportSchema,
    load: () => import('@/app/api/projects/[id]/mail-imports/route'),
  },
  {
    name: 'mail-import-part-upload',
    domain: 'documents',
    summary: 'Send one part of an Outlook archive',
    description:
      'Sends part `partNumber` (1-based) of the archive started with mail-import-start as `body.contentBase64`, exactly ' +
      '`partSize` bytes (the last the remainder). Sending a part again replaces it: resume from mail-import-get `uploadedParts`.',
    method: 'PUT',
    path: '/api/projects/[id]/mail-imports/[importId]/parts/[partNumber]',
    params: mailImportParams.extend({
      partNumber: z.string().describe('The part number, 1-based, up to the plan’s `partCount`.'),
    }),
    body: rawBodySchema,
    bodyEncoding: 'raw',
    idempotent: true,
    load: () => import('@/app/api/projects/[id]/mail-imports/[importId]/parts/[partNumber]/route'),
  },
  {
    name: 'mail-import-complete',
    domain: 'documents',
    summary: 'Finish sending an Outlook archive',
    description:
      'Call once every part is sent: the parts are joined and the filing job is queued (HTTP 202). Answers the import with its ' +
      'status; follow it with mail-import-get. Refused with 409 when the import was cancelled meanwhile, and with 409 and ' +
      'details.missingParts (the first 50) while a part is absent or the wrong size: send those with mail-import-part-upload and call again.',
    method: 'POST',
    path: '/api/projects/[id]/mail-imports/[importId]/complete',
    params: mailImportParams,
    load: () => import('@/app/api/projects/[id]/mail-imports/[importId]/complete/route'),
  },
  {
    name: 'project-folder-access-get',
    domain: 'folders',
    summary: 'Read who may open a project folder',
    description:
      'The folder’s access as it is now: `{ mode: "inherit" }`, or `{ mode: "custom", everyoneReads, people: [{ userId, level }] }`. ' +
      'Needs manage rights on the project and write access on the folder, as a change would. Change it with project-folder-access-set. ' +
      'Folder ids come from project-folder-list.',
    method: 'GET',
    path: '/api/projects/[id]/folders/[folderId]/access',
    params: folderParams,
    load: () => import('@/app/api/projects/[id]/folders/[folderId]/access/route'),
  },
  {
    name: 'project-folder-access-set',
    domain: 'folders',
    summary: 'Set who may open a project folder',
    description:
      'Replaces the folder’s access: `{ mode: "inherit" }`, or `{ mode: "custom", everyoneReads, people: [{ userId, level }] }` ' +
      '(`read` or `write`, at most 50 people, ids from organization-member-list). `failed` lists documents that did not move; ' +
      'call again to retry. Read it first with project-folder-access-get. Sensitive: the person confirms every call.',
    method: 'PUT',
    path: '/api/projects/[id]/folders/[folderId]/access',
    params: folderParams,
    body: folderAccessSchema,
    sensitivity: 'access',
    load: () => import('@/app/api/projects/[id]/folders/[folderId]/access/route'),
  },
  {
    name: 'project-root-sort-get',
    domain: 'folders',
    summary: 'Read what a project root holds, and the latest sort',
    description:
      "How many files and folders the project's root holds, how many files ingestion has not read yet " +
      '(`unreadable`, they are left where they are), and the person’s latest root-sort run (`run`, null ' +
      'when there is none). Call it before project-root-sort-start, and to find a run to follow with ' +
      'root-sort-run-get.',
    method: 'GET',
    path: '/api/projects/[id]/root-sort',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/root-sort/route'),
  },
  {
    name: 'project-root-sort-start',
    domain: 'folders',
    summary: 'Sort a project root’s loose files into its folders',
    description:
      "Starts a server run that proposes a folder for every loose file in the project's root (existing folders, or new ones). " +
      'Nothing moves yet. Follow the run with root-sort-run-get until `ready`, then send what to keep with root-sort-run-apply. ' +
      'Refused when there is no folder, no loose file, or a sort already running.',
    method: 'POST',
    path: '/api/projects/[id]/root-sort',
    params: projectParams,
    load: () => import('@/app/api/projects/[id]/root-sort/route'),
  },
  {
    name: 'office-shelf-root-sort-get',
    domain: 'folders',
    summary: 'Read what the office shelf root holds, and the latest sort',
    description:
      'How many files and folders the office shelf root holds, how many files ingestion has not read yet, ' +
      'and the person’s latest root-sort run there (`run`, null when there is none). Needs ' +
      'org:office_shelf:manage. Call it before office-shelf-root-sort-start.',
    method: 'GET',
    path: '/api/office-shelf/root-sort',
    load: () => import('@/app/api/office-shelf/root-sort/route'),
  },
  {
    name: 'office-shelf-root-sort-start',
    domain: 'folders',
    summary: 'Sort the office shelf root’s loose files into its folders',
    description:
      'Starts a server run that proposes a folder for every loose file in the office shelf root, as ' +
      'project-root-sort-start does for a project. Nothing moves yet. Returns the run; follow it with ' +
      'root-sort-run-get and apply what the person keeps with root-sort-run-apply. Needs ' +
      'org:office_shelf:manage.',
    method: 'POST',
    path: '/api/office-shelf/root-sort',
    load: () => import('@/app/api/office-shelf/root-sort/route'),
  },
  {
    name: 'root-sort-run-get',
    domain: 'folders',
    summary: 'Read one root-sort run',
    description:
      'The run’s `status` (judging, grouping, ready, applying, applied, undoing, undone, cancelled, failed) and `progress`. ' +
      'Once `ready`, `review` holds one placement per file (`folderId` or `newFolderPath`, with `reason` and `confidence`). ' +
      'Only its starter reads it. Next: root-sort-run-apply or root-sort-run-cancel.',
    method: 'GET',
    path: '/api/root-sort-runs/[runId]',
    params: rootSortRunParams,
    // The run id names no project, and a run may sort any project's root or the office shelf.
    spansProjects: 'always',
    load: () => import('@/app/api/root-sort-runs/[runId]/route'),
  },
  {
    name: 'root-sort-run-apply',
    domain: 'folders',
    summary: 'Apply the placements kept from a ready root-sort run',
    description:
      'Takes the placements to keep, each `{ documentId, folderId, newFolderPath }` from the run’s ' +
      'review (both null keeps a file in the root), and moves the files on the server: kept new folders ' +
      'are created first. Only a `ready` run applies. Answers at once with the run in `applying`; follow ' +
      'it with root-sort-run-get. root-sort-run-undo sends the moved files back.',
    method: 'POST',
    path: '/api/root-sort-runs/[runId]/apply',
    params: rootSortRunParams,
    body: applyRootSortRequestSchema,
    examples: [
      {
        params: { runId: '6f1c2b8e-3d4a-4e5f-9a7b-1c2d3e4f5a6b' },
        body: {
          keep: [
            {
              documentId: '0b9a8c7d-6e5f-4a3b-8c2d-1e0f9a8b7c6d',
              folderId: '3e4f5a6b-7c8d-4e9f-a0b1-c2d3e4f5a6b7',
              newFolderPath: null,
            },
            { documentId: '1c0b9a8d-7e6f-4b5a-9c3d-2e1f0a9b8c7d', folderId: null, newFolderPath: 'Statik/Berechnungen' },
          ],
        },
      },
    ],
    load: () => import('@/app/api/root-sort-runs/[runId]/apply/route'),
  },
  {
    name: 'root-sort-run-cancel',
    domain: 'folders',
    summary: 'Stop a root-sort run before anything moved',
    description:
      'Cancels a run that is judging, grouping or waiting for review; nothing was moved, so nothing ' +
      'changes on the shelf. A run already applying finishes what it started; undo it afterwards with ' +
      'root-sort-run-undo. Returns the run.',
    method: 'POST',
    path: '/api/root-sort-runs/[runId]/cancel',
    params: rootSortRunParams,
    idempotent: true,
    load: () => import('@/app/api/root-sort-runs/[runId]/cancel/route'),
  },
  {
    name: 'root-sort-run-undo',
    domain: 'folders',
    summary: 'Send what a root-sort run moved back to the root',
    description:
      'Moves every file an applied (or partly applied, then failed) run moved back to the shelf root; ' +
      'folders it created stay. Answers at once with the run in `undoing`; follow it with ' +
      'root-sort-run-get. Refused when the run moved nothing.',
    method: 'POST',
    path: '/api/root-sort-runs/[runId]/undo',
    params: rootSortRunParams,
    load: () => import('@/app/api/root-sort-runs/[runId]/undo/route'),
  },
] as const satisfies readonly AgentOperation[]
