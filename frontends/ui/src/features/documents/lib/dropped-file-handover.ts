/**
 * Files dropped somewhere in a project that is not Dateien, held for Dateien.
 *
 * A drop on Einstellungen, Mitglieder or Automatisierung is handed to Dateien,
 * so the browser never opens the file in place of the app. Uploading from there
 * would need a second upload path: the version question for a name the project
 * already holds, the folder plan for a dropped tree, the tray. Dateien already
 * has all of it, so it takes the drop on mount and runs it through
 * `handleUpload` like any drop of its own.
 *
 * Module state, not a store: it lives for one client-side navigation, and a
 * reload that loses it loses a drop the reader can repeat.
 */

let held: { projectId: string; files: File[] } | null = null

/** Hold a drop; a second drop into the same project before Dateien takes them joins the first. */
export function handOverDroppedFiles(projectId: string, files: File[]): void {
  held = {
    projectId,
    files: held?.projectId === projectId ? [...held.files, ...files] : [...files],
  }
}

/** The files held for this project, once: a second call returns none. */
export function takeDroppedFiles(projectId: string): File[] {
  if (!held || held.projectId !== projectId) return []
  const { files } = held
  held = null
  return files
}
