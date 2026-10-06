"""A checkpointer that refuses to write for a turn that no longer owns its conversation.

The conversation's LangGraph thread is the one piece of shared state two turns
of a conversation must never write at once (ADR-0079). This wraps the real
saver and puts every write to it behind :func:`aiq_agent.common.write_fence.guarded_write`:
checked against the turn's fence first, then bounded in time. Reads, and every
call made outside a turn that has a fence (a job, a single process, affinity
on), go straight through.

Every public method of ``BaseCheckpointSaver`` is delegated explicitly, because
the base class defines them all (raising ``NotImplementedError``), so a
``__getattr__`` fallback would never be reached. ``tests/aiq_agent/common/test_fenced_checkpointer.py``
fails when LangGraph adds one this class does not forward.
"""

from __future__ import annotations

from collections.abc import AsyncIterator
from collections.abc import Collection
from collections.abc import Iterator
from collections.abc import Mapping
from collections.abc import Sequence
from typing import Any

from langchain_core.runnables import RunnableConfig
from langgraph.checkpoint.base import BaseCheckpointSaver
from langgraph.checkpoint.base import ChannelVersions
from langgraph.checkpoint.base import Checkpoint
from langgraph.checkpoint.base import CheckpointMetadata
from langgraph.checkpoint.base import CheckpointTuple

from aiq_agent.common.write_fence import check_write
from aiq_agent.common.write_fence import current_write_fence
from aiq_agent.common.write_fence import guarded_write


class FencedCheckpointer(BaseCheckpointSaver):
    """``inner``, with its writes fenced by the current turn's write fence."""

    def __init__(self, inner: BaseCheckpointSaver) -> None:
        super().__init__(serde=inner.serde)
        self._inner = inner

    @property
    def inner(self) -> BaseCheckpointSaver:
        return self._inner

    @property
    def config_specs(self) -> list:
        return self._inner.config_specs

    def with_allowlist(self, extra_allowlist: Collection[tuple[str, ...]]) -> BaseCheckpointSaver:
        return FencedCheckpointer(self._inner.with_allowlist(extra_allowlist))

    def get_next_version(self, current: Any, channel: Any) -> Any:
        return self._inner.get_next_version(current, channel)

    # ---- reads: never fenced ------------------------------------------------
    def get(self, config: RunnableConfig) -> Checkpoint | None:
        return self._inner.get(config)

    async def aget(self, config: RunnableConfig) -> Checkpoint | None:
        return await self._inner.aget(config)

    def get_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return self._inner.get_tuple(config)

    async def aget_tuple(self, config: RunnableConfig) -> CheckpointTuple | None:
        return await self._inner.aget_tuple(config)

    def list(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,  # noqa: A002 - the saver API's own name
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> Iterator[CheckpointTuple]:
        return self._inner.list(config, filter=filter, before=before, limit=limit)

    async def alist(
        self,
        config: RunnableConfig | None,
        *,
        filter: dict[str, Any] | None = None,  # noqa: A002 - the saver API's own name
        before: RunnableConfig | None = None,
        limit: int | None = None,
    ) -> AsyncIterator[CheckpointTuple]:
        async for item in self._inner.alist(config, filter=filter, before=before, limit=limit):
            yield item

    def get_delta_channel_history(self, *, config: RunnableConfig, channels: Sequence[str]) -> Mapping[str, Any]:
        return self._inner.get_delta_channel_history(config=config, channels=channels)

    async def aget_delta_channel_history(self, *, config: RunnableConfig, channels: Sequence[str]) -> Mapping[str, Any]:
        return await self._inner.aget_delta_channel_history(config=config, channels=channels)

    # ---- writes: refused once the turn is fenced, bounded while it is not ---
    def put(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        check_write(current_write_fence())
        return self._inner.put(config, checkpoint, metadata, new_versions)

    async def aput(
        self,
        config: RunnableConfig,
        checkpoint: Checkpoint,
        metadata: CheckpointMetadata,
        new_versions: ChannelVersions,
    ) -> RunnableConfig:
        async with guarded_write():
            return await self._inner.aput(config, checkpoint, metadata, new_versions)

    def put_writes(
        self, config: RunnableConfig, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = ""
    ) -> None:
        check_write(current_write_fence())
        self._inner.put_writes(config, writes, task_id, task_path)

    async def aput_writes(
        self, config: RunnableConfig, writes: Sequence[tuple[str, Any]], task_id: str, task_path: str = ""
    ) -> None:
        async with guarded_write():
            await self._inner.aput_writes(config, writes, task_id, task_path)

    def delete_thread(self, thread_id: str) -> None:
        check_write(current_write_fence())
        self._inner.delete_thread(thread_id)

    async def adelete_thread(self, thread_id: str) -> None:
        async with guarded_write():
            await self._inner.adelete_thread(thread_id)

    def delete_for_runs(self, run_ids: Sequence[str]) -> None:
        check_write(current_write_fence())
        self._inner.delete_for_runs(run_ids)

    async def adelete_for_runs(self, run_ids: Sequence[str]) -> None:
        async with guarded_write():
            await self._inner.adelete_for_runs(run_ids)

    def copy_thread(self, source_thread_id: str, target_thread_id: str) -> None:
        check_write(current_write_fence())
        self._inner.copy_thread(source_thread_id, target_thread_id)

    async def acopy_thread(self, source_thread_id: str, target_thread_id: str) -> None:
        async with guarded_write():
            await self._inner.acopy_thread(source_thread_id, target_thread_id)

    def prune(self, thread_ids: Sequence[str], *, strategy: str = "keep_latest") -> None:
        check_write(current_write_fence())
        self._inner.prune(thread_ids, strategy=strategy)

    async def aprune(self, thread_ids: Sequence[str], *, strategy: str = "keep_latest") -> None:
        async with guarded_write():
            await self._inner.aprune(thread_ids, strategy=strategy)
