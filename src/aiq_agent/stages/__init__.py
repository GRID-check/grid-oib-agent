"""Post-answer stages — the reusable shape, and the stages declared on it.

A **post-answer stage** is a bounded, gated, independently-failing unit of work
that runs after a turn's answer exists, produces at most one payload addressed to
that turn, and may not affect the answer in any way. Adding one costs a
declaration and a handler: the single call site iterates the registry and never
names a stage.

Importing this package registers every built-in stage, the same way importing a
NAT plugin package registers its functions.

See docs/architecture/post-answer-stages.md.
"""

from aiq_agent.stages.delivery import StageFrameSink
from aiq_agent.stages.delivery import get_stage_frame_sink
from aiq_agent.stages.delivery import register_stage_frame_sink
from aiq_agent.stages.registry import get_stage
from aiq_agent.stages.registry import iter_stages
from aiq_agent.stages.registry import register_stage
from aiq_agent.stages.runner import STAGE_FRAME_TYPE
from aiq_agent.stages.runner import STAGE_FRAME_VERSION
from aiq_agent.stages.runner import build_stage_frame
from aiq_agent.stages.runner import schedule_post_answer_stages
from aiq_agent.stages.spec import GateDecision
from aiq_agent.stages.spec import StageContext
from aiq_agent.stages.spec import StageOutcome
from aiq_agent.stages.spec import StageSpec
from aiq_agent.stages.spec import StageStatus
from aiq_agent.stages.spec import TurnFacts

# Import for the registration side effect: the declarations must exist before
# the call site iterates them. Kept last so the primitive is fully importable
# even if a stage module grows a heavier import.
from aiq_agent.stages import memory_reflection as _memory_reflection  # noqa: E402  isort:skip

MEMORY_REFLECTION = _memory_reflection.MEMORY_REFLECTION

__all__ = [
    "MEMORY_REFLECTION",
    "STAGE_FRAME_TYPE",
    "STAGE_FRAME_VERSION",
    "GateDecision",
    "StageContext",
    "StageFrameSink",
    "StageOutcome",
    "StageSpec",
    "StageStatus",
    "TurnFacts",
    "build_stage_frame",
    "get_stage",
    "get_stage_frame_sink",
    "iter_stages",
    "register_stage",
    "register_stage_frame_sink",
    "schedule_post_answer_stages",
]
