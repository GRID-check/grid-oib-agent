"""Pytest fixtures for tests."""

from unittest.mock import MagicMock

import pytest
from langchain_core.callbacks import AsyncCallbackHandler
from langgraph.config import get_stream_writer

from aiq_agent.common import turn_status
from aiq_agent.common.llm_provider import LLMProvider
from aiq_agent.common.wire_v2 import StepFinishedBody
from aiq_agent.common.wire_v2 import StepStartedBody
from aiq_agent.turn import inventory


def _install_s1_stand_ins() -> None:
    """Chat wire v2, S2 built before S1 landed: S1's producer surface, as §b gives it.

    Installed only where S1's own names are missing, so it is inert once S1 is
    merged; delete it then. Import time, because the workflow module imports
    these names when it is collected.
    """

    def emit(body):
        try:
            get_stream_writer()(body)
        except RuntimeError:
            return

    def emit_step(step, *, started=False):
        emit(StepStartedBody(step=step) if started else StepFinishedBody(step=step))

    class ToolStepCallback(AsyncCallbackHandler):
        pass

    stand_ins = {
        (turn_status, "emit"): emit,
        (turn_status, "emit_step"): emit_step,
        (turn_status, "ToolStepCallback"): ToolStepCallback,
        (turn_status, "documents_loading_step"): lambda shelves: None,
        (inventory, "pending_uploads"): lambda inv: None,
    }
    for (module, name), value in stand_ins.items():
        if not hasattr(module, name):
            setattr(module, name, value)
    if not hasattr(inventory, "wait_for_uploads"):

        async def wait_for_uploads(scope, inv):
            return inv

        inventory.wait_for_uploads = wait_for_uploads


_install_s1_stand_ins()


@pytest.fixture
def mock_llm():
    """Create a mock LLM for testing."""
    llm = MagicMock()
    llm.ainvoke = MagicMock()
    return llm


@pytest.fixture
def llm_provider(mock_llm):
    """Create an LLMProvider with a mock default LLM."""
    provider = LLMProvider()
    provider.set_default(mock_llm)
    return provider
