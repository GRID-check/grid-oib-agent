-- 0088: the `standard` delivery tier is retired.
--
-- ## Why
--
-- `delivery: 'standard'` (0050) was the platform's own instruction, forced onto
-- every organization's turn with no tenant decision in it. It is removed
-- together with the other form of forcing a skill onto a turn — the composer's
-- `skills` array on the WS envelope — because both answered the same question
-- ("how should Piloti behave by default?") with the wrong mechanism: a SKILL is
-- a capability the model may reach for, and a skill that is always forced is an
-- instruction pretending to be one.
--
-- Standing instructions get the two homes they should have had:
--
--   * the PLATFORM PROMPT, for what the platform says (a later slice), and
--   * `organization_instructions` (0087), for what a tenant says.
--
-- `delivery` survives as a column with one legal value, `offer`, rather than
-- being dropped. Dropping it would rewrite the only row shape every prior
-- migration in this table wrote, and the column still says something true: a
-- curated skill is OFFERED to organizations.
--
-- ## The rows that were standard
--
-- Two of them shipped in migrations: `piloti-voice` (0053) and `piloti-cards`
-- (0054), plus whatever a platform owner has published since. Mapped to
-- `offer`, not deleted — the bodies are worth keeping and the rows stay
-- editable in Platform → Skills.
--
-- The consequence is deliberate and worth stating plainly: those skills stop
-- running for everyone. As offers they are listed on each organization's Skills
-- tab and start OFF until that organization switches them on (a dashboard offer
-- has always started off; `curated_skill_activations` records the decision).
-- Anything in them that must keep applying to every turn belongs in the
-- platform prompt, which is where that slice puts it.
--
-- Name reservation goes with the tier: an organization may now author a skill
-- called `piloti-voice`, and its own row wins, exactly as it does against every
-- other offer (ADR-0022's "explicit org value beats deployment default").

UPDATE "platform_skills" SET "delivery" = 'offer' WHERE "delivery" <> 'offer';
--> statement-breakpoint

-- One legal value now. The CHECK is narrowed rather than dropped: a column with
-- a single legal value and no constraint is a column that silently accepts the
-- next typo, and this one is read by the resolver.
ALTER TABLE "platform_skills"
  DROP CONSTRAINT IF EXISTS "platform_skills_delivery_check";
--> statement-breakpoint
ALTER TABLE "platform_skills"
  ADD CONSTRAINT "platform_skills_delivery_check"
  CHECK ("delivery" IN ('offer'));
--> statement-breakpoint

-- The partial index existed to answer "every published standard skill" on the
-- resolver's hot path. Nothing asks that question any more, so the index is
-- pure write cost.
DROP INDEX IF EXISTS "idx_platform_skills_standard";
--> statement-breakpoint

COMMENT ON COLUMN "platform_skills"."delivery" IS
  'offer = listed on every org Skills tab, off until that org switches it on. The only legal value since 0088; the retired standard tier forced a skill onto every turn, which standing instructions now do (platform prompt, organization_instructions). See docs/architecture/agent-skills.md.';
