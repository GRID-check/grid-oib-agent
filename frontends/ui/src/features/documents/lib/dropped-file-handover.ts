/**
 * Files dropped somewhere in a project that is not Dateien, held for Dateien.
 *
 * A drop on Einstellungen, Mitglieder or Automatisierung used to do nothing, or
 * worse, let the browser open the file in place of the app. Uploading from
 * there would need a second upload path: the version question for a name the
 * project already holds, the folder plan for a dropped tree, the tray. Dateien
 * already has all of it, so the drop is handed to Dateien instead, which takes
 * it on mount and runs it through `handleUpload` like any drop of its own.
 *
 * Module state, not a store: it lives for one client-side navigation, and a
 * reload that loses it loses a drop the reader can repeat.
 */

let held: { projectId: string; files: File[] } | null = null

export function handOverDroppedFiles(projectId: string, files: File[]): void {
  held = { projectId, files }
}

/** The files held for this project, once: a second call returns none. */
export function takeDroppedFiles(projectId: string): File[] {
  if (!held || held.projectId !== projectId) return []
  const { files } = held
  held = null
  return files
}
