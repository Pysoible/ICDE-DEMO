from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import MagicMock, patch

import pytest

from harnessing_ts.agent.sdk_runner import SdkRunner, SdkRunnerConfig
from harnessing_ts.state.message_log import MessageLog


def test_pause_and_normal_checkpoint_share_one_settlement_owner(tmp_path, monkeypatch) -> None:
    runner = SdkRunner(SdkRunnerConfig(
        cwd=tmp_path,
        system_prompt="test",
        allowed_tools=[],
        log=MessageLog(tmp_path / "main.jsonl"),
    ))
    harness = MagicMock()
    harness.run.return_value = SimpleNamespace(events=[])
    checkpoint_entered = asyncio.Event()
    release_checkpoint = asyncio.Event()
    methods: list[str] = []

    def request(method, params, **_kwargs):
        methods.append(method)
        if method == "session/open":
            return SimpleNamespace(sessionId=params["sessionId"], source="created", lastSeq=-1)
        if method == "session/checkpoint":
            return SimpleNamespace(sessionId=params["sessionId"], checkpointSeq=7, turnEnd=None)
        if method == "session/pause":
            return SimpleNamespace(sessionId=params["sessionId"], checkpointSeq=8, turnEnd=None)
        raise AssertionError(method)

    harness.client.request.side_effect = request
    module = SimpleNamespace(
        DeepSeekHarness=MagicMock(return_value=harness),
        DeepSeekHarnessConfig=lambda **kwargs: SimpleNamespace(**kwargs),
    )

    async def controlled_to_thread(func, /, *args, **kwargs):
        if getattr(func, "__name__", "") == "_checkpoint_session":
            checkpoint_entered.set()
            await release_checkpoint.wait()
        return func(*args, **kwargs)

    monkeypatch.setattr(asyncio, "to_thread", controlled_to_thread)

    async def scenario() -> None:
        try:
            with patch.dict("sys.modules", {"deepseek_harness": module}):
                turn = asyncio.create_task(runner.send("hello"))
                await asyncio.wait_for(checkpoint_entered.wait(), 2)
                pause = asyncio.create_task(runner.interrupt())
                await asyncio.sleep(0)
                release_checkpoint.set()
                await asyncio.wait_for(pause, 2)
                with pytest.raises(RuntimeError, match="Paused by user"):
                    await asyncio.wait_for(turn, 2)
        finally:
            release_checkpoint.set()

    asyncio.run(scenario())
    assert methods.count("session/checkpoint") == 1
    assert "session/pause" not in methods
    harness.close.assert_called_once()
