"""Every ``@register_ingestor`` name resolves to an ingestor CLASS.

The decorator returns whatever it was handed, so decorating a module-level
helper by accident registers a *function* under the backend name and nothing
raises until ``get_ingestor`` tries to instantiate it — at ingestion time, in
production. This is the layer that catches it: import each adapter module and
assert what the registry now holds.
"""

import inspect

import pytest

from aiq_agent.knowledge.base import BaseIngestor
from aiq_agent.knowledge.factory import _INGESTOR_REGISTRY
from aiq_agent.knowledge.factory import is_ingestor_registered
from aiq_agent.knowledge.factory import list_ingestors


@pytest.fixture(autouse=True)
def _import_adapters():
    """Importing an adapter module is what populates the registry."""
    import knowledge_layer.llamaindex.adapter  # noqa: F401


def test_llamaindex_maps_to_an_ingestor_class():
    from knowledge_layer.llamaindex.adapter import LlamaIndexIngestor

    assert is_ingestor_registered("llamaindex")

    registered = _INGESTOR_REGISTRY["llamaindex"]

    assert inspect.isclass(registered), f"llamaindex is registered as {registered!r}, not a class"
    assert issubclass(registered, BaseIngestor)
    assert registered is LlamaIndexIngestor


def test_every_registered_ingestor_is_an_ingestor_class():
    for name in list_ingestors():
        registered = _INGESTOR_REGISTRY[name]

        assert inspect.isclass(registered), f"ingestor {name!r} is registered as {registered!r}, not a class"
        assert issubclass(registered, BaseIngestor), f"ingestor {name!r} does not subclass BaseIngestor"
