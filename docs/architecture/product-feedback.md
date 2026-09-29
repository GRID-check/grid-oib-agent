# Product feedback and the inbox's platform lane

A member can send the people who run Piloti a bug report, an idea, praise or a
question from anywhere in the app. The platform owners are told in their inbox
and work through the reports on **Platform → Feedback**. This is separate from
the thumbs on an answer (`answer_feedback`, which feeds platform lessons). A
product report never reaches that pipeline.

## The flow

```
member ── Feedback senden ──▶ POST /api/feedback/reports ──▶ product_feedback (reporter's org, RLS)
                                                       │
                                                       └──▶ feedback.submitted inbox rows
                                                            (platform org, one per owner)
owner's inbox (platform lane) ──▶ /app/platform/feedback?report=<id> ──▶ PATCH status
```

| Step | Code |
|---|---|
| The form, and its entry points (avatar menu, org header) | `frontends/ui/src/features/product-feedback/components/feedback-dialog.tsx`, `feedback-provider.tsx` |
| Submit route, rate limited by `FEEDBACK_REPORT_LIMIT` (10 an hour per person) | `frontends/ui/src/app/api/feedback/reports/route.ts` |
| Store and announce | `frontends/ui/src/lib/product-feedback/service.ts`, `announce.ts` |
| Table, bounds, RLS | `frontends/ui/drizzle/0100_product_feedback.sql` |
| Triage routes (`platform:settings:view` to read, `:manage` to change status) | `frontends/ui/src/app/api/platform/feedback/` |
| Triage page | `frontends/ui/src/features/product-feedback/components/feedback-triage.tsx` |

The page, the browser and the screen size are captured when the form is sent
and shown to the reporter before sending. The reporter's email reaches the
triage page only when they ticked "you may contact me".

## Who is told

Active members of the GRID Platform organization whose role holds
`platform:settings:manage`. That is the same rule the storage alert uses: a
permission, never a role name, and an unknown role holds nothing.
Break-glass owners (`GRID_PLATFORM_OWNER_EMAILS`) are not members, so they are
not told. They still see every report on the page.

Announcing fails open. The report is stored first, and a WorkOS failure while
resolving the roster is logged instead of costing the reporter their
confirmation.

## The platform lane

The announcement rows are written into the **platform organization**, because
the reporter's tenant has no business holding the platform's mail. Platform
owners mostly work inside some tenant organization, and the inbox used to list
only the active organization's rows. So the inbox service reads in **lanes**
(`frontends/ui/src/lib/inbox/service.ts`):

- the tenant lane: the active organization, and the types `visibleInboxTypes`
  allows;
- the platform lane: the platform organization and the `gate: 'platform'` types.
  It exists only when the reader holds `platform:settings:view`.

Each lane runs as its own organization (`withTenant`), so RLS still sees one
tenant at a time. List, badge, mark-read and archive all go across lanes. The
lanes never share a type, so an owner acting inside the platform organization
still sees each row once.

## Email: declared now, sent later

Every inbox type states its email default in the registry
(`INBOX_TYPE_DEFINITIONS[type].email`, spec IB-5 and IB-11):

- `never` means in-app only;
- `if-unread` with `afterMinutes` means mail a reminder when the row is still
  unread after that long. Reading, archiving or resolving it in the app first
  cancels the mail.

`feedback.submitted` is `if-unread` after 0 minutes, so it is mailed as soon as
a sender exists. **Nothing sends mail yet.** `frontends/ui/src/lib/inbox/delivery.ts`
is the tested contract a sender is built against. Its module comment lists the
steps. The one to get right: the `emailed_at` column ships in the same
migration as the sender. Added earlier, every existing row reads as "due,
never sent", and the first sweep mails the backlog.
