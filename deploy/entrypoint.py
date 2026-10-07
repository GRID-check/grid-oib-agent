"""Launch a local Dask cluster and the web server."""

from __future__ import annotations

import os
import signal
import subprocess
import sys
import time


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


def main() -> int:
    if len(sys.argv) > 1:
        os.execvp(sys.argv[1], sys.argv[1:])

    # Role split for horizontal scaling (ADR-0021). A dedicated worker container
    # runs the DB-claimed research worker — no web server, no Dask cluster.
    role = os.getenv("GRID_ROLE", "web").strip().lower()
    if role == "worker":
        print("Starting DB-claimed research worker (GRID_ROLE=worker)...", flush=True)
        os.execvp("python", ["python", "-m", "aiq_api.jobs.worker"])
    # The ingestion tier (ADR-0076): claims from the durable ingest queue, fairly
    # across organisations. No web server, no Dask; scaled on the queue's depth.
    if role == "ingest-worker":
        print("Starting DB-claimed ingest worker (GRID_ROLE=ingest-worker)...", flush=True)
        os.execvp("python", ["python", "-m", "aiq_api.jobs.ingest_worker"])

    config_file = os.getenv(
        "CONFIG_FILE",
        "/app/configs/config_oib_openrouter.yml",
    )
    host = os.getenv("HOST", "0.0.0.0")
    port = int(os.getenv("PORT", "8000"))

    # In db-execution mode the web tier runs NO in-pod Dask cluster; research
    # jobs are executed by dedicated worker containers instead. This is what lets
    # the web/agent tier run as multiple stateless replicas.
    if os.getenv("GRID_JOB_EXECUTION", "dask").strip().lower() == "db":
        print("============================================", flush=True)
        print("Grid agent web tier (db-execution, no Dask)", flush=True)
        print(f"Config: {config_file}", flush=True)
        print(f"API:    http://{host}:{port}", flush=True)
        print("============================================", flush=True)
        web_proc = subprocess.Popen(["python", "/app/deploy/start_web.py"])

        def _handle_web_signal(_signum: int, _frame: object) -> None:
            print("Shutting down...", flush=True)
            _terminate_process(web_proc)
            sys.exit(0)

        signal.signal(signal.SIGTERM, _handle_web_signal)
        signal.signal(signal.SIGINT, _handle_web_signal)
        return web_proc.wait()
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

    # The base corpus is not synced from here: it lives in object storage and a
    # table (ADR-0082), and one sync cycle runs as the base-corpus housekeeping
    # route, on a schedule outside this process.
    web_proc = subprocess.Popen(["python", "/app/deploy/start_web.py"])

    _install_signal_handlers(scheduler_proc, worker_proc, web_proc)

    try:
        return web_proc.wait()
    finally:
        _terminate_process(web_proc)
        _terminate_process(worker_proc)
        _terminate_process(scheduler_proc)


if __name__ == "__main__":
    sys.exit(main())
