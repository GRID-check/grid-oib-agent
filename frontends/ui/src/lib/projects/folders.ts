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

/**
 * The key two folder names are compared on when deciding whether they are THE
 * SAME folder.
 *
 * Used by the folder-upload planner in the browser and by the server that
 * resolves the same paths, which is why it lives here rather than in either of
 * them: a disagreement does not fail, it silently creates a second „Pläne"
 * beside the one that was already there and files half the project into it.
 *
 * Three normalizations, each for a case that happens:
 *
 *   - **Unicode form.** macOS stores filenames decomposed (NFD), so a folder
 *     dragged off a Mac arrives as `Pla\u0308ne` while the same name typed into
 *     Piloti is `Pl\u00e4ne`. They render identically and are different strings.
 *     This is the one that would have made folder matching look broken for
 *     exactly the users who bulk-upload.
 *   - **Case.** `PLAENE` and `Plaene` are one folder to a person, and the
 *     office server that produced the tree may not even preserve the case.
 *   - **Whitespace**, via {@link normalizeFolderName}, which also strips the
 *     separators a segment must not contain.
 *
 * Matching is deliberately looser than the database's uniqueness rule, which is
 * exact (migration 0063). That rule exists to stop a race between two identical
 * writes; this one answers a product question — "did the reader mean the folder
 * that is already here?" — and the honest answer to `PLAENE` vs `Plaene` is yes.
 */
export function folderMatchKey(value: string): string {
  return normalizeFolderName(value).normalize('NFC').toLowerCase()
}
