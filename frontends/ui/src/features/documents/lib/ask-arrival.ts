/**
 * Whether a `?new=1` chat landing should drop the open file.
 *
 * Sidebar **Frag Piloti** is an empty draft — the previous peek must go
 * (#441). **Piloti dazu fragen** is a new draft ABOUT a file (`?doc=`),
 * so closing the peek there deletes the only visual of the subject.
 */
export function newChatDropsFilePreview(documentId: string | null | undefined): boolean {
  return !documentId?.trim()
}
