from __future__ import annotations

from harnessing_ts.agent.translate import (
    collapse_tool_parts,
    dsh_event_to_parts,
    filter_display_parts,
    project_dsh_tool_events,
    sdk_message_to_part,
)
from harnessing_ts.state.jsonl import read_jsonl
from harnessing_ts.state.message_log import MessageLog


def _assistant_tool_message() -> dict:
    return {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_1",
                    "name": "Read",
                    "input": {"file_path": "README.md", "intend": "读取 README 以确认项目说明。"},
                }
            ]
        },
    }


def _assistant_builtin_read_message_without_intend() -> dict:
    return {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_read",
                    "name": "Read",
                    "input": {"file_path": "/tmp/workspace/user/problem-contract.md"},
                }
            ]
        },
    }


def _assistant_builtin_bash_message_with_description() -> dict:
    return {
        "type": "assistant",
        "message": {
            "content": [
                {
                    "type": "tool_use",
                    "id": "toolu_bash",
                    "name": "Bash",
                    "input": {
                        "command": "uv run python explore.py",
                        "description": "运行数据探索脚本以生成 contract 证据。",
                    },
                }
            ]
        },
    }


def _user_tool_result_message() -> dict:
    return {
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": [{"type": "text", "text": "# HarnessingTS"}],
                }
            ]
        },
        "tool_use_result": {"content": "# HarnessingTS"},
    }


def _user_tool_result_with_reasoning_jsonl() -> dict:
    return {
        "type": "user",
        "message": {
            "content": [
                {
                    "type": "tool_result",
                    "tool_use_id": "toolu_1",
                    "content": "\n".join([
                        "before",
                        '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private","signature":"sig"}]}}',
                        '{"type":"system","subtype":"thinking_tokens","estimated_tokens":42}',
                        '{"type":"assistant","message":{"content":[{"type":"text","text":"visible jsonl text"}]}}',
                        "after",
                    ]),
                }
            ]
        },
    }


def _dsh_tool_call(*, name: str = "mcp__ts_harness__scan_references", arguments: str | None = None) -> dict:
    return {
        "type": "tool/call",
        "seq": 101,
        "data": {
            "callId": "call_dsh_1",
            "name": name,
            "arguments": arguments or '{"intend":"扫描参考文献以发现新增资料","include_processed":true}',
        },
    }


def _dsh_tool_result(*, failed: bool = False) -> dict:
    return {
        "type": "tool/result",
        "seq": 102,
        "data": {
            "message": {
                "source": {"kind": "tool", "callId": "call_dsh_1"},
                "content": [{
                    "type": "tool-result",
                    "toolCallId": "call_dsh_1",
                    "content": [{"type": "text", "text": "扫描完成" if not failed else "权限不足"}],
                    "isError": failed,
                }],
            },
        },
    }


def test_tool_use_and_result_collapse_to_one_tool_call_part() -> None:
    tool_call = sdk_message_to_part(_assistant_tool_message())
    tool_result = sdk_message_to_part(_user_tool_result_message())

    collapsed = collapse_tool_parts([tool_call, tool_result])

    assert len(collapsed) == 1
    assert collapsed[0]["type"] == "tool_call"
    assert collapsed[0]["status"] == "completed"
    assert collapsed[0]["intend"] == "读取 README 以确认项目说明。"
    assert collapsed[0]["resultText"] == "# HarnessingTS"


def test_tool_result_strips_reasoning_only_jsonl_lines() -> None:
    tool_call = sdk_message_to_part(_assistant_tool_message())
    tool_result = sdk_message_to_part(_user_tool_result_with_reasoning_jsonl())

    collapsed = collapse_tool_parts([tool_call, tool_result])

    result = collapsed[0]["resultText"]
    assert "before" in result
    assert "after" in result
    assert "visible jsonl text" in result
    assert "private" not in result
    assert "thinking_tokens" not in result


def test_display_filter_sanitizes_legacy_merged_tool_call_result_text() -> None:
    legacy_tool_call = {
        "role": "assistant",
        "type": "tool_call",
        "name": "Bash",
        "text": "inspect subagent logs",
        "resultText": "\n".join([
            "before",
            '{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"private","signature":"sig"}]}}',
            "after",
        ]),
    }

    parts = filter_display_parts([legacy_tool_call])

    assert parts[0]["resultText"] == "before\nafter"


def test_builtin_tool_call_without_intend_gets_useful_inferred_title() -> None:
    part = sdk_message_to_part(_assistant_builtin_read_message_without_intend())

    assert part["type"] == "tool_call"
    assert part["intend"] == "读取 problem-contract.md。"
    assert part["input"]["file_path"].endswith("problem-contract.md")


def test_builtin_tool_call_prefers_description_as_intend() -> None:
    part = sdk_message_to_part(_assistant_builtin_bash_message_with_description())

    assert part["type"] == "tool_call"
    assert part["intend"] == "运行数据探索脚本以生成 contract 证据。"
    assert part["input"]["command"] == "uv run python explore.py"


def test_message_log_merges_tool_result_into_prior_tool_call(tmp_path) -> None:
    log = MessageLog(tmp_path / "main.jsonl")
    log.append(sdk_message_to_part(_assistant_tool_message()))
    log.append(sdk_message_to_part(_user_tool_result_message()))

    parts = read_jsonl(log.path)

    assert len(parts) == 1
    assert parts[0]["type"] == "tool_call"
    assert parts[0]["status"] == "completed"
    assert parts[0]["resultText"] == "# HarnessingTS"


def test_dsh_tool_events_become_intent_bearing_correlated_tool_card() -> None:
    tool_call = dsh_event_to_parts(_dsh_tool_call())[0]
    tool_result = dsh_event_to_parts(_dsh_tool_result())[0]

    collapsed = collapse_tool_parts([tool_call, tool_result])

    assert len(collapsed) == 1
    assert collapsed[0]["type"] == "tool_call"
    assert collapsed[0]["name"] == "mcp__ts_harness__scan_references"
    assert collapsed[0]["intend"] == "扫描参考文献以发现新增资料"
    assert collapsed[0]["toolUseId"] == "call_dsh_1"
    assert collapsed[0]["status"] == "completed"
    assert collapsed[0]["resultText"] == "扫描完成"


def test_dsh_native_tool_uses_description_as_intend() -> None:
    tool_call = dsh_event_to_parts(_dsh_tool_call(
        name="bash",
        arguments='{"command":"ls -la","description":"列出工作区文件以了解现状"}',
    ))[0]

    assert tool_call["intend"] == "列出工作区文件以了解现状"
    assert tool_call["input"]["command"] == "ls -la"


def test_dsh_tool_failure_is_merged_into_the_original_card() -> None:
    collapsed = collapse_tool_parts([
        dsh_event_to_parts(_dsh_tool_call())[0],
        dsh_event_to_parts(_dsh_tool_result(failed=True))[0],
    ])

    assert collapsed[0]["status"] == "failed"
    assert collapsed[0]["resultText"] == "权限不足"


def test_legacy_raw_dsh_events_are_projected_without_rewriting_audit_log() -> None:
    raw_parts = [
        {"id": "raw-call", "timestamp": "2026-01-01T00:00:00Z", "role": "system", "type": "raw", "text": "tool/call", "raw": _dsh_tool_call()},
        {"id": "raw-result", "timestamp": "2026-01-01T00:00:01Z", "role": "system", "type": "raw", "text": "tool/result", "raw": _dsh_tool_result()},
    ]

    displayed = filter_display_parts(collapse_tool_parts(project_dsh_tool_events(raw_parts)))

    assert len(displayed) == 1
    assert displayed[0]["id"] == "raw-call"
    assert displayed[0]["type"] == "tool_call"
    assert displayed[0]["status"] == "completed"
    assert displayed[0]["resultText"] == "扫描完成"


def test_display_filter_hides_sdk_token_telemetry() -> None:
    useful_retry = {
        "role": "system",
        "type": "raw",
        "text": "api_retry",
        "raw": {"subtype": "api_retry", "attempt": 1, "max_retries": 3},
    }
    visible_text = {"role": "assistant", "type": "text", "text": "Builder trace output"}

    parts = filter_display_parts([
        {"role": "system", "type": "raw", "text": "thinking_tokens", "raw": {"subtype": "thinking_tokens"}},
        {"role": "system", "type": "raw", "text": "cache_creation_input_tokens", "raw": {"subtype": "cache_creation_input_tokens"}},
        {"role": "system", "type": "raw", "text": "init", "raw": {"subtype": "init"}},
        {
            "role": "assistant",
            "type": "text",
            "text": "",
            "raw": {
                "content": [{
                    "thinking": "private reasoning that must not be displayed",
                    "signature": "sig",
                }],
            },
        },
        useful_retry,
        visible_text,
        {"role": "system", "type": "result", "text": "success", "raw": {"is_error": False}},
    ])

    assert len(parts) == 2
    assert parts[0]["type"] == "raw"
    assert parts[0]["text"] == "api_retry"
    assert "raw" not in parts[0]
    assert parts[1] == visible_text


def test_display_filter_drops_audit_payload_and_bounds_large_tool_output() -> None:
    parts = filter_display_parts([{
        "id": "tool-1",
        "role": "assistant",
        "type": "tool_call",
        "name": "bash",
        "input": {"command": "x" * 5000},
        "intend": "检查工作区",
        "resultText": "y" * 7000,
        "raw": {"secret": "must remain audit-only"},
        "resultRaw": {"large": "must remain audit-only"},
    }])

    assert "raw" not in parts[0]
    assert "resultRaw" not in parts[0]
    assert parts[0]["input"]["truncated"] is True
    assert "已截断" in parts[0]["resultText"]
