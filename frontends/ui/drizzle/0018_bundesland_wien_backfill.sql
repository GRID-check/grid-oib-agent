-- Backfill: projects created before the intake wizard asked WHERE the building
-- is located get an UNCONFIRMED assumption bundesland=wien (Vienna is the
-- product's home market). It surfaces in the Project Brief's assumptions block
-- for one-click confirm/correct, flows into the agent prompt context as
-- `bundesland=wien` under `assumptions:`, and is retired automatically the
-- moment a confirmed `bundesland` fact is written (pruneResolvedAssumptions).
--
-- profile_prompt_view is derived from the profile by buildProjectPromptView
-- (TypeScript), which a SQL migration cannot call — so the same assumption line
-- is spliced into the stored view here, matching the builder's format exactly
-- ("assumptions:" section, "- <key>=<value>" lines, sections separated by one
-- blank line). The next profile save rebuilds the view from scratch anyway.
-- The prompt-view read cache (ADR-0020) expires within 5 minutes on its own.
--
-- profile_version is bumped so concurrent optimistic writes that loaded the
-- pre-backfill profile fail with 409 and reload instead of silently dropping
-- the assumption. profile_display is NOT touched: the Project Brief derives
-- from the raw profile at render time.
UPDATE projects
SET
  profile = jsonb_set(
    CASE WHEN profile ? 'assumptions' THEN profile ELSE profile || '{"assumptions":{}}'::jsonb END,
    '{assumptions,bundesland}',
    jsonb_build_object(
      'value', 'wien',
      'status', 'unconfirmed',
      'reason', 'Defaulted to Vienna for projects created before Grid asked for the building location. Please confirm or correct it.',
      'source', 'onboarding_default',
      'updatedAt', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  ),
  profile_prompt_view = CASE
    WHEN profile_prompt_view IS NULL OR btrim(profile_prompt_view) = ''
      THEN E'PROJECT_CONTEXT v1\n\nassumptions:\n- bundesland=wien'
    WHEN profile_prompt_view ~ E'(^|\n)assumptions:'
      THEN regexp_replace(profile_prompt_view, E'(^|\n)assumptions:', E'\\1assumptions:\n- bundesland=wien')
    ELSE profile_prompt_view || E'\n\nassumptions:\n- bundesland=wien'
  END,
  profile_version = profile_version + 1,
  profile_updated_at = now()
WHERE
  -- COALESCE: profiles saved before intake are '{}'::jsonb, where `profile ->
  -- 'facts'` is NULL and a bare NOT (NULL ? ...) would silently skip the row.
  NOT COALESCE(profile -> 'facts' ? 'bundesland', false)
  AND NOT COALESCE(profile -> 'assumptions' ? 'bundesland', false);
