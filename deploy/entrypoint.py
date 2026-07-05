# SPDX-FileCopyrightText: Copyright (c) 2025-2026, NVIDIA CORPORATION & AFFILIATES. All rights reserved.  # noqa: E501
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""Launch a local Dask cluster and the web server."""

from __future__ import annotations

import logging
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from pathlib import Path


def _terminate_process(proc: subprocess.Popen[str] | None) -> None:
    if proc is None or proc.poll() is not None:
        return
    proc.terminate()
    try:
        proc.wait(timeout=10)
    except subprocess.TimeoutExpired:
        proc.kill()


def _install_signal_handlers(
    scheduler_proc: subprocess.Popen[str],
    worker_proc: subprocess.Popen[str],
    web_proc: subprocess.Popen[str],
) -> None:
    def _handle_signal(_signum: int, _frame: object) -> None:
        print("Shutting down...", flush=True)
        _terminate_process(web_proc)
        _terminate_process(worker_proc)
        _terminate_process(scheduler_proc)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)


def _wait_for_scheduler(port: int) -> None:
    from distributed import Client

    print("Waiting for scheduler to start...", flush=True)
    for attempt in range(1, 31):
        try:
            Client(f"tcp://localhost:{port}", timeout="2s").close()
            print("Scheduler ready.", flush=True)
            return
        except Exception as exc:
            if attempt == 30:
                raise RuntimeError("Scheduler failed to start") from exc
            time.sleep(1)


def _clear_directory_contents(path: Path) -> None:
    """Clear a directory without removing the directory itself.

    Docker Compose mounts ``AIQ_CHROMA_DIR`` as a volume root, so removing the
    root path raises ``Device or resource busy``.  Clearing children preserves
    the mount point while still forcing Chroma to rebuild its persisted state.
    """
    for child in path.iterdir():
        if child.is_dir() and not child.is_symlink():
            shutil.rmtree(child)
        else:
            child.unlink()


def _run_oib_sync_background() -> None:
    """Run OIB PDF ingestion in the background after the server starts."""
    # The entrypoint process never configures logging, so oib_sync's INFO
    # progress logs are invisible without this.
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s - %(levelname)-8s - %(name)s - %(message)s",
        stream=sys.stdout,
    )
    time.sleep(5)

    if os.environ.get("OIB_FORCE_REINGEST", "").lower() in ("1", "true", "yes"):
        registry = Path(os.environ.get("OIB_REGISTRY_PATH", "data/oib_registry.json"))
        if registry.exists():
            registry.unlink()
            print("OIB_FORCE_REINGEST: deleted registry", flush=True)
        chroma_dir = Path(os.environ.get("AIQ_CHROMA_DIR", "/tmp/chroma_data"))
        if chroma_dir.exists():
            _clear_directory_contents(chroma_dir)
            print(f"OIB_FORCE_REINGEST: cleared Chroma data at {chroma_dir}", flush=True)

    try:
        from aiq_agent.oib_sync import sync  # noqa: PLC0415

        added, total = sync()
        print(f"OIB sync: {added} added/changed, {total} total", flush=True)
    except Exception as exc:
        print(f"OIB sync failed (non-fatal): {exc}", flush=True)


def main() -> int:
    if len(sys.argv) > 1:
        os.execvp(sys.argv[1], sys.argv[1:])

    config_file = os.getenv(
        "CONFIG_FILE",
        "/app/configs/config_web_default_llamaindex.yml",
    )
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))
    scheduler_port = int(os.getenv("DASK_SCHEDULER_PORT", "8786"))
    nworkers = os.getenv("DASK_NWORKERS", "1")
    nthreads = os.getenv("DASK_NTHREADS", "4")
    memory_limit = os.getenv("DASK_MEMORY_LIMIT")
    lifetime = os.getenv("DASK_LIFETIME")

    print("============================================", flush=True)
    print("NVIDIA NeMo Agent toolkit - Local Dask Mode", flush=True)
    print("============================================", flush=True)
    print("", flush=True)
    print(f"Config: {config_file}", flush=True)
    print(f"API:    http://{host}:{port}", flush=True)
    print(f"Dask:   tcp://localhost:{scheduler_port}", flush=True)
    print("", flush=True)

    scheduler_proc = subprocess.Popen(
        [
            "dask-scheduler",
            "--port",
            str(scheduler_port),
            "--dashboard-address",
            ":8787",
        ],
    )

    try:
        _wait_for_scheduler(scheduler_port)
    except RuntimeError as exc:
        _terminate_process(scheduler_proc)
        raise SystemExit(str(exc)) from exc

    worker_args = [
        "dask-worker",
        f"tcp://localhost:{scheduler_port}",
        "--nworkers",
        str(nworkers),
        "--nthreads",
        str(nthreads),
        "--no-dashboard",
    ]
    if memory_limit:
        worker_args += ["--memory-limit", memory_limit]
    if lifetime:
        lifetime_restart = os.getenv("DASK_LIFETIME_RESTART", "true").lower() != "false"
        worker_args += ["--lifetime", lifetime]
        if lifetime_restart:
            worker_args += ["--lifetime-restart"]

    worker_proc = subprocess.Popen(worker_args)

    print("Waiting for worker to connect...", flush=True)
    time.sleep(3)

    os.environ["NAT_DASK_SCHEDULER_ADDRESS"] = f"tcp://localhost:{scheduler_port}"

    print("", flush=True)
    print("--------------------------------------------", flush=True)
    print("  Dask cluster ready", flush=True)
    print("  Starting web server...", flush=True)
    print("--------------------------------------------", flush=True)
    print("", flush=True)

    web_proc = subprocess.Popen(["python", "/app/deploy/start_web.py"])

    threading.Thread(target=_run_oib_sync_background, daemon=True).start()

    _install_signal_handlers(scheduler_proc, worker_proc, web_proc)

    try:
        return web_proc.wait()
    finally:
        _terminate_process(web_proc)
        _terminate_process(worker_proc)
        _terminate_process(scheduler_proc)


if __name__ == "__main__":
    sys.exit(main())
