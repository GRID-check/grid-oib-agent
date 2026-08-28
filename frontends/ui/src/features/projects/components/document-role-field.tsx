'use client'

/**
 * Bind a document to a role, from inside the wizard.
 *
 * What this replaces was a `<Link>` to the Files page dressed as an upload
 * control: the question said "Bebauungsplan ablegen", the click navigated away,
 * and nothing about the project ever recorded which file that was. The known
 * issue in the handover package ("B-Plan-Upload funktioniert nicht") was not a
 * broken upload — there was no upload.
 *
 * Two ways in, because architects arrive in both states: the file is already in
 * the project (pick it) or it is on their machine (drop it, and the binding is
 * made when ingestion accepts it).
 */

import { useCallback, useMemo, useRef, useState } from 'react'
import { CheckCircle2, FileText, Loader2, Paperclip, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { documentRoleDefinition } from '@/lib/project-profile/document-roles'
import type { DocumentRole } from '@/lib/project-profile/document-roles'
import { useDocumentRoles } from '../lib/use-document-roles'
import type { RoleBinding } from '../lib/use-document-roles'

interface DocumentRoleFieldProps {
  projectId: string
  role: DocumentRole
  /** The building this binding belongs to, for a `bauwerk` role. */
  scopeInstanceId?: string | null
  /** Rendered above the control; the question supplies its own label. */
  label?: string
}

function documentLabel(binding: { displayName?: string | null; filename: string }): string {
  return binding.displayName?.trim() || binding.filename
}

export function DocumentRoleField({
  projectId,
  role,
  scopeInstanceId = null,
  label,
}: DocumentRoleFieldProps) {
  const definition = documentRoleDefinition(role)
  const { bindings, documents, refresh } = useDocumentRoles(projectId)
  const [busy, setBusy] = useState(false)
  const [dragging, setDragging] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const mine = useMemo(
    () =>
      (bindings ?? []).filter(
        (binding) => binding.role === role && (binding.scopeInstanceId ?? null) === scopeInstanceId
      ),
    [bindings, role, scopeInstanceId]
  )

  /**
   * Run an action and surface a rejection.
   *
   * `bind`, `unbind` and `uploadAndBind` were every one of them invoked with a
   * bare `void`, so a network error or a malformed response rejected into
   * nothing: the upload flow could leave a file uploaded and unbound while the
   * UI reported no failure at all.
   */
  const run = useCallback((action: Promise<void>) => {
    void action.catch(() => toast.error('Aktion fehlgeschlagen. Bitte erneut versuchen.'))
  }, [])

  const bind = useCallback(
    async (documentId: string) => {
      setBusy(true)
      try {
        const response = await fetch(`/api/projects/${projectId}/document-roles`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ documentId, role, scopeInstanceId }),
        })
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as { error?: string } | null
          toast.error(body?.error ?? 'Dokument konnte nicht zugeordnet werden.')
          // The upload may have succeeded even though the binding did not.
          // Returning without refreshing left the new file out of `documents`,
          // so this mounted field could not offer it for a retry.
          await refresh({ afterWrite: true })
          return
        }
        // A single-holder role displaces whatever held it. Naming the document
        // that stopped being the Bebauungsplan is the whole reason the service
        // returns it rather than swallowing the replacement.
        const body = (await response.json()) as { replaced?: RoleBinding[] }
        for (const previous of body.replaced ?? []) {
          toast.info(`${documentLabel(previous)} ist nicht mehr ${definition.label}.`)
        }
        await refresh({ afterWrite: true })
      } finally {
        setBusy(false)
      }
    },
    [definition.label, projectId, refresh, role, scopeInstanceId]
  )

  const unbind = useCallback(
    async (bindingId: string) => {
      setBusy(true)
      try {
        const response = await fetch(
          `/api/projects/${projectId}/document-roles/${encodeURIComponent(bindingId)}`,
          { method: 'DELETE' }
        )
        if (!response.ok) {
          toast.error('Zuordnung konnte nicht entfernt werden.')
          return
        }
        await refresh()
      } finally {
        setBusy(false)
      }
    },
    [projectId, refresh]
  )

  const uploadAndBind = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files)
      if (list.length === 0) return
      setBusy(true)
      try {
        for (const file of list) {
          const form = new FormData()
          form.append('file', file)
          form.append('projectId', projectId)
          const response = await fetch('/api/documents/upload', { method: 'POST', body: form })
          if (!response.ok) {
            toast.error(`${file.name} konnte nicht hochgeladen werden.`)
            continue
          }
          const body = (await response.json()) as { documentId?: string }
          const documentId = body.documentId
          // No id means the upload succeeded but we cannot name what to bind.
          // Say so rather than reporting a binding that does not exist.
          if (!documentId) {
            toast.error(`${file.name} wurde abgelegt, aber nicht zugeordnet.`)
            continue
          }
          await bind(documentId)
        }
      } finally {
        setBusy(false)
      }
    },
    [bind, projectId]
  )

  const alreadyBound = new Set(mine.map((binding) => binding.documentId))
  const selectable = documents.filter((document) => !alreadyBound.has(document.id))
  const full = definition.cardinality === 'one' && mine.length > 0

  return (
    <div className="flex flex-col gap-2">
      {label && <span className="text-sm font-medium">{label}</span>}
      {definition.why && <p className="text-muted-foreground text-xs">{definition.why}</p>}

      {bindings === null ? (
        <div className="text-muted-foreground flex items-center gap-2 text-sm">
          <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          Zuordnungen werden geladen …
        </div>
      ) : (
        <ul className="flex flex-col gap-1.5" aria-label={`Zugeordnet als ${definition.label}`}>
          {mine.map((binding) => (
            <li
              key={binding.id}
              className="bg-muted/20 flex items-center gap-2 rounded-lg border px-3 py-2 text-sm"
            >
              <CheckCircle2 className="text-primary size-4 shrink-0" aria-hidden />
              <FileText className="text-muted-foreground size-4 shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 truncate">{documentLabel(binding)}</span>
              {binding.confidence === 'suggested' && (
                <span className="text-muted-foreground shrink-0 rounded border border-dashed px-1.5 py-0.5 font-mono text-[10px]">
                  vorgeschlagen
                </span>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-7 shrink-0"
                disabled={busy}
                onClick={() => run(unbind(binding.id))}
                aria-label={`${documentLabel(binding)} nicht mehr als ${definition.label} führen`}
              >
                <X className="size-3.5" aria-hidden />
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {selectable.length > 0 && (
          <Select disabled={busy} value="" onValueChange={(value) => run(bind(value))}>
            <SelectTrigger className="h-9 max-w-xs">
              <SelectValue
                placeholder={full ? 'Anderes Dokument wählen …' : 'Vorhandenes Dokument wählen …'}
              />
            </SelectTrigger>
            <SelectContent>
              {selectable.map((document) => (
                <SelectItem key={document.id} value={document.id}>
                  {documentLabel({
                    displayName: document.displayName ?? null,
                    filename: document.filename,
                  })}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}

        <input
          ref={inputRef}
          type="file"
          multiple={definition.cardinality === 'many'}
          className="sr-only"
          onChange={(event) => {
            if (event.target.files) run(uploadAndBind(event.target.files))
            event.target.value = ''
          }}
        />
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={busy}
          onClick={() => inputRef.current?.click()}
        >
          {busy ? (
            <Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />
          ) : (
            <Paperclip className="size-4" aria-hidden />
          )}
          Datei hochladen
        </Button>
      </div>

      <div
        onDragOver={(event) => {
          event.preventDefault()
          setDragging(true)
        }}
        onDragLeave={() => setDragging(false)}
        aria-label={`Datei ablegen, um sie als ${definition.label} zu führen`}
        onDrop={(event) => {
          event.preventDefault()
          setDragging(false)
          // Ignored while a write is in flight: the other controls are disabled,
          // but a drop bypassed them, and two overlapping writes to a
          // single-holder slot leave whichever finishes LAST as the holder.
          if (busy) return
          const dropped = event.dataTransfer.files
          if (!dropped?.length) return
          // A slot that holds one document takes one file. Binding all of them
          // made each replace the last, silently keeping only the final file.
          const files = definition.cardinality === 'one' ? [dropped[0]] : Array.from(dropped)
          run(uploadAndBind(files))
        }}
        className={cn(
          'rounded-lg border border-dashed px-3 py-2 text-center text-xs transition-colors duration-quick ease-out motion-reduce:transition-none',
          dragging ? 'border-primary bg-primary/5 text-foreground' : 'text-muted-foreground'
        )}
      >
        <Upload className="mr-1.5 inline size-3.5 align-[-2px]" aria-hidden />
        Datei hierher ziehen
      </div>
    </div>
  )
}
