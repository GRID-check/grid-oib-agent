/**
 * Context chips for the Herleitung — the files attached to THIS message.
 *
 * Files only, on purpose. The data sources toggled on in the composer at send
 * time are not rendered here, labelled "Ausgewählte Datenquellen": that row
 * would read as "these are what the turn used". They are not. Every source is
 * enabled on load, so such a row would claim `Websuche` on every turn —
 * including a bare greeting, where the backend drops all data-source tools
 * before the model sees them. The protocol
 * rule is "availability is the constant, activation is the event", and a
 * per-turn record must carry events. What actually ran is derived from the
 * turn's `tool` and `skill` steps by `deriveExecutedSteps` and shown as the
 * `Ausgeführt:` row; availability is already visible where it is actionable —
 * on the composer's own toggles — and is not restated here.
 *
 * An attached file IS a per-turn fact: the user hung it on this message, and it
 * is true of this turn and no other. So the file chips stay.
 */

/** Attached files → the ordered chip label list. */
export const buildFileChips = (
  messageFiles: Array<{ id: string; fileName: string }>
): string[] => messageFiles.map((f) => f.fileName)
