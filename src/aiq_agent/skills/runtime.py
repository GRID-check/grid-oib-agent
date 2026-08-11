"""Per-run skill runtime: prompt blocks + the ``use_skill`` tool.

Skills are progressive disclosure: L1 is the description list (never expanded
further than a line each), L2 is the full body, loaded ONLY through the
``use_skill`` tool. The runtime is per run (ADR-0018 — never cached on a
shared agent instance): it owns the ordered activation list that surfaces as
``skills_activated`` on the terminal frame, and records which skills were
FORCED for a turn vs. invoked by the model.

German UI strings follow the knowledge-layer block conventions
(``## Verfügbare Skills``), matching the agent's German-facing instructions.
"""

from __future__ import annotations

import logging

from .models import Skill

logger = logging.getLogger(__name__)

_L1_HEADING = "## Verfügbare Skills"
_L1_DOCTRINE = "Rufe `use_skill` auf, um die vollständigen Anweisungen eines Skills zu laden, bevor du sie befolgst."
_FORCED_HEADING = "## Aktive Skills (vom Nutzer erzwungen)"
_FORCED_DOCTRINE = (
    "Die folgenden Skills sind für diese Anfrage AKTIVIERT und müssen unbedingt "
    "angewendet werden. Rufe `use_skill` für jeden davon auf, sobald seine "
    "Anweisungen relevant werden."
)

_TOOL_NAME = "use_skill"
_TOOL_DESCRIPTION = (
    "Load the full instructions of a skill by name before following them. "
    "Call this once per skill you intend to use; it returns the complete skill body."
)


class SkillRuntime:
    """Holds the resolved skills of ONE run and builds its prompt/tool wiring.

    Attributes:
        skills: The resolved skill set for this run (builtin + org, allowlisted).
        force_names: Skill names the user's request forced for this run.
        activated: Ordered skill names activated this run — forced names first
            (in force order), then model-invoked names (call order), deduped.
    """

    def __init__(self, skills: tuple[Skill, ...] = (), force_names: list[str] | None = None) -> None:
        self._skills: tuple[Skill, ...] = skills
        self._by_name: dict[str, Skill] = {s.name: s for s in skills}
        self._forced: list[str] = []
        self._activated: list[str] = []
        self._activated_seen: set[str] = set()
        for name in force_names or ():
            if name in self._by_name and name not in self._activated_seen:
                self._forced.append(name)
                self._activated.append(name)
                self._activated_seen.add(name)

    @property
    def skills(self) -> tuple[Skill, ...]:
        return self._skills

    @property
    def forced(self) -> tuple[str, ...]:
        return tuple(self._forced)

    @property
    def activated(self) -> tuple[str, ...]:
        return tuple(self._activated)

    def _record_activation(self, name: str) -> None:
        if name not in self._activated_seen:
            self._activated.append(name)
            self._activated_seen.add(name)

    def prompt_block(self) -> str | None:
        """L1: the progressive-disclosure catalog section, or None when empty.

        One line per skill (name + description); the model must opt IN via
        ``use_skill`` to see a body. ``None`` when no skills apply — callers
        then render no skills section at all.
        """
        if not self._skills:
            return None
        lines = [_L1_HEADING, _L1_DOCTRINE, ""]
        lines.extend(f"- `{s.name}`: {s.description}" for s in self._skills)
        return "\n".join(lines)

    def forced_block(self) -> str | None:
        """L1 block naming the skills FORCED for this turn, or None."""
        if not self._forced:
            return None
        lines = [_FORCED_HEADING, _FORCED_DOCTRINE, ""]
        lines.extend(f"- `{name}`" for name in self._forced)
        return "\n".join(lines)

    def build_tools(self) -> list[object]:
        """The ``use_skill`` tool closure for this run; [] when no skills apply.

        The closure captures THIS runtime instance, so multiple agents built
        from the same skill set never share activation state.
        """
        if not self._skills:
            return []
        from langchain_core.tools import tool as langchain_tool

        runtime = self

        @langchain_tool(_TOOL_NAME)
        def use_skill(skill_name: str) -> str:
            """Return the full instructions of ``skill_name``, or an error listing the available skills."""
            skill = runtime._by_name.get(skill_name)
            if skill is None:
                available = ", ".join(sorted(runtime._by_name))
                return (
                    f"Unbekannter Skill '{skill_name}'. Verfügbare Skills: {available}. "
                    f"Rufe `{_TOOL_NAME}` mit einem dieser Namen auf."
                )
            runtime._record_activation(skill_name)
            return skill.body

        use_skill.description = _TOOL_DESCRIPTION
        return [use_skill]
