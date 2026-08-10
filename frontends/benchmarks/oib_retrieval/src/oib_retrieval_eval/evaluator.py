"""NAT evaluator: grade an agent answer's CITATIONS against the retrieval golden set.

Registers ``oib_retrieval_citation_evaluator`` with NAT (see ``register.py`` for the plugin
entry point). Like the sibling ``oib_compliance`` suite it makes no LLM calls: an answer's
References section names ``file_name, p.N`` units, those units are compared against the
same ``(richtlinie, punkt, grade)`` labels the offline runner uses, and the score is the
graded nDCG of the cited order.

WHY THIS IS A DIFFERENT MEASUREMENT FROM ``runner.py``, NOT A DUPLICATE
-----------------------------------------------------------------------
``runner.py`` asks whether the right Punkt was in the retrieved context at all — a
property of the index and the chunking, measurable offline with no model. This evaluator
asks whether the answer the model wrote actually cited it, which needs a real workflow run
(and therefore a key). Retrieval can be perfect and the citation still wrong; the two
numbers have to be separable to know which half to fix.

All scoring lives in :mod:`metrics`, :mod:`qrels` and :mod:`citations`, none of which
import NAT — this module only unwraps ``EvalInputItem`` and rewraps ``EvalOutputItem``.
"""

import logging
from pathlib import Path

from pydantic import Field

from nat.builder.builder import EvalBuilder
from nat.builder.evaluator import EvaluatorInfo
from nat.cli.register_workflow import register_evaluator
from nat.data_models.evaluator import EvalInput
from nat.data_models.evaluator import EvalInputItem
from nat.data_models.evaluator import EvaluatorBaseConfig
from nat.plugins.eval.data_models.evaluator_io import EvalOutput
from nat.plugins.eval.data_models.evaluator_io import EvalOutputItem
from nat.plugins.eval.evaluator.base_evaluator import BaseEvaluator

from .citations import extract_units
from .metrics import mrr
from .metrics import ndcg_at_k
from .metrics import recall_at_k
from .qrels import ForbiddenUnits
from .qrels import PunktLabel
from .qrels import Unit
from .qrels import load_punkt_index

logger = logging.getLogger(__name__)

#: Scored at production's ``top_k`` so this number and the runner's are read at the same
#: depth even though they measure different stages.
DEFAULT_K = 16

DEFAULT_FORBIDDEN_PREFIXES = ("aenderungen_",)


def _default_index_path() -> Path:
    return Path(__file__).resolve().parents[2] / "fixtures" / "punkt_index.json"


class OIBRetrievalEvaluatorConfig(EvaluatorBaseConfig, name="oib_retrieval_citation_evaluator"):
    """Configuration for the OIB retrieval citation evaluator."""

    punkt_index_path: str = Field(
        default="",
        description="Path to punkt_index.json. Empty uses the copy committed with this suite.",
    )
    k: int = Field(default=DEFAULT_K, ge=1, description="Cutoff for recall/nDCG over the cited units.")
    forbidden_file_prefixes: list[str] = Field(
        default_factory=lambda: list(DEFAULT_FORBIDDEN_PREFIXES),
        description="File-name prefixes a correct answer must never cite (the change-log PDFs).",
    )


class OIBRetrievalEvalOutput(EvalOutput):
    """Extended output with the aggregate a retrieval regression shows up in first."""

    total_evaluated: int = Field(default=0, description="Cases evaluated.")
    total_with_forbidden_citation: int = Field(
        default=0, description="Cases citing at least one forbidden (aenderungen_*) document."
    )
    total_uncited: int = Field(default=0, description="Cases whose answer cited no document page at all.")


class OIBRetrievalEvaluator(BaseEvaluator):
    """Graded citation evaluator for OIB retrieval golden cases (no LLM judge)."""

    def __init__(
        self,
        max_concurrency: int = 4,
        index_path: Path | None = None,
        k: int = DEFAULT_K,
        forbidden_file_prefixes: tuple[str, ...] = DEFAULT_FORBIDDEN_PREFIXES,
    ):
        super().__init__(max_concurrency=max_concurrency, tqdm_desc="OIB Retrieval Citation Evaluation")
        self.index = load_punkt_index(index_path or _default_index_path())
        self.k = k
        self.forbidden = ForbiddenUnits(forbidden_file_prefixes)

    async def evaluate_item(self, item: EvalInputItem) -> EvalOutputItem:
        item_id = str(item.id)
        response = "" if item.output_obj is None else str(item.output_obj)
        expected = item.expected_output_obj if isinstance(item.expected_output_obj, dict) else {}
        labels = expected.get("relevant")
        if labels is None:
            return EvalOutputItem(
                id=item_id,
                score=0.0,
                reasoning={"error": "No 'relevant' Punkt labels in expected_output for this case."},
            )

        graded: dict[Unit, int] = {}
        for raw in labels:
            label = PunktLabel(str(raw["richtlinie"]), str(raw["punkt"]), int(raw["grade"]))
            for unit in self.index.units(label.richtlinie, label.punkt):
                graded[unit] = max(graded.get(unit, 0), label.grade)

        cited = extract_units(response)
        forbidden_hits = [unit for unit in cited if unit in self.forbidden]
        relevant = frozenset(graded)

        # A should-refuse case (empty labels) is scored on ABSTENTION: citing nothing is
        # the correct answer, and every citation is a wrong one. Scoring it with nDCG
        # would give a full marks to an answer that cited ten irrelevant pages, because
        # the ideal DCG is zero either way.
        if not relevant:
            score = 1.0 if not cited else 0.0
        else:
            score = ndcg_at_k(cited, graded, self.k)

        reasoning = {
            "cited_units": [list(unit) for unit in cited],
            "relevant_units": [list(unit) for unit in sorted(relevant)],
            "recall_at_k": recall_at_k(cited, relevant, self.k) if relevant else None,
            "ndcg_at_k": ndcg_at_k(cited, graded, self.k) if relevant else None,
            "mrr": mrr(cited, relevant) if relevant else None,
            "forbidden_citations": [list(unit) for unit in forbidden_hits],
            "should_refuse": not relevant,
            "k": self.k,
            "question": item.input_obj,
        }
        # A forbidden citation is disqualifying, not a deduction: the change-log documents
        # read exactly like requirements, so an answer sourced from one is confidently
        # wrong and no amount of otherwise-correct citation redeems it.
        if forbidden_hits:
            score = 0.0
        return EvalOutputItem(id=item_id, score=score, reasoning=reasoning)

    async def evaluate(self, eval_input: EvalInput) -> OIBRetrievalEvalOutput:
        base_output = await super().evaluate(eval_input)
        forbidden = 0
        uncited = 0
        for output_item in base_output.eval_output_items:
            reasoning = output_item.reasoning if isinstance(output_item.reasoning, dict) else {}
            if reasoning.get("forbidden_citations"):
                forbidden += 1
            if not reasoning.get("cited_units") and not reasoning.get("should_refuse"):
                uncited += 1
        return OIBRetrievalEvalOutput(
            average_score=base_output.average_score,
            eval_output_items=base_output.eval_output_items,
            total_evaluated=len(base_output.eval_output_items),
            total_with_forbidden_citation=forbidden,
            total_uncited=uncited,
        )


@register_evaluator(config_type=OIBRetrievalEvaluatorConfig)
async def register_oib_retrieval_evaluator(config: OIBRetrievalEvaluatorConfig, builder: EvalBuilder):
    """Register the OIB retrieval citation evaluator."""
    evaluator = OIBRetrievalEvaluator(
        max_concurrency=builder.get_max_concurrency(),
        index_path=Path(config.punkt_index_path) if config.punkt_index_path else None,
        k=config.k,
        forbidden_file_prefixes=tuple(config.forbidden_file_prefixes),
    )
    yield EvaluatorInfo(
        config=config,
        evaluate_fn=evaluator.evaluate,
        description="Graded (file_name, page) citation evaluator for OIB retrieval golden cases: nDCG over the "
        "units an answer cited, with change-log citations disqualifying and should-refuse cases scored on "
        "abstention. No LLM judge.",
    )
