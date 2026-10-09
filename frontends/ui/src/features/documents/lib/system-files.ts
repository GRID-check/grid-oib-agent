/**
 * Files an operating system or an office suite leaves in a folder, which a
 * person dropping that folder never meant to upload.
 *
 * Most have no extension the upload accepts and would only clutter the plan as
 * „nicht unterstützt". The Office owner file is worse: `~$Vertrag.docx` carries
 * a real extension, passes the type check and is uploaded as a 162-byte
 * „document" that every reader then fails on.
 */

const EXACT_NAMES = new Set(['.ds_store', 'thumbs.db', 'ehthumbs.db', 'desktop.ini', 'icon\r'])

/** Whether `name` is one of those files, by its name alone. */
export function isSystemFile(name: string): boolean {
  const lower = name.toLowerCase()
  if (EXACT_NAMES.has(lower)) return true
  // macOS AppleDouble resource forks on non-HFS volumes and network shares.
  if (name.startsWith('._')) return true
  // Microsoft Office owner (lock) files, and LibreOffice's.
  if (name.startsWith('~$')) return true
  if (name.startsWith('.~lock.') && name.endsWith('#')) return true
  return false
}
