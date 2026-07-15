"""Debug routes for development and testing.

Serves the debug console at /debug.
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.responses import FileResponse

STATIC_DIR = Path(__file__).parent / "static"


async def register_debug_routes(app: FastAPI) -> None:
    """Register debug routes for development."""
    console_path = STATIC_DIR / "deep_research_console.html"

    if not console_path.exists():
        return

    @app.get("/debug", include_in_schema=False)
    async def debug_console() -> FileResponse:
        """Serve the debug console."""
        return FileResponse(console_path, media_type="text/html")
