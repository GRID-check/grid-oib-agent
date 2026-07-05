'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { TypeToConfirmDialog } from '@/components/ui/type-to-confirm-dialog'

export interface ProjectDangerZoneProps {
  projectId: string
  projectName: string
}

export function ProjectDangerZone({ projectId, projectName }: ProjectDangerZoneProps) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pending, setPending] = useState(false)

  const handleConfirm = async () => {
    setPending(true)
    try {
      const res = await fetch(`/api/projects/${projectId}`, {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ confirmName: projectName }),
      })
      if (!res.ok) {
        const data = await res.json().catch(() => null)
        throw new Error(data?.error ?? 'Failed to delete project.')
      }
      toast.success('Project deleted. It can be restored from "Recently deleted" during the grace period.')
      router.push('/app/projects')
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to delete project.')
      setPending(false)
      setOpen(false)
    }
  }

  return (
    <section className="rounded-lg border border-destructive/40 p-4">
      <h3 className="text-sm font-semibold text-destructive">Danger zone</h3>
      <p className="mt-1 text-sm text-muted-foreground">
        Deleting a project removes its documents, chats, research history, and
        knowledge base everywhere. Restorable for a limited grace period, then
        permanently purged.
      </p>
      <Button
        variant="destructive"
        className="mt-3"
        onClick={() => setOpen(true)}
      >
        Delete project
      </Button>
      <TypeToConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete project"
        description={
          <p>
            This deletes <span className="font-semibold">{projectName}</span> and
            all associated data across the entire app: files, chats, research
            runs, and its knowledge base.
          </p>
        }
        confirmName={projectName}
        confirmLabel="Delete project"
        onConfirm={handleConfirm}
        pending={pending}
      />
    </section>
  )
}
