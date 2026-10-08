'use client'

/**
 * The Steckbrief card (ADR-0087): the address (from the brief, edited in the
 * wizard), the period as Beginn – Abschluss months, and everyone who worked on
 * the project, with or without a Piloti account.
 *
 * The server decides what may change (`canEdit`: false in a closed project;
 * `canErase`: deleting a person, also in a closed project for whoever manages
 * it). This card reflects it and never offers a control the route refuses.
 */

import { useState, type FormEvent, type JSX } from 'react'
import { useRouter } from 'next/navigation'
import { Pencil, Trash2, UserPlus } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Field, FieldLabel } from '@/components/ui/field'
import { Input } from '@/components/ui/input'
import { RaisedCard, RaisedCardBody } from '@/components/ui/raised-card'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { useLocale, useTranslations } from '@/i18n'
import { isMonth, isOrderedPeriod, type Month } from '@/lib/projects/month'
import type { ProjectPersonView, SteckbriefView } from '@/lib/projects/steckbrief-types'

export interface SteckbriefAccount {
  userId: string
  name: string
}

export interface ProjectSteckbriefProps {
  projectId: string
  steckbrief: SteckbriefView
  /** The organization's people, for linking a person to their Piloti account. */
  accounts?: readonly SteckbriefAccount[]
}

const NO_ACCOUNT = '__none__'

interface PersonDraft {
  name: string
  function: string
  company: string
  startedOn: string
  endedOn: string
  userId: string
}

const EMPTY_DRAFT: PersonDraft = { name: '', function: '', company: '', startedOn: '', endedOn: '', userId: NO_ACCOUNT }

const monthOrNull = (value: string): Month | null => (isMonth(value) ? value : null)

function draftOf(person: ProjectPersonView): PersonDraft {
  return {
    name: person.name,
    function: person.function ?? '',
    company: person.company ?? '',
    startedOn: person.startedOn ?? '',
    endedOn: person.endedOn ?? '',
    userId: person.account?.userId ?? NO_ACCOUNT,
  }
}

export function ProjectSteckbrief({ projectId, steckbrief, accounts = [] }: ProjectSteckbriefProps): JSX.Element {
  const t = useTranslations('projects')
  const tCommon = useTranslations('common')
  const { locale } = useLocale()
  const router = useRouter()
  const [startedOn, setStartedOn] = useState(steckbrief.startedOn ?? '')
  const [endedOn, setEndedOn] = useState(steckbrief.endedOn ?? '')
  const [draft, setDraft] = useState<PersonDraft | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [removing, setRemoving] = useState<ProjectPersonView | null>(null)
  const [pending, setPending] = useState(false)

  const monthLabel = (month: Month | null): string => {
    if (!month) return t('steckbrief.open')
    return new Intl.DateTimeFormat(locale, { month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${month}-01T00:00:00Z`))
  }
  const range = (from: Month | null, to: Month | null): string => (from || to ? `${monthLabel(from)} – ${monthLabel(to)}` : '')

  const send = async (url: string, method: string, body?: unknown): Promise<boolean> => {
    setPending(true)
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { 'content-type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!res.ok) throw new Error(String(res.status))
      router.refresh()
      return true
    } catch {
      toast.error(t('steckbrief.error'))
      return false
    } finally {
      setPending(false)
    }
  }

  const periodValid = isOrderedPeriod(monthOrNull(startedOn), monthOrNull(endedOn))

  const savePeriod = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!periodValid) return
    const body = { startedOn: monthOrNull(startedOn), endedOn: monthOrNull(endedOn) }
    if (await send(`/api/projects/${projectId}/steckbrief`, 'PUT', body)) toast.success(t('steckbrief.periodSaved'))
  }

  const savePerson = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    if (!draft || draft.name.trim().length === 0) return
    const body = {
      name: draft.name,
      function: draft.function,
      company: draft.company,
      startedOn: monthOrNull(draft.startedOn),
      endedOn: monthOrNull(draft.endedOn),
      userId: draft.userId === NO_ACCOUNT ? null : draft.userId,
    }
    const ok = editingId
      ? await send(`/api/projects/${projectId}/people/${editingId}`, 'PATCH', body)
      : await send(`/api/projects/${projectId}/people`, 'POST', body)
    if (ok) {
      toast.success(t('steckbrief.saved'))
      setDraft(null)
      setEditingId(null)
    }
  }

  const removePerson = async (): Promise<void> => {
    if (!removing) return
    if (await send(`/api/projects/${projectId}/people/${removing.id}`, 'DELETE')) {
      toast.success(t('steckbrief.removed'))
      setRemoving(null)
    }
  }

  const field = (key: keyof PersonDraft) => ({
    value: draft?.[key] ?? '',
    onChange: (event: { target: { value: string } }) =>
      setDraft((current) => (current ? { ...current, [key]: event.target.value } : current)),
  })

  return (
    <RaisedCard aria-label={t('steckbrief.heading')}>
      <RaisedCardBody className="space-y-6 p-6">
        <div className="space-y-1">
          <h2 className="text-foreground text-sm font-semibold">{t('steckbrief.heading')}</h2>
          <p className="text-muted-foreground text-sm">{t('steckbrief.description')}</p>
        </div>

        <dl className="grid gap-3 text-sm sm:grid-cols-[8rem_1fr]">
          <dt className="text-muted-foreground">{t('steckbrief.address')}</dt>
          <dd data-testid="steckbrief-address">{steckbrief.address ?? t('steckbrief.addressMissing')}</dd>
          <dt className="text-muted-foreground">{t('steckbrief.period')}</dt>
          <dd>
            {steckbrief.canEdit ? (
              <form className="flex flex-wrap items-end gap-3" onSubmit={savePeriod} aria-label={t('steckbrief.period')}>
                <Field>
                  <FieldLabel htmlFor="steckbrief-started">{t('steckbrief.startedOn')}</FieldLabel>
                  <Input id="steckbrief-started" type="month" value={startedOn} onChange={(event) => setStartedOn(event.target.value)} />
                </Field>
                <Field>
                  <FieldLabel htmlFor="steckbrief-ended">{t('steckbrief.endedOn')}</FieldLabel>
                  <Input id="steckbrief-ended" type="month" value={endedOn} onChange={(event) => setEndedOn(event.target.value)} />
                </Field>
                <Button type="submit" variant="outline" size="sm" disabled={pending || !periodValid}>
                  {t('steckbrief.savePeriod')}
                </Button>
                {!periodValid && <p className="text-error w-full text-xs">{t('steckbrief.periodInvalid')}</p>}
              </form>
            ) : (
              <span data-testid="steckbrief-period">{range(steckbrief.startedOn, steckbrief.endedOn) || t('steckbrief.open')}</span>
            )}
          </dd>
        </dl>

        <section className="space-y-3" aria-label={t('steckbrief.people')}>
          <div className="flex items-end justify-between gap-4">
            <div>
              <h3 className="text-foreground text-sm font-semibold">{t('steckbrief.people')}</h3>
              <p className="text-muted-foreground max-w-2xl text-xs leading-relaxed">{t('steckbrief.peopleDescription')}</p>
            </div>
            {steckbrief.canEdit && !draft && (
              <Button variant="outline" size="sm" onClick={() => setDraft(EMPTY_DRAFT)}>
                <UserPlus className="size-4" aria-hidden />
                {t('steckbrief.add')}
              </Button>
            )}
          </div>

          {steckbrief.people.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('steckbrief.noPeople')}</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('steckbrief.name')}</TableHead>
                  <TableHead>{t('steckbrief.function')}</TableHead>
                  <TableHead>{t('steckbrief.company')}</TableHead>
                  <TableHead>{t('steckbrief.period')}</TableHead>
                  <TableHead>{t('steckbrief.account')}</TableHead>
                  <TableHead className="w-0" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {steckbrief.people.map((person) => (
                  <TableRow key={person.id}>
                    <TableCell className="font-medium">{person.name}</TableCell>
                    <TableCell>{person.function}</TableCell>
                    <TableCell>{person.company}</TableCell>
                    <TableCell className="whitespace-nowrap">{range(person.startedOn, person.endedOn)}</TableCell>
                    <TableCell>{person.account?.name}</TableCell>
                    <TableCell className="whitespace-nowrap text-right">
                      {steckbrief.canEdit && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="size-7"
                          aria-label={t('steckbrief.edit', { name: person.name })}
                          onClick={() => {
                            setEditingId(person.id)
                            setDraft(draftOf(person))
                          }}
                        >
                          <Pencil className="size-3.5" aria-hidden />
                        </Button>
                      )}
                      {steckbrief.canErase && (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="hover:text-destructive size-7"
                          aria-label={t('steckbrief.remove', { name: person.name })}
                          onClick={() => setRemoving(person)}
                        >
                          <Trash2 className="size-3.5" aria-hidden />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {draft && (
            <form className="grid gap-3 sm:grid-cols-2" onSubmit={savePerson} aria-label={t('steckbrief.add')}>
              <Field>
                <FieldLabel htmlFor="person-name">{t('steckbrief.name')}</FieldLabel>
                <Input id="person-name" required maxLength={200} {...field('name')} />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-function">{t('steckbrief.function')}</FieldLabel>
                <Input id="person-function" maxLength={200} {...field('function')} />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-company">{t('steckbrief.company')}</FieldLabel>
                <Input id="person-company" maxLength={200} {...field('company')} />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-account">{t('steckbrief.account')}</FieldLabel>
                <Select
                  value={draft.userId}
                  onValueChange={(value) => setDraft((current) => (current ? { ...current, userId: value } : current))}
                >
                  <SelectTrigger id="person-account">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NO_ACCOUNT}>{t('steckbrief.noAccount')}</SelectItem>
                    {accounts.map((account) => (
                      <SelectItem key={account.userId} value={account.userId}>
                        {account.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="person-from">{t('steckbrief.from')}</FieldLabel>
                <Input id="person-from" type="month" {...field('startedOn')} />
              </Field>
              <Field>
                <FieldLabel htmlFor="person-to">{t('steckbrief.to')}</FieldLabel>
                <Input id="person-to" type="month" {...field('endedOn')} />
              </Field>
              <div className="flex gap-2 sm:col-span-2">
                <Button
                  type="submit"
                  size="sm"
                  disabled={pending || !isOrderedPeriod(monthOrNull(draft.startedOn), monthOrNull(draft.endedOn))}
                >
                  {t('steckbrief.save')}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setDraft(null)
                    setEditingId(null)
                  }}
                >
                  {t('steckbrief.cancel')}
                </Button>
              </div>
            </form>
          )}
        </section>

        <ConfirmDialog
          open={removing !== null}
          onOpenChange={(open) => !open && setRemoving(null)}
          title={t('steckbrief.removeTitle')}
          description={removing ? t('steckbrief.removeDescription', { name: removing.name }) : undefined}
          confirmLabel={t('steckbrief.removeConfirm')}
          cancelLabel={tCommon('actions.cancel')}
          onConfirm={removePerson}
          pending={pending}
        />
      </RaisedCardBody>
    </RaisedCard>
  )
}
