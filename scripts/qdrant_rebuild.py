"""Rebuild a Qdrant collection as a new _vN beside the live one, then move its alias (ADR-0113).

Open-source Qdrant cannot reshard, so a new shard count or replication shape is
a new collection, a copy of the stored vectors (no re-embedding) and one atomic
alias switch. The old collection stays: switching back is the rollback.

    python scripts/qdrant_rebuild.py office --copy-to piloti_office_v2 --shards 12
    python scripts/qdrant_rebuild.py office --switch-to piloti_office_v2      # then backfill --prune --verify
    python scripts/qdrant_rebuild.py office --switch-to piloti_office_v1      # rollback

It reads the environment the backend reads: ``AIQ_QDRANT_URL`` and
``AIQ_QDRANT_API_KEY``. The full procedure is ``docs/deployment/qdrant-runbook.md``.

EXIT CODES: ``0`` done (a copy with equal counts); ``1`` the copy's counts
differ, or the target is refused; ``2`` Qdrant could not be reached.
"""

from __future__ import annotations

import argparse
import logging
import sys

from knowledge_layer.qdrant import rebuild
from knowledge_layer.qdrant.schema import Physical
from knowledge_layer.qdrant.store import make_client

logger = logging.getLogger("qdrant_rebuild")


def _parse_args(argv: list[str] | None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__.split("\n", 1)[0])
    parser.add_argument("physical", choices=[p.value for p in Physical], help="Which physical collection.")
    action = parser.add_mutually_exclusive_group(required=True)
    action.add_argument("--copy-to", metavar="NAME", help="Create NAME and copy the live collection into it.")
    action.add_argument("--switch-to", metavar="NAME", help="Point the alias at NAME (also the rollback).")
    parser.add_argument("--shards", type=int, help="Shard count of the new collection (office only).")
    parser.add_argument("--replication", type=int, help="Replication factor of the new collection.")
    parser.add_argument("--page-size", type=int, default=rebuild.DEFAULT_PAGE_SIZE)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)-8s %(message)s", stream=sys.stdout)
    args = _parse_args(argv)
    physical = Physical(args.physical)
    try:
        client = make_client()
        live = rebuild.current_collection(client, physical)
    except Exception as exc:  # noqa: BLE001 - unreachable and alias-less are the same hard stop
        logger.error("Could not read the alias from Qdrant: %s", exc)
        return 2
    logger.info("%s is %s", physical.value, live)
    try:
        if args.switch_to:
            previous = rebuild.switch_alias(client, physical, args.switch_to)
            logger.info("Switched; roll back with --switch-to %s", previous)
            return 0
        report = rebuild.copy_collection(
            client, physical, args.copy_to, shards=args.shards, replication=args.replication, page_size=args.page_size
        )
    except (ValueError, RuntimeError) as exc:
        logger.error("%s", exc)
        return 1
    logger.info(
        "%s %s -> %s: copied=%d source=%d target=%d",
        "[ok]" if report.complete else "[gap]",
        report.source,
        report.target,
        report.copied,
        report.source_count,
        report.target_count,
    )
    return 0 if report.complete else 1


if __name__ == "__main__":
    sys.exit(main())
