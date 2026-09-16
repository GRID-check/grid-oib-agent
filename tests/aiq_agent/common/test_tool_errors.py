"""What a failed tool call says to the model, and what it must never say.

The production fault: a retrieval call was rejected by argument validation, the
tool node rendered pydantic's own message, and the line
``https://errors.pydantic.dev/2.13/v/missing`` in it was captured as a web
source. The Herleitung then showed a card for a host nobody had searched.
"""

import pytest
from pydantic import BaseModel
from pydantic import ValidationError

from aiq_agent.common.tool_errors import render_error_detail
from aiq_agent.common.tool_errors import render_tool_error


class _TwoFields(BaseModel):
    document: str
    punkt: str


def _two_field_error() -> ValidationError:
    with pytest.raises(ValidationError) as caught:
        _TwoFields.model_validate({"punkt": 3})
    return caught.value


class TestAValidationFailureReadsAsClauses:
    def test_each_rejected_field_gets_its_own_clause(self):
        rendered = render_tool_error(_two_field_error())

        assert rendered.startswith("Error: the call was rejected. ")
        assert "document: Field required" in rendered
        assert "punkt: Input should be a valid string" in rendered
        assert rendered.endswith("Fix the arguments and call again.")

    def test_a_short_rejected_value_is_echoed_back(self):
        """The model cannot correct an argument it is not shown."""
        assert "(got 3)" in render_tool_error(_two_field_error())

    def test_no_link_survives_the_rendering(self):
        rendered = render_tool_error(_two_field_error())

        assert "http" not in rendered
        assert "pydantic.dev" not in rendered

    def test_the_wrapped_validation_error_reads_the_same(self):
        """``ToolNode`` hands the handler its own wrapper, not the original."""

        class _Wrapper(Exception):
            def __init__(self, source: ValidationError) -> None:
                super().__init__(str(source))
                self.source = source

        assert render_tool_error(_Wrapper(_two_field_error())) == render_tool_error(_two_field_error())


class TestAnyOtherFailureIsItsOwnMessage:
    def test_the_type_and_the_message_are_both_there(self):
        assert render_tool_error(ValueError("kein Dokument dieses Namens")) == (
            "Error: ValueError: kein Dokument dieses Namens"
        )

    def test_a_pydantic_link_in_the_message_is_dropped(self):
        exc = RuntimeError(
            "store rejected the filter\nFor further information visit https://errors.pydantic.dev/2.13/v/missing"
        )

        rendered = render_tool_error(exc)

        assert rendered == "Error: RuntimeError: store rejected the filter"
        assert "pydantic.dev" not in rendered


class TestTheDetailIsReusableWithoutTheFraming:
    """``emit_card`` writes its own sentence around the same clauses."""

    def test_the_detail_carries_the_clauses_alone(self):
        detail = render_error_detail(_two_field_error())

        assert detail.startswith("document: Field required")
        assert "Fix the arguments" not in detail
        assert "http" not in detail
