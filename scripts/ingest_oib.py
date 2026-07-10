# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""CLI entry point for incremental OIB PDF ingestion."""

import logging
import sys

from aiq_agent.oib_sync import sync

if __name__ == "__main__":
    # Without this, oib_sync's INFO progress logs are invisible when the
    # script is run manually (mirrors deploy/entrypoint.py's setup).
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)-8s - %(name)s - %(message)s",
        stream=sys.stdout,
    )
    added, total = sync()
    print(f"OIB sync complete: {added} added/changed, {total} total tracked")
