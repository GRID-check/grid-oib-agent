#!/usr/bin/env python3
"""NAT evaluator: OIB compliance golden-case checklist + performance bounds.

Registers ``oib_compliance_checklist_evaluator`` with NAT (see ``register.py``
for the plugin entry point). Unlike the LLM-judge evaluators in the sibling
``freshqa``/``deepsearch_qa`` suites, this evaluator makes no LLM calls of its
own: correctness is a deterministic substring/keyword checklist match (see
``checklist.py``), and performance is read straight off the per-item
``trajectory`` (``IntermediateStep`` list) that NAT's eval runner already
populates for every ``nat eval`` run
(``nat.plugins.eval.runtime.evaluate.EvaluationRunManager._compute_usage_stats``
does the same walk internally to build its own ``UsageStats`` output) — this
evaluator does not duplicate that capture, it just re-derives the three
figures this suite cares about (wall-clock, LLM call count, completion
tokens) from the same source so per-case latency/cost regressions land in
*this* evaluator's output next to correctness, instead of a separate file.
"""

import logging
from typing import Any

from pydantic import Field

from nat.builder.builder import EvalBuilder
from nat.builder.evaluator import EvaluatorInfo
from nat.cli.register_workflow import register_evaluator
from nat.data_models.evaluator import EvalInput
from nat.data_models.evaluator import EvalInputItem
from nat.data_models.evaluator import EvaluatorBaseConfig
from nat.data_models.intermediate_step import IntermediateStepType
from nat.plugins.eval.data_models.evaluator_io import EvalOutput
from nat.plugins.eval.data_models.evaluator_io import EvalOutputItem
from nat.plugins.eval.evaluator.base_evaluator import BaseEvaluator

from .checklist import DEFAULT_BOUNDS
from .checklist import DEFAULT_PASS_THRESHOLD
from .checklist import RunMetrics
from .checklist import grade_case

logger = logging.getLogger(__name__)


class OIBComplianceEvaluatorConfig(EvaluatorBaseConfig, name="oib_compliance_checklist_evaluator"):
    """Configuration for the OIB compliance checklist evaluator."""

    default_pass_threshold: float = Field(
        default=DEFAULT_PASS_THRESHOLD,
        description="Fraction of weighted checklist items a case must satisfy to be marked correct, "
        "unless the case's expected_output overrides it via 'pass_threshold'.",
    )
    default_bounds: dict[str, float] = Field(
        default_factory=lambda: dict(DEFAULT_BOUNDS),
        description="Fallback performance bounds (max_wall_clock_s, max_llm_calls, max_completion_tokens) "
        "for cases that don't set their own 'bounds' in expected_output.",
    )


class OIBComplianceEvalOutput(EvalOutput):
    """Extended output with checklist-pass and bounds-compliance aggregates."""

    total_evaluated: int = Field(default=0, description="Total cases evaluated.")
    total_passed_checklist: int = Field(default=0, description="Cases meeting their checklist pass_threshold.")
    total_within_bounds: int = Field(
        default=0, description="Cases within their latency/LLM-call/token bounds (calibration-pending)."
    )


def _extract_run_metrics(item: EvalInputItem) -> RunMetrics:
    """Derive wall-clock, LLM call count, and completion tokens from a trajectory.

    Mirrors the walk NAT's own eval runner does internally for its
    ``UsageStats`` output (see module docstring) so this evaluator's numbers
    are directly comparable to those in ``workflow_output.json``.
    """
    trajectory = item.trajectory or []
    if not trajectory:
        return RunMetrics()

    timestamps = [step.event_timestamp for step in trajectory]
    wall_clock_seconds = max(timestamps) - min(timestamps)

    llm_calls = 0
    completion_tokens = 0
    total_tokens = 0
    for step in trajectory:
        if step.event_type != IntermediateStepType.LLM_END:
            continue
        llm_calls += 1
        token_usage = step.usage_info.token_usage if step.usage_info else None
        if token_usage is not None:
            completion_tokens += token_usage.completion_tokens
            total_tokens += token_usage.total_tokens

    return RunMetrics(
        wall_clock_seconds=wall_clock_seconds,
        llm_calls=llm_calls,
        completion_tokens=completion_tokens,
        total_tokens=total_tokens,
    )


class OIBComplianceEvaluator(BaseEvaluator):
    """Deterministic checklist + performance-bounds evaluator for OIB golden cases."""

    def __init__(
        self,
        max_concurrency: int = 4,
        default_pass_threshold: float = DEFAULT_PASS_THRESHOLD,
        default_bounds: dict[str, float] | None = None,
    ):
        super().__init__(max_concurrency=max_concurrency, tqdm_desc="OIB Compliance Checklist Evaluation")
        self.default_pass_threshold = default_pass_threshold
        self.default_bounds = default_bounds or dict(DEFAULT_BOUNDS)

    async def evaluate_item(self, item: EvalInputItem) -> EvalOutputItem:
        item_id = str(item.id)
        if isinstance(item.output_obj, str):
            response = item.output_obj
        else:
            response = "" if item.output_obj is None else str(item.output_obj)
        expected = item.expected_output_obj if isinstance(item.expected_output_obj, dict) else {}

        if not expected.get("checklist"):
            return EvalOutputItem(
                id=item_id,
                score=0.0,
                reasoning={"error": "No 'checklist' provided in expected_output for this case."},
            )

        if not response:
            return EvalOutputItem(
                id=item_id,
                score=0.0,
                reasoning={"error": "No model response provided", "is_correct": False},
            )

        # Case-level overrides win; otherwise fall back to the evaluator's defaults.
        merged_expected: dict[str, Any] = {
            "pass_threshold": self.default_pass_threshold,
            "bounds": self.default_bounds,
            **expected,
        }
        metrics = _extract_run_metrics(item)
        result = grade_case(response, merged_expected, metrics, default_threshold=self.default_pass_threshold)
        result["question"] = item.input_obj
        result["response"] = response

        return EvalOutputItem(id=item_id, score=result["score"], reasoning=result)

    async def evaluate(self, eval_input: EvalInput) -> OIBComplianceEvalOutput:
        base_output = await super().evaluate(eval_input)

        total_evaluated = len(base_output.eval_output_items)
        total_passed = 0
        total_within_bounds = 0
        for output_item in base_output.eval_output_items:
            reasoning = output_item.reasoning if isinstance(output_item.reasoning, dict) else {}
            if reasoning.get("is_correct"):
                total_passed += 1
            if reasoning.get("bounds", {}).get("within_bounds"):
                total_within_bounds += 1

        return OIBComplianceEvalOutput(
            average_score=base_output.average_score,
            eval_output_items=base_output.eval_output_items,
            total_evaluated=total_evaluated,
            total_passed_checklist=total_passed,
            total_within_bounds=total_within_bounds,
        )


@register_evaluator(config_type=OIBComplianceEvaluatorConfig)
async def register_oib_compliance_evaluator(config: OIBComplianceEvaluatorConfig, builder: EvalBuilder):
    """Register the OIB compliance checklist evaluator."""
    evaluator = OIBComplianceEvaluator(
        max_concurrency=builder.get_max_concurrency(),
        default_pass_threshold=config.default_pass_threshold,
        default_bounds=config.default_bounds,
    )
    yield EvaluatorInfo(
        config=config,
        evaluate_fn=evaluator.evaluate,
        description="Deterministic substring/keyword checklist + latency/LLM-call/token bounds evaluator "
        "for OIB compliance golden cases (no LLM judge).",
    )
