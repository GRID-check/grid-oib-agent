"""FastAPI routes for unified AI-Q API."""

from .collections import add_collection_routes
from .documents import add_document_routes
from .generate_summary import add_generate_summary_routes
from .ingest import add_ingest_routes
from .jobs import register_job_routes
from .maintenance import add_maintenance_routes
from .oib import add_oib_routes

__all__ = [
    "add_collection_routes",
    "add_document_routes",
    "add_generate_summary_routes",
    "add_ingest_routes",
    "register_job_routes",
    "add_maintenance_routes",
    "add_oib_routes",
]
