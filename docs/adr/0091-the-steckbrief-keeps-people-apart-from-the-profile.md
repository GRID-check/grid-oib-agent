---
status: accepted
date: 2026-10-06
decision-makers: product owner (Matthias), Grid engineering
consulted: Grid engineering
informed: everyone working in this repo
---

# The Steckbrief keeps its people apart from the profile

## Context and Problem Statement

Ticket 1 asks for a Steckbrief of every project: address, period, and „alle
Personen, auch ohne Piloti-Konto". The address already exists as the profile
fact `standort_adresse`. There was no period, and the only people a project
knew were the WorkOS members holding a role on it; someone who left the office
resolves to a raw user id, and an external planner was never there.

The product owner decided on 6 Oct 2026: Beginn and Abschluss at month
precision, with closing pre-filling Abschluss; per person Name, Funktion,
Firma, von–bis and an optional link to a Piloti account, no e-mail or phone;
every person row deletable (GDPR); people stay out of the agent's prompt.

## Decision Drivers

* People are personal data of people who mostly never gave it (GDPR Art. 14), so as few fields as the purpose needs (Art. 5(1)(c)), and erasure that works (Art. 17).
* The profile is read into the agent's prompt on every turn (`lib/project-profile/prompt-view.ts`); people must not be.
* A closed project is read-only (ADR-0090), but erasure cannot wait for a reopen.

## Considered Options

* **A `project_people` table and two period columns on `projects`** (chosen).
* People and period as facts in the profile JSON.
* People as WorkOS users (invite the externals as guests).

## Decision Outcome

Chosen option: its own table, because the profile is exactly the place people
must not be, and a table gives row-level security, a cascade with the project,
CHECKs and a hard delete.

**The period** is `projects.started_on` and `projects.ended_on`, `date` columns
holding the first of a month (`projects_period_check`: day 1, end not before
start). On the wire a month is `YYYY-MM` (`lib/projects/month.ts`). Closing a
project fills `ended_on` with the month of the close when nobody set one, and
never before a Beginn (`setProjectStatusInOrg`). It is not a profile fact, so
the agent does not see it either; that can change when an answer needs it.

**The people** are `project_people` (migration 0117): name, function, company,
months from and to, an optional `user_id` that must name a member of the
organization when set, the creator and timestamps. A composite foreign key
ties a row to its project and organization and cascades with the project's
purge; `grid_secure_table` puts it inside the tenant boundary. A row is deleted
outright: that is the erasure. The audit trail (`project.person.added`,
`.updated`, `.deleted`, `project.period.changed`) names a person by id, never by
name, because the audit log outlives an erasure.

**Who may.** Reading needs `project:view`, so every member of the office reads a
closed project's Steckbrief. Changing the period or a person needs the profile's
write permissions and is therefore refused in a closed project; the 0115 guard
also refuses an INSERT into `project_people` there. Deleting a person needs the
same in an active project and `project:manage` in a closed one.

**Out of the prompt by construction.** Nothing that assembles the agent's
context reads the table. `people-stay-out-of-the-prompt.spec.ts` walks every
context builder and the agent's internal routes and fails on an import of it.

### Consequences

* Good, because people can never leak into a model call through the profile.
* Good, because erasure is one DELETE, with nothing to keep in sync.
* Bad, because the people are a second list beside the WorkOS roster; linking a row to an account is optional and by hand.
* Bad, because the agent cannot answer „wer hat die Statik gemacht?"; that is the price of keeping names out of every turn.

### Confirmation

`lib/projects/steckbrief.integration.spec.ts` on real Postgres (tenancy, CHECKs, the closed-project
guard, the cascade, closing filling the Abschluss), `steckbrief-service.spec.ts` (who may, account
check, audit without names), `people-stay-out-of-the-prompt.spec.ts`, and the 0116 down/up in
`scripts/rls-test-db.sh`.

## Pros and Cons of the Options

### Facts in the profile JSON

* Good, because the wizard would edit them.
* Bad, because the profile is the prompt: every former employee's name on every turn.
* Bad, because erasing one person means rewriting a versioned JSON document.

### WorkOS guest users

* Good, because the roster would be one list.
* Bad, because a former employee or an external planner would need an account they will never use, with an e-mail address, which is the field the product owner excluded.

## More Information

* [ADR-0090](0090-a-closed-project-is-read-only-and-open-to-the-office.md): closed projects.
* User guide: [`user-guides/projects.md`](../user-guides/projects.md#the-steckbrief).
* Table: [`database/schema.md`](../database/schema.md#project_people-migration-0117-adr-0087).
