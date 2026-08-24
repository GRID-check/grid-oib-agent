"""Google Scholar paper search tool for NAT."""

from .paper_search import PaperSearchTool
from .register import paper_search  # noqa: F401

__all__ = [
    "PaperSearchTool",
    "paper_search",
]
