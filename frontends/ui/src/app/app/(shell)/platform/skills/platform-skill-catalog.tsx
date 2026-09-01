'use client'

/**
 * Platform → Skills: the fleet-wide catalogue, and where it is written.
 *
 * One row here reaches every organization at once. That is the whole point of
 * the tier, and it is what replaced the "clone a platform skill" button
 * organizations used to get: a clone copied the instruction into one tenant and
 * froze it there, so every improvement we shipped afterwards went to a skill
 * nobody was running. The body lives in this catalogue and only here.
 *
 * THREE states per row, and no two of them are the same question:
 *
 *   published   Whether the skill is live at all. Ours. A draft is invisible
 *               fleet-wide, which is what makes this usable as a writing
 *               surface rather than a publish-on-save wire.
 *   delivery    Whether organizations CHOOSE it or simply run it. Ours.
 *               `offer` puts it on their Skills tab with a switch; `standard`
 *               is the house instruction — live for everyone, on nobody's tab,
 *               and not something a tenant can switch off or shadow.
 *   switched on Whether a given organization RUNS an OFFER. Theirs, on their
 *               own Skills tab. Nothing here can decide it, and a standard skill
 *               does not ask.
 *
 * Delivery is a row control rather than a field in the editor, deliberately.
 * The editor writes the DOCUMENT — the same agentskills.io document either way,
 * which is why it is the org authoring dialog (`SkillEditorDialog`) and not a
 * second editor that would rot. Delivery is not part of the document; it is who
 * the document is for, and imposing an instruction on every tenant deserves to
 * be its own act rather than a control someone tabs past while writing prose.
 * A new skill is therefore always born as an offer draft, and takes two
 * deliberate moves to become fleet standard.
 */

import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import { AlertCircle, Plus, Sparkles } from 'lucide-react'
import { toast } from 'sonner'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { EmptyState } from '@/components/ui/empty-state'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Skeleton } from '@/components/ui/skeleton'
import { Switch } from '@/components/ui/switch'
import { useTranslations } from '@/i18n'
import { cn } from '@/lib/utils'
import {
  deletePlatformSkill,
  listPlatformSkills,
  updatePlatformSkill,
  type PlatformSkillDelivery,
  type PlatformSkillItem,
} from '@/adapters/api/skills-client'
import { PlatformSkillEditorDialog } from './platform-skill-editor-dialog'

export function PlatformSkillCatalog(): JSX.Element {
  const t = useTranslations('platform')
  const [skills, setSkills] = useState<PlatformSkillItem[] | null>(null)
  const [error, setError] = useState(false)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editing, setEditing] = useState<PlatformSkillItem | null>(null)
  /** Fresh mount per open — the editor seeds its fields in state initialisers. */
  const [editorKey, setEditorKey] = useState(0)
  const [pending, setPending] = useState<string[]>([])
  /**
   * The row a deletion is pending on.
   *
   * Deleting is not the same act as unpublishing, and the two sat next to each
   * other looking identical: the switch withdraws the offer and is reversible,
   * this destroys the only copy of an authored SKILL.md. It gets a confirm
   * step and the plainer word.
   */
  const [confirmDelete, setConfirmDelete] = useState<PlatformSkillItem | null>(null)

  const load = useCallback(() => {
    setSkills(null)
    setError(false)
    listPlatformSkills()
      .then(setSkills)
      .catch(() => setError(true))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const openEditor = (skill: PlatformSkillItem | null) => {
    setEditing(skill)
    setEditorKey((key) => key + 1)
    setEditorOpen(true)
  }

  /**
   * Publish or withdraw. Optimistic and reverted on failure — the same
   * treatment the org-side switch gets, for the same reason: it is cheap to
   * undo, and a control that waits for a round trip is one you press twice.
   */
  const togglePublished = async (skill: PlatformSkillItem, published: boolean) => {
    setPending((current) => [...current, skill.id])
    setSkills((prev) => prev?.map((row) => (row.id === skill.id ? { ...row, published } : row)) ?? prev)
    try {
      await updatePlatformSkill(skill.id, { published })
    } catch {
      setSkills(
        (prev) =>
          prev?.map((row) => (row.id === skill.id ? { ...row, published: !published } : row)) ?? prev,
      )
      toast.error(t('skills.saveError'))
    } finally {
      setPending((current) => current.filter((id) => id !== skill.id))
    }
  }

  /**
   * Move a skill between the two deliveries.
   *
   * Not optimistic, unlike publishing. Publishing is one property of one row and
   * cheap to undo; this changes who is running the instruction — promoting takes
   * the choice away from every organization on the platform, including ones that
   * had switched the skill off. Showing that as done before the server said so
   * would be showing a fleet-wide state we do not yet know we have. The control
   * disables while the write is in flight and the list re-reads on success.
   */
  const setDelivery = async (skill: PlatformSkillItem, delivery: PlatformSkillDelivery) => {
    if (delivery === skill.delivery) return
    setPending((current) => [...current, skill.id])
    try {
      await updatePlatformSkill(skill.id, { delivery })
      setSkills(
        (prev) => prev?.map((row) => (row.id === skill.id ? { ...row, delivery } : row)) ?? prev,
      )
      toast.success(
        delivery === 'standard'
          ? t('skills.deliveryNowStandard', { name: skill.name })
          : t('skills.deliveryNowOffer', { name: skill.name }),
      )
    } catch {
      toast.error(t('skills.saveError'))
    } finally {
      setPending((current) => current.filter((id) => id !== skill.id))
    }
  }

  const remove = async (skill: PlatformSkillItem) => {
    setConfirmDelete(null)
    setPending((current) => [...current, skill.id])
    try {
      await deletePlatformSkill(skill.id)
      setSkills((prev) => prev?.filter((row) => row.id !== skill.id) ?? prev)
      toast.success(t('skills.deleted', { name: skill.name }))
    } catch {
      toast.error(t('skills.saveError'))
    } finally {
      setPending((current) => current.filter((id) => id !== skill.id))
    }
  }

  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-3xl text-sm">{t('skills.hint')}</p>
        <Button size="sm" onClick={() => openEditor(null)}>
          <Plus className="size-4" aria-hidden />
          {t('skills.new')}
        </Button>
      </div>

      {skills === null && !error && (
        <div className="flex flex-col gap-3" data-testid="platform-skills-loading">
          <Skeleton className="h-24 w-full rounded-xl" />
          <Skeleton className="h-24 w-full rounded-xl" />
        </div>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertCircle className="size-4" aria-hidden />
          <AlertTitle>{t('skills.loadError')}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={load}>
              {t('skills.tryAgain')}
            </Button>
          </AlertDescription>
        </Alert>
      )}

      {skills !== null && !error && skills.length === 0 && (
        <EmptyState
          icon={Sparkles}
          title={t('skills.empty.title')}
          description={t('skills.empty.description')}
          action={
            <Button onClick={() => openEditor(null)}>
              <Plus className="size-4" aria-hidden />
              {t('skills.new')}
            </Button>
          }
        />
      )}

      {skills !== null && !error && skills.length > 0 && (
        <ul className="flex flex-col gap-3">
          {skills.map((skill) => (
            <li key={skill.id}>
              <Card>
                <CardContent className="flex flex-col gap-3 p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div
                      className={cn(
                        'min-w-0 space-y-1 transition-opacity duration-quick ease-out motion-reduce:transition-none',
                        !skill.published && 'opacity-60',
                      )}
                    >
                      <p className="text-foreground truncate font-mono text-sm font-semibold">
                        <span aria-hidden className="text-muted-foreground">
                          /
                        </span>
                        {skill.name}
                      </p>
                      <p className="text-muted-foreground line-clamp-2 text-sm">
                        {skill.description}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      {/* Said only while it is true. A "Published" badge on the
                          published ones would repeat the switch beside it; a
                          draft is the state worth naming, because it is the one
                          where nobody else can see what you are looking at. */}
                      {!skill.published && <Badge variant="outline">{t('skills.draft')}</Badge>}
                      {/* The same rule for delivery: "Offer" is the default and
                          says nothing, "Standard" is the state that changed what
                          the fleet is running and is worth reading at a glance.
                          Only meaningful once published — an unpublished
                          standard skill imposes on nobody yet. */}
                      {skill.published && skill.delivery === 'standard' && (
                        <Badge variant="secondary">{t('skills.standardBadge')}</Badge>
                      )}
                      <Switch
                        checked={skill.published}
                        disabled={pending.includes(skill.id)}
                        onCheckedChange={(next) => void togglePublished(skill, next)}
                        aria-label={t('skills.publishAria', { name: skill.name })}
                      />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <Select
                      value={skill.delivery}
                      disabled={pending.includes(skill.id)}
                      onValueChange={(next) => void setDelivery(skill, next as PlatformSkillDelivery)}
                    >
                      <SelectTrigger
                        size="sm"
                        className="w-auto"
                        aria-label={t('skills.deliveryAria', { name: skill.name })}
                        data-testid={`platform-skill-delivery-${skill.name}`}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="offer">{t('skills.deliveryOffer')}</SelectItem>
                        <SelectItem value="standard">{t('skills.deliveryStandard')}</SelectItem>
                      </SelectContent>
                    </Select>
                    <Button size="sm" variant="outline" onClick={() => openEditor(skill)}>
                      {t('skills.edit')}
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="text-destructive hover:text-destructive"
                      disabled={pending.includes(skill.id)}
                      onClick={() => setConfirmDelete(skill)}
                    >
                      {t('skills.delete')}
                    </Button>
                  </div>
                </CardContent>
              </Card>
            </li>
          ))}
        </ul>
      )}

      <ConfirmDialog
        open={confirmDelete !== null}
        onOpenChange={(open) => !open && setConfirmDelete(null)}
        tone="destructive"
        title={t('skills.deleteTitle')}
        description={t('skills.deleteDescription', { name: confirmDelete?.name ?? '' })}
        confirmLabel={t('skills.deleteConfirm')}
        cancelLabel={t('skills.cancel')}
        pending={confirmDelete !== null && pending.includes(confirmDelete.id)}
        onConfirm={() => {
          if (confirmDelete) void remove(confirmDelete)
        }}
      />

      <PlatformSkillEditorDialog
        key={editorKey}
        open={editorOpen}
        onOpenChange={setEditorOpen}
        skill={editing}
        onSaved={() => {
          setEditorOpen(false)
          load()
        }}
      />
    </section>
  )
}
