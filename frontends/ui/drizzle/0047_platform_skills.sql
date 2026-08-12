-- The skills the PLATFORM curates for every organization (Platform → Skills).
--
-- Global by design — no organization_id. One row is offered to every tenant at
-- once, which is the point: a skill written in the platform dashboard reaches
-- every org and project without anyone copying anything. Whether a given org
-- runs it is that org's decision, stored in curated_skill_activations (0045);
-- deleting THAT row switches the skill off for one tenant, deleting THIS one
-- withdraws it from the fleet.
--
-- The body lives here and only here. That is the difference from the "clone a
-- platform skill" flow this replaces, which copied the instruction into each
-- tenant and left every copy frozen at the moment it was taken.
CREATE TABLE IF NOT EXISTS "platform_skills" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "description" text NOT NULL,
  "body" text NOT NULL,
  "metadata" jsonb DEFAULT '{}' NOT NULL,
  -- Draft until published: a half-written instruction must not appear in every
  -- org's Skills tab the moment it is saved.
  "published" boolean DEFAULT false NOT NULL,
  "created_by" text NOT NULL,
  "created_by_email" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Unique fleet-wide: the name is the key an organization's activation decision
-- refers to, and two curated skills sharing one would make it ambiguous.
CREATE UNIQUE INDEX IF NOT EXISTS "idx_platform_skills_name" ON "platform_skills"("name");

-- ---------------------------------------------------------------------------
-- The tenant boundary (ADR-0041). This table holds NO tenant data and is
-- written only by the platform owner, so it joins the boundary as a PLATFORM
-- table: readable by every tenant, writable only under the audited platform
-- bypass. Securing it with an organization predicate instead would make it
-- unreadable for every tenant, which is the opposite of "offered to all".
-- ---------------------------------------------------------------------------
--> statement-breakpoint
SELECT grid_secure_platform_table('platform_skills');
