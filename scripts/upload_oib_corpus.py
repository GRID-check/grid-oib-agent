"""Upload every PDF in a directory to the base corpus, through the backend's admin route.

The base corpus lives in object storage and is written only through the
backend (ADR-0082), so a developer who has a directory of OIB PDFs uploads them
the way the admin UI does: ``POST /v1/admin/oib/documents``. Each upload stores
the file and queues its ingestion; this script does not wait for ingestion,
watch ``/v1/oib/status`` for that.

    GRID_ADMIN_TOKEN=... uv run python scripts/upload_oib_corpus.py data/oib
    uv run python scripts/upload_oib_corpus.py data/oib --url http://localhost:8000

``GRID_ADMIN_TOKEN`` is the backend's own setting; a backend without one accepts
the request unauthenticated (local dev), and the header is then omitted.
"""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

import httpx

_UPLOAD_PATH = "/v1/admin/oib/documents"
_TIMEOUT_SECONDS = 300.0


def _upload(client: httpx.Client, url: str, pdf: Path, headers: dict[str, str]) -> str | None:
    """None when the backend accepted ``pdf``, else why not."""
    with pdf.open("rb") as handle:
        response = client.post(
            f"{url}{_UPLOAD_PATH}", files={"file": (pdf.name, handle, "application/pdf")}, headers=headers
        )
    if response.status_code == 200:
        return None
    return f"HTTP {response.status_code}: {response.text[:200]}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=(__doc__ or "").split("\n\n")[0])
    parser.add_argument("directory", type=Path, help="Directory holding the PDFs (searched recursively).")
    parser.add_argument("--url", default=os.environ.get("GRID_BACKEND_URL", "http://localhost:8000"))
    args = parser.parse_args(argv)

    pdfs = sorted(p for p in args.directory.rglob("*.pdf") if p.is_file())
    if not pdfs:
        print(f"No PDF files found in {args.directory}", file=sys.stderr)
        return 1

    token = os.environ.get("GRID_ADMIN_TOKEN", "")
    headers = {"X-Admin-Token": token} if token else {}
    failures = 0
    with httpx.Client(timeout=_TIMEOUT_SECONDS) as client:
        for pdf in pdfs:
            problem = _upload(client, args.url.rstrip("/"), pdf, headers)
            failures += problem is not None
            print(f"ok   {pdf.name}" if problem is None else f"FAIL {pdf.name}  {problem}")
    print(f"{len(pdfs) - failures} of {len(pdfs)} uploaded; ingestion runs in the background")
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
