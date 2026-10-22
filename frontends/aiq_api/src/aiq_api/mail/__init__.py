"""Reading one mail message: what its body says, for the BFF's inbound mail.

The BFF receives a mail sent to a project's address, checks who sent it and
what its attachments are (TypeScript: mailauth, postal-mime, ClamAV), and asks
this package the one question it cannot answer well in Node: what does the
message *say*. :func:`.read.read_message` answers it from the raw RFC 5322
bytes, as a :class:`.models.MailRead`:

- the body as text, plain before HTML before RTF (:mod:`.body_text`, shared
  with the Outlook archive reader in :mod:`aiq_api.mail_archive`);
- the sender's own words, apart from the quoted history and without the
  signature (:mod:`.replies`, through ``mail-parser-reply``);
- the calendar invitations it carries, in Vienna time (:mod:`.calendar`,
  through ``icalendar``).

Every byte here is a stranger's, so every parser runs behind a cap
(:mod:`.limits`) and the whole read runs under a deadline. A cap or the
deadline gives a ``MailRead`` that says ``unreadable`` and why; reading never
raises, so a mail is never lost to a parser (DECISION D12, RT-S15). A person
then opens the original instead.

Nothing here calls a model, decides access or stores anything.
"""
