# Project Mail Inbox

Every project has its own email address. Send a mail with plans or permits to
it, and Piloti files the attachments in the project as if you had uploaded
them yourself. No more downloading from Outlook and dragging the files back in.

Why it works this way: [ADR-0074](../adr/0074-project-mail-inbox-via-cloudflare-email-routing.md).
The data protection review: [`inbound-mail-review-2026-09.md`](../compliance/inbound-mail-review-2026-09.md).
The public version of this page: `https://piloti.at/e-mail-eingang/`, which the
settings card and every bounce link to.

## Where to find the address

Open the project's settings and find the section **E-Mail-Eingang**. The
**Projektadresse** looks like this:

```
wohnbau-hietzing.k3m7q2xw4pab@piloti-post.at
```

Copy it with the button beside it and save it as a contact in your mail client.
The part before the dot is the project name, there for you to recognise the
address. Only the twelve characters after the dot identify the project, so
renaming the project does not change the address and does not break it.

If you do not see the section, one of two things is true: you may not add
documents to this project, or the mail inbox is not switched on for your
organization. Each organization gets it switched on separately, after it has
been told that mail is received through Cloudflare. Ask your administrator.

## Who can send

Only members of the organization who may add documents to that project:
people with `project:documents:write` or `project:edit` on it. Piloti checks
the **From** address of the mail against the members of the project's
organization. Send from the address you sign in to Piloti with.

A mail from anyone else is refused, even if it reaches the right address.
Clients, engineers and authorities cannot send to the project address directly
yet. Forward their mail yourself.

Put the project address in **To** or **Cc**. A mail that has it only in
**Bcc** is refused: Piloti accepts a mail only when your mail server's
signature covers a recipient line that names the project, so that a mail you
sent to somebody else cannot be re-sent into a project.

Do not put the project address in a mail to people outside your office. It
would end up in their address books and in every reply-all. They cannot file
anything, but every reply of theirs to it bounces, and the address is known
to people who have no use for it.

## What happens to a mail

- **Filing takes a moment.** Piloti accepts the mail at once and files it from
  a queue shortly afterwards, usually within a minute. If something is briefly
  unavailable, it tries again for up to about a day.
- **One folder per mail**, under **E-Mail-Eingang**, named after the time the
  mail arrived (Vienna time) and the sender, for example
  `E-Mail-Eingang/2026-09-30 10.15 – Anna Berger`. The subject is not part of
  the name. Two mails from the same sender in the same minute get
  `… Anna Berger (2)`.
- **Every attachment becomes a project document**, is indexed, and can be
  searched and cited like any upload. It counts against your organization's
  storage quota. Two attachments with the same name in one mail are filed as
  `plan.pdf` and `plan (2).pdf`.
- **A mail forwarded as an attachment** (an `.eml`) is opened, and the files
  inside it are filed. The forwarded mail itself is not.
- **A notification in your Piloti inbox** says how many files were filed and
  lists the ones that were not, each with its reason. If the files could not
  be filed at all, the notification says so; upload them in the app instead.
- If a mail server delivers the same mail twice, Piloti files it once.

### What is not filed, and why

| Not filed | Why | What to do |
|---|---|---|
| Images pasted into the mail text, and signature logos (`image001.png`, `Outlook-….png`, images under 2 KB) | They are part of the mail's layout, not files you meant to send | Attach the image as a file |
| `winmail.dat` | Outlook's own format, which only Outlook can read | Set Outlook to send in HTML or plain-text format, and send again |
| The signature of a signed mail (`smime.p7s`, PGP signatures) | It proves who sent the mail; it is not a document | Nothing |
| Encrypted mail and encrypted parts (`smime.p7m`, PGP) | Piloti cannot read them | Send the files unencrypted, or upload them in the app |
| Calendar invites (`.ics`) | Not a project document | Nothing |
| Empty attachments, and unnamed parts whose type Piloti cannot recognise | Nothing to file | Name the file and attach it again |
| Files past the hundredth in one mail | The limit per mail | Send the rest in a second mail |
| A file type Piloti does not accept, a file that is too large, or a full storage quota | The same rules as an upload | Only that file is skipped; the rest are filed |
| Links to cloud files (OneDrive, Google Drive, WeTransfer) | Piloti does not fetch them | Attach the files, or upload them in the app |
| **The text of the mail** | It is not stored | If the text matters, save it as a PDF and attach it |

## Limits

- **Attachments of about 18 MB in total per mail.** The mail itself may be
  25 MB, but encoding attachments for mail makes them about a third larger.
  Larger mails are refused by the mail server before Piloti sees them.
- **At most 100 files per mail.** Any more are skipped and listed in the
  notification.
- **60 mails per hour per project address.** Mails above that are not lost:
  your mail server tries again later.

## Why a mail bounces

A refused mail comes back to you with this text:

> Diese Nachricht konnte nicht zugestellt werden: Die Adresse ist unbekannt,
> oder der Absender ist fuer dieses Projekt nicht berechtigt bzw. nicht
> verifizierbar. Hilfe: https://piloti.at/e-mail-eingang/
> Datenschutz: https://piloti.at/datenschutz/

The text is the same for every reason, so that nobody can probe which
addresses exist or who is a member. The reason is one of these:

| Reason | What to do |
|---|---|
| The address is mistyped, or it was replaced by a new one | Copy the current address from the project settings |
| The mail inbox is not switched on for your organization | Ask your administrator |
| You are not a member of the project | Ask a project admin to add you |
| You are a member but may not add documents | Ask a project admin for a role with document write access |
| You sent from a different address than your Piloti account | Send from the address you sign in with |
| The project address was only in Bcc | Put it in To or Cc |
| Your mail domain does not sign with DKIM | See below |

### Scanners, multifunction devices and forwarding rules

These usually bounce. A scanner or multifunction device that mails its scans
sends from its own address, which is not a member, and usually without a DKIM
signature. A server-side forwarding rule (a mailbox rule in Exchange, a
forward in Gmail's settings) sends the mail on with its original sender and
its original recipients: the sender is usually not a member, and the signed
recipient lines do not name the project. Forward by hand from your mail
client instead, or save the scan and upload it in the app.

### "Domain not verifiable": enabling DKIM

Piloti accepts a mail only when it can prove that it really comes from your
domain. That takes a DKIM signature from your own domain, the one in your
From address. A DMARC policy alone is not enough: a mail without that
signature is refused, because anyone could put your address in the From line.

This hits Microsoft 365 and Google Workspace most often. Unless your IT has
set up DKIM for your own domain, Microsoft signs your mail as
`yourcompany.onmicrosoft.com` and Google as `…gappssmtp.com`, neither of which
is the domain in your From address.

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

## What is kept

The attachments become project documents and stay until you delete them. The
mail text is never stored. Your notification, which names the subject and the
skipped files, is kept for 30 days. Piloti's own delivery record is deleted
after 30 days and keeps no subject once the mail is filed. The mail passes
through Cloudflare, Inc. (USA) on its way in; the privacy policy and the
sub-processor page in the app say more.
