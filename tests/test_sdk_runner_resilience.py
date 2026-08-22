from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from harnessing_ts.agent.sdk_runner import SdkRunner, SdkRunnerConfig
from harnessing_ts.settings.llm import LlmConfig, build_sdk_invocation_config
from harnessing_ts.state.jsonl import read_jsonl
from harnessing_ts.state.message_log import MessageLog




@pytest.fixture(autouse=True)
def _run_sdk_calls_inline(monkeypatch):
    async def inline(func, /, *args, **kwargs):
        return func(*args, **kwargs)
    monkeypatch.setattr(asyncio, "to_thread", inline)


def _make_runner(tmp_path) -> SdkRunner:
    return SdkRunner(SdkRunnerConfig(
        cwd=tmp_path,
        system_prompt="test",
        allowed_tools=[],
        log=MessageLog(tmp_path / "main.jsonl"),
    ))


def test_manual_deepseek_config_uses_deepseek_environment() -> None:
    sdk = build_sdk_invocation_config(LlmConfig(
        authMode="manual",
        protocol="deepseek",
        model="deepseek-v4-flash",
        apiKey="secret",
        baseUrl="https://api.deepseek.example",
    ))

    assert sdk.model == "deepseek-v4-flash"
    assert sdk.provider == "deepseek-official"
    assert sdk.env == {
        "DEEPSEEK_API_KEY": "secret",
        "DEEPSEEK_BASE_URL": "https://api.deepseek.example",
    }


def test_manual_deepseek_config_requires_key() -> None:
    with pytest.raises(RuntimeError, match="requires apiKey"):
        build_sdk_invocation_config(LlmConfig(authMode="manual", model="deepseek-v4-flash"))


def test_send_with_user_echo_does_not_log_before_dsh_acceptance(tmp_path) -> None:
    runner = _make_runner(tmp_path)
    runner.send = AsyncMock(return_value=[])

    parts = asyncio.run(runner.send_with_user_echo(
        "continue the task",
        context_text='{"recommendedAction":"enter_node"}',
    ))

    runner.send.assert_awaited_once_with(
        '{"recommendedAction":"enter_node"}\n\n## Current User Message\ncontinue the task'
    )
    assert parts[0]["text"] == "continue the task"
    assert read_jsonl(runner.config.log.path) == []


def _dsh_module(harness: MagicMock) -> SimpleNamespace:
    harness.client.request.side_effect = lambda method, params, **_kwargs: (
        SimpleNamespace(
            sessionId=params["sessionId"],
            source="resumed" if params.get("mode") in {"resume", "recover"} else "created",
            lastSeq=-1,
        )
        if method == "session/open"
        else SimpleNamespace(sessionId=params["sessionId"], checkpointSeq=3, turnEnd=None)
    )
    return SimpleNamespace(
        DeepSeekHarness=MagicMock(return_value=harness),
        DeepSeekHarnessConfig=lambda **kwargs: SimpleNamespace(**kwargs),
    )


def test_runner_closes_and_resets_runtime_on_turn_error(tmp_path) -> None:
    runner = _make_runner(tmp_path)
    harness = MagicMock()
    harness.run.side_effect = RuntimeError("simulated runtime crash")

    with patch.dict("sys.modules", {"deepseek_harness": _dsh_module(harness)}):
        with pytest.raises(RuntimeError, match="runtime crash"):
            asyncio.run(runner.send("hello"))

    harness.close.assert_called_once()
    assert runner._harness is None


def test_runner_closes_runtime_when_checkpoint_fails(tmp_path) -> None:
    runner = _make_runner(tmp_path)
    harness = MagicMock()
    harness.run.return_value = SimpleNamespace(events=[])

    def request(method, params, **_kwargs):
        if method == "session/open":
            return SimpleNamespace(sessionId=params["sessionId"], source="created", lastSeq=-1)
        raise RuntimeError("checkpoint transport failed")

    harness.client.request.side_effect = request
    with patch.dict("sys.modules", {"deepseek_harness": _dsh_module(harness)}):
        harness.client.request.side_effect = request
        with pytest.raises(RuntimeError, match="checkpoint transport failed"):
            asyncio.run(runner.send("hello"))

    harness.close.assert_called_once()
    assert runner._harness is None


def test_session_identity_and_user_echo_commit_only_after_dsh_acceptance(tmp_path) -> None:
    committed: list[str] = []
    runner = SdkRunner(SdkRunnerConfig(
        cwd=tmp_path,
        system_prompt="test",
        allowed_tools=[],
        log=MessageLog(tmp_path / "main.jsonl"),
        on_session_id=committed.append,
    ))
    assert committed == []
    harness = MagicMock()

    def run(_content, *, session_id, on_notification):
        on_notification(SimpleNamespace(
            method="session.event",
            payload={
                "sessionId": session_id,
                "event": {"type": "agent/inbox/spliced", "seq": 0, "data": {"inserted": []}},
            },
        ))
        return SimpleNamespace(events=[])

    harness.run.side_effect = run
    with patch.dict("sys.modules", {"deepseek_harness": _dsh_module(harness)}):
        parts = asyncio.run(runner.send_with_user_echo("accepted"))

    assert committed == [runner.session_id]
    assert parts[0]["text"] == "accepted"
    assert read_jsonl(runner.config.log.path)[0]["text"] == "accepted"


def test_runner_reopens_same_session_in_a_fresh_runtime_each_turn(tmp_path) -> None:
    runner = _make_runner(tmp_path)
    harness = MagicMock()
    harness.run.return_value = SimpleNamespace(events=[])

    with patch.dict("sys.modules", {"deepseek_harness": _dsh_module(harness)}):
        asyncio.run(runner.send("hello"))
        asyncio.run(runner.send("again"))

    assert harness.run.call_count == 2
    assert harness.close.call_count == 2
    assert runner._harness is None
    assert runner.session_id is not None
    modes = [
        call.args[1]["mode"]
        for call in harness.client.request.call_args_list
        if call.args[0] == "session/open"
    ]
    assert modes == ["create", "resume"]


def test_runner_streams_notifications_before_turn_completion_without_duplicates(tmp_path) -> None:
    emitted = []
    runner = SdkRunner(SdkRunnerConfig(
        cwd=tmp_path,
        system_prompt="test",
        allowed_tools=[],
        log=MessageLog(tmp_path / "main.jsonl"),
        on_part=emitted.append,
    ))
    harness = MagicMock()
    assistant_event = {
        "type": "assistant/message",
        "seq": 1,
        "data": {"message": {"content": [{"type": "text", "text": "正在处理"}]}},
    }
    tool_event = {
        "type": "tool/call",
        "seq": 2,
        "data": {
            "callId": "call_1",
            "name": "mcp__ts_harness__scan_references",
            "arguments": '{"intend":"扫描参考文献"}',
        },
    }
    tool_result_event = {
        "type": "tool/result",
        "seq": 3,
        "data": {
            "message": {
                "source": {"kind": "tool", "callId": "call_1"},
                "content": [{
                    "type": "tool-result",
                    "toolCallId": "call_1",
                    "content": [{"type": "text", "text": "扫描完成"}],
                    "isError": False,
                }],
            },
        },
    }

    def run(_content, *, session_id, on_notification):
        on_notification(SimpleNamespace(
            method="session.event",
            payload={"sessionId": session_id, "event": assistant_event},
        ))
        on_notification(SimpleNamespace(
            method="session.event",
            payload={"sessionId": session_id, "event": tool_event},
        ))
        on_notification(SimpleNamespace(
            method="session.event",
            payload={"sessionId": session_id, "event": tool_result_event},
        ))
        return SimpleNamespace(events=[assistant_event, tool_event, tool_result_event])

    harness.run.side_effect = run

    with patch.dict("sys.modules", {"deepseek_harness": _dsh_module(harness)}):
        parts = asyncio.run(runner.send("hello"))

    assert [part["type"] for part in parts] == ["text", "tool_call"]
    assert parts[1]["intend"] == "扫描参考文献"
    assert parts[1]["status"] == "completed"
    assert [part["type"] for part in emitted] == ["text", "tool_call", "tool_call"]
    assert emitted[1]["status"] == "pending"
    assert emitted[2]["id"] == emitted[1]["id"]
    assert emitted[2]["status"] == "completed"
    persisted = read_jsonl(runner.config.log.path)
    assert [part["type"] for part in persisted] == ["text", "tool_call"]
    assert persisted[1]["resultText"] == "扫描完成"
    assert harness.run.call_args.kwargs["on_notification"]
