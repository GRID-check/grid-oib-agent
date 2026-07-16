"""Targeted quieting of known-noisy dependency loggers."""

import logging

# nat.builder.intermediate_step_manager assumes strictly LIFO (single-chain)
# step ordering and WARNs on every out-of-order span push/pop:
#   "Step id ... not the last step in the stack. Removing it ..."
#   "Current span ID stack is not equal to the previous stack. ..."
# Our deep-research pipeline legitimately runs steps CONCURRENTLY (parallel
# researcher workers via asyncio.gather, batched source-tool fan-out), so
# sibling steps interleave and these warnings fire on essentially every
# parallel tool call. They are benign telemetry-bookkeeping noise in this
# architecture — the steps themselves are still recorded — but they flood the
# logs and read like errors. Raise that logger to ERROR until NAT supports
# concurrent sibling steps.
_NOISY_DEPENDENCY_LOGGERS = ("nat.builder.intermediate_step_manager",)


def suppress_noisy_dependency_logs() -> None:
    """Raise known-noisy dependency loggers to ERROR.

    Idempotent; call once at process startup (API server and Dask worker).
    """
    for name in _NOISY_DEPENDENCY_LOGGERS:
        logging.getLogger(name).setLevel(logging.ERROR)
