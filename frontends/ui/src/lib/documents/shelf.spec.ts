/**
 * @vitest-environment node
 *
 * The shelf is the one definition of "which rows are these" that a project's
 * Dateien and the org-wide Archiv share (ADR-0078). Compiled to SQL here, so a
 * clause that stopped naming the tenant or the scope fails by name instead of
 * widening a listing across both.
 */
import { PgDialect } from 'drizzle-orm/pg-core'
import { describe, expect, it } from 'vitest'
import {
  ARCHIV_SHELF,
  documentShelf,
  projectShelf,
  shelfDocumentWhere,
  shelfFolderWhere,
  shelfOwner,
} from './shelf'

const dialect = new PgDialect()
const compile = (clause: Parameters<PgDialect['sqlToQuery']>[0]) => dialect.sqlToQuery(clause)

describe('shelfDocumentWhere', () => {
  it('names the tenant, the scope and the project for a project shelf', () => {
    const { sql, params } = compile(shelfDocumentWhere(projectShelf('proj-1'), 'org-1'))

    expect(sql).toContain('"documents"."organization_id" = $1')
    expect(sql).toContain('"documents"."scope" = $2')
    expect(sql).toContain('"documents"."project_id" = $3')
    expect(params).toEqual(['org-1', 'project', 'proj-1'])
  })

  it('names the tenant and the scope — and no project — for the Archiv', () => {
    const { sql, params } = compile(shelfDocumentWhere(ARCHIV_SHELF, 'org-1'))

    expect(sql).not.toContain('project_id')
    expect(params).toEqual(['org-1', 'archiv'])
  })
})

describe('shelfFolderWhere', () => {
  it('is the folder twin of the document clause', () => {
    expect(compile(shelfFolderWhere(projectShelf('proj-1'), 'org-1')).params).toEqual([
      'org-1',
      'project',
      'proj-1',
    ])
    const archiv = compile(shelfFolderWhere(ARCHIV_SHELF, 'org-1'))
    expect(archiv.sql).toContain('"project_folders"."organization_id" = $1')
    expect(archiv.params).toEqual(['org-1', 'archiv'])
  })
})

describe('shelfOwner', () => {
  it('is what a new row on the shelf is inserted with', () => {
    expect(shelfOwner(projectShelf('proj-1'), 'org-1')).toEqual({
      organizationId: 'org-1',
      scope: 'project',
      projectId: 'proj-1',
    })
    expect(shelfOwner(ARCHIV_SHELF, 'org-1')).toEqual({
      organizationId: 'org-1',
      scope: 'archiv',
      projectId: null,
    })
  })
})

describe('documentShelf', () => {
  it('reads the shelf off a stored row', () => {
    expect(documentShelf({ scope: 'project', projectId: 'proj-1' })).toEqual(projectShelf('proj-1'))
    expect(documentShelf({ scope: 'archiv', projectId: null })).toEqual(ARCHIV_SHELF)
  })

  it('has none for a session attachment, which is filed nowhere', () => {
    expect(documentShelf({ scope: 'session', projectId: null })).toBeNull()
  })
})
