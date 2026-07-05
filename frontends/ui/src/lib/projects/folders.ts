const RESERVED_FOLDER_NAMES = new Set(['con', 'prn', 'aux', 'nul'])

export interface FolderNameValidationResult {
  ok: boolean
  name?: string
  error?: string
}

export function normalizeFolderName(value: string): string {
  return value
    .replace(/[\\/\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function validateFolderName(value: string): FolderNameValidationResult {
  const name = normalizeFolderName(value)
  if (!name || name === '.') {
    return { ok: false, error: 'Folder name is required.' }
  }
  if (name === '..') {
    return { ok: false, error: 'Folder name cannot be . or ...' }
  }
  if (RESERVED_FOLDER_NAMES.has(name.toLowerCase())) {
    return { ok: false, error: 'Folder name is reserved.' }
  }
  if (name.length > 120) {
    return { ok: false, error: 'Folder name must be 120 characters or fewer.' }
  }
  return { ok: true, name }
}

export function normalizeFolderPath(value: string | null | undefined): string {
  if (!value) return ''
  return value
    .split(/[\\/]+/)
    .map(normalizeFolderName)
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    .join('/')
}

export function pathSegments(value: string | null | undefined): string[] {
  const normalized = normalizeFolderPath(value)
  return normalized ? normalized.split('/') : []
}

export function buildFolderPath(parentPath: string | null | undefined, name: string): string {
  const validated = validateFolderName(name)
  if (!validated.ok || !validated.name) {
    throw new Error(validated.error ?? 'Invalid folder name.')
  }
  const normalizedParent = normalizeFolderPath(parentPath)
  return normalizedParent ? `${normalizedParent}/${validated.name}` : validated.name
}
