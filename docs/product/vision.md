# Product Vision

## What Piloti is

Piloti is the workspace in which a planning office runs a building project.
Piloti the agent is a member of that office. Chat is how you talk to it.
Tasks are how you hand it work. Every normative claim is grounded in a
passage retrieved this turn from the project, the office archive, or the
Austrian building-regulation corpus. Piloti does not replace the
Entwurfsverfasser or the Behörde.

Not every answer is a ruling. A copyable legal value earns a ruling;
summarising a plan or organising drawings does not. Acting — a report, a
check, a filing — is a task.

## Who it is for

- **Primary users:** engineers, architects, consultants, and project managers working on
  construction projects in Austria.
- **Buyers:** construction firms, planning offices, and similar organisations that need
  reliable, shared access to building‑regulation knowledge.

## Core value proposition

- **A place to work.** Files, the model, the office archive, and chat live on
  the project — not in a sidebar Q&A.
- **Grounded answers.** Claims resolve to a passage from this project's files,
  the office archive, or the Austrian building‑regulation corpus — whichever
  the question actually needs. Not every question is a legal question.
- **Work as a team.** Projects group people, documents, and conversations so
  knowledge is shared, not trapped in individual browser sessions.

## What makes it different from a generic chatbot

- An architect's workspace, not a statute chatbot: questions are about the work.
- Grounded: a claim is traceable to a retrieved document on one of the three
  shelves, or it is not presented as fact.
- Structured output: cards sit on the answer when the shape earns them.
- B2B multi‑tenant: organisations, projects, and role‑based access are first‑class.

## Scope today

- **In scope:** OIB‑Richtlinien as the base corpus, WorkOS‑based identity, Grid projects,
  document upload, server‑side conversation persistence, and layered retrieval across base
  + project + conversation corpora.
- **Out of scope for the MVP:** RIS integration, SSO/SCIM (WorkOS enterprise add‑ons later),
  billing, analytics, real‑time collaboration, public consumer access.

## Long‑term direction

Piloti becomes the workspace in which a planning office runs a building project,
and the agent a member of that office who can be handed work. Grounding in the
project, the archive, and the regulation corpus stays; acting (reports, checks,
filings) is tasks.

## Product principles

1. **Grounded answers first.** If we cannot cite it, we do not present it as fact.
2. **Not every answer is a ruling.** A ruling is earned only when there is a copyable
   legal value. Acting is tasks.
3. **Project‑scoped by default.** Knowledge lives in projects, not individual chats.
4. **No dead ends.** Conversations and documents persist server‑side; users can pick up
   where they left off across devices.
5. **Enterprise‑ready identity.** Outsource identity to WorkOS so Grid can grow into
   SSO/SCIM without re‑architecture.
