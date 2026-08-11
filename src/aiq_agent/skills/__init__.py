"""Shared agent skills substrate (agentskills.io format).

Builtin (platform) skills ship as SKILL.md files under
``src/aiq_agent/skills/builtin`` and are validated STRICTLY at discovery;
org-authored skills are served by the BFF internal endpoint
(``/api/internal/skills/resolve``) and resolved fail-open per run.
"""

from .builtin import BUILTIN_SKILLS_DIR
from .builtin import discover_builtin_skills
from .models import GRID_CARDS_KEY
from .models import GRID_METADATA_KEYS
from .models import MAX_DESCRIPTION_CHARS
from .models import MAX_NAME_CHARS
from .models import Skill
from .models import SkillValidationError
from .models import parse_skill_md
from .models import preferred_cards
from .resolver import SkillResolver
from .runtime import SkillRuntime

__all__ = [
    "BUILTIN_SKILLS_DIR",
    "GRID_CARDS_KEY",
    "GRID_METADATA_KEYS",
    "MAX_DESCRIPTION_CHARS",
    "MAX_NAME_CHARS",
    "Skill",
    "SkillResolver",
    "SkillRuntime",
    "SkillValidationError",
    "discover_builtin_skills",
    "parse_skill_md",
    "preferred_cards",
]
