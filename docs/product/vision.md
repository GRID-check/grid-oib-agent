# Product Vision

## What Grid is

Grid is a **B2B research assistant for Austrian building regulations and law**. A team
working on a building project asks questions like *"Was regelt die OIB‑Richtlinie 6?"* or
*"Gilt diese Anforderung auch für mein Projekt?"* and gets back a citation‑backed answer
with optional structured response cards (Summary, Legal Basis; extensible).

## Who it is for

- **Primary users:** engineers, architects, consultants, and project managers working on
  construction projects in Austria.
- **Buyers:** construction firms, planning offices, and similar organisations that need
  reliable, shared access to building‑regulation knowledge.

## Core value proposition

- **Save research time.** Turn a regulation question into a cited answer in seconds.
- **Reduce risk.** Answers are grounded in the actual OIB‑Richtlinien (today) and later in
  RIS/Bundesrecht, with citations.
- **Work as a team.** Projects group people, documents, and conversations together so
  knowledge is shared, not trapped in individual browser sessions.

## What makes it different from a generic chatbot

- Domain‑specific: built for Austrian building regulations, starting with OIB‑Richtlinien.
- Citation‑first: every answer must be traceable to source documents.
- Structured output: cards give a predictable, machine‑readable layer on top of free‑text
  answers.
- B2B multi‑tenant: organisations, projects, and role‑based access are first‑class concepts.

## Scope today

- **In scope:** OIB‑Richtlinien as the base corpus, WorkOS‑based identity, Grid projects,
  document upload, server‑side conversation persistence, and layered retrieval across base
  + project + conversation corpora.
- **Out of scope for the MVP:** RIS integration, SSO/SCIM (WorkOS enterprise add‑ons later),
  billing, analytics, real‑time collaboration, public consumer access.

## Long‑term direction

Grid becomes the single place where a construction team researches, cites, and applies
Austrian building regulations. The assistant starts with OIB, expands to RIS and related
law, and eventually integrates with project‑specific document workflows (plans,
certificates, approvals).

## Product principles

1. **Grounded answers first.** If we cannot cite it, we do not present it as fact.
2. **Project‑scoped by default.** Knowledge lives in projects, not individual chats.
3. **No dead ends.** Conversations and documents persist server‑side; users can pick up
   where they left off across devices.
4. **Enterprise‑ready identity.** Outsource identity to WorkOS so Grid can grow into
   SSO/SCIM without re‑architecture.
