# Project Mail Inbox

Every project has its own email address. Forward a mail with plans or permits
to it, and Piloti files the attachments in the project as if you had uploaded
them yourself. No more downloading from Outlook and dragging the files back in.

Why it works this way: [ADR-0074](../adr/0074-project-mail-inbox-via-cloudflare-email-routing.md).
The data protection review: [`inbound-mail-review-2026-09.md`](../compliance/inbound-mail-review-2026-09.md).

## Where to find the address

Open the project's settings and choose **E-Mail-Eingang**. The **Projektadresse**
looks like this:

```
wohnbau-hietzing.k3m7q2xw4pab@piloti-post.at
```

Copy it with the button beside it and save it as a contact in your mail client.
The part before the dot is the project name, there for you to recognise the
address. Only the twelve characters after the dot identify the project, so
renaming the project does not change the address and does not break it.

You see the address when you may add documents to the project. If the section
says the feature is not available, your deployment has no inbound mail domain
configured; ask your administrator.

## Who can send

Only members of the project who may add documents: people with
`project:documents:write` or `project:edit` on that project. Piloti checks the
**From** address of the mail against the members of the project's
organization. Send from the address you sign in to Piloti with.

A mail from anyone else is rejected, even if it reaches the right address.
Clients, engineers and authorities cannot send to the project address directly
yet. Forward their mail yourself.

## What happens to a mail

- Each mail gets its own folder under **E-Mail-Eingang**, named after the date,
  the subject and the sender, for example
  `E-Mail-Eingang/2026-09-30 Einreichplan Rev C – Anna Berger`. A subject longer
  than 60 characters is shortened; a mail without one is filed as
  `(ohne Betreff)`.
- Every attachment becomes a project document, is indexed, and can be searched
  and cited like any upload. It counts against your organization's storage
  quota.
- Two attachments with the same name in one mail are filed as `plan.pdf` and
  `plan (2).pdf`.
- Piloti skips signature logos (small inline images), empty attachments and
  `winmail.dat` files from Outlook. To get the content of a `winmail.dat`, set
  Outlook to send in HTML or plain-text format and send again.
- A file type Piloti does not accept, a file that is too large, or a full
  quota skips that one file. The rest of the mail is still filed.
- **The text of the mail is not stored.** Only the attachments are. If the
  mail text matters, save it as a PDF and attach it.
- When the files are filed, you get a notification in your Piloti inbox.
- If a mail server delivers the same mail twice, Piloti files it once.

## Limits

- 25 MB per mail, attachments included. Larger mails are rejected by the mail
  server before Piloti sees them.
- 60 mails per hour per project address. Mails above that are not lost: your
  mail server tries again later.

## Why a mail bounces

A rejected mail comes back to you with this text:

> Diese Nachricht konnte nicht zugestellt werden: Die Adresse ist unbekannt,
> oder der Absender ist fuer dieses Projekt nicht berechtigt bzw. nicht
> verifizierbar. Bitte laden Sie die Dateien direkt in Piloti hoch.

The text is the same for every reason, so that nobody can probe which
addresses exist or who is a member. The reason is one of these:

| Reason | What to do |
|---|---|
| The address is mistyped, or it was replaced by a new one | Copy the current address from the project settings |
| You are not a member of the project | Ask a project admin to add you |
| You are a member but may not add documents | Ask a project admin for a role with document write access |
| You sent from a different address than your Piloti account | Send from the address you sign in with |
| Your mail domain cannot be verified | See below |

### "Domain not verifiable": enabling DKIM

Piloti accepts a mail only when it can prove that it really comes from your
domain. That works when your domain signs its mail with DKIM, or when it
publishes a DMARC policy of `quarantine` or `reject`. A domain with neither is
rejected, because anyone could put your address in the From line.

This hits Microsoft 365 most often. Unless your IT has set up DKIM for your own
domain, Microsoft signs your mail as `yourcompany.onmicrosoft.com`, which is
not the domain in your From address.

To fix it, ask whoever runs your mail to enable DKIM for your domain:

- **Microsoft 365:** Microsoft Defender portal, *Email & collaboration →
  Policies & rules → Threat policies → Email authentication settings → DKIM*.
  Select your domain, publish the two CNAME records it shows in your DNS, then
  switch signing on.
- **Google Workspace:** Admin console, *Apps → Google Workspace → Gmail →
  Authenticate email*. Generate the key, publish the TXT record in your DNS,
  then click *Start authentication*.

Until then, upload the files in the app.

## Getting a new address

If the address has reached people who should not have it, a project admin
(`project:manage`) can replace it: **E-Mail-Eingang → Neue Adresse erzeugen**.
The old address stops working at once, and mail to it bounces. Give the new
address to everyone who sends files to the project.

A leaked address on its own lets nobody file anything, because the sender must
still be a verified member. A new address mainly stops the bounces.
