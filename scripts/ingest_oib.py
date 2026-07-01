# SPDX-FileCopyrightText: Copyright (c) 2026, Grid Agent Contributors. All rights reserved.
# SPDX-License-Identifier: Apache-2.0

"""CLI entry point for incremental OIB PDF ingestion."""

from aiq_agent.oib_sync import sync

if __name__ == "__main__":
    added, total = sync()
    print(f"OIB sync complete: {added} added/changed, {total} total tracked")
