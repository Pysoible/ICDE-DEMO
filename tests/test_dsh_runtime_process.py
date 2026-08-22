from __future__ import annotations

from pathlib import Path

from pydantic import BaseModel


class OpenResponse(BaseModel):
    sessionId: str
    source: str
    lastSeq: int


class CheckpointResponse(BaseModel):
    sessionId: str
    checkpointSeq: int


def test_real_dsh_process_creates_then_resumes_same_session(tmp_path) -> None:
    from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig

    repo = Path(__file__).resolve().parents[1]
    runtime = repo / "backend" / "dsh_runtime"
    config = DeepSeekHarnessConfig(
        cwd=str(tmp_path),
        runtime_cwd=str(runtime),
        runtime_bin=str(runtime / "node_modules" / "@deepseek-ai" / "dsh-sdk-jsonrpc-demo" / "lib" / "bin.js"),
        cordis=str(runtime / "session-jsonrpc.test.yml"),
        session_root=str(tmp_path / ".dsh-sessions"),
        shutdown_timeout_seconds=10,
    )

    first = DeepSeekHarness(config)
    first.start()
    opened = first.client.request(
        "session/open", {"sessionId": "process-test", "mode": "create"},
        response_model=OpenResponse,
    )
    first.client.session_prompt("process-test", [{"type": "text", "text": "persist this turn"}])
    checkpoint = first.client.request(
        "session/pause", {"sessionId": "process-test"},
        response_model=CheckpointResponse,
    )
    first.close()

    second = DeepSeekHarness(config)
    second.start()
    resumed = second.client.request(
        "session/open", {"sessionId": "process-test", "mode": "resume"},
        response_model=OpenResponse,
    )
    second.close()

    assert opened.source == "created"
    assert resumed.source == "resumed"
    # Resume may append DSH's crash-repair marker before returning.
    assert resumed.lastSeq >= checkpoint.checkpointSeq


def test_real_dsh_recovery_creates_only_when_reserved_identity_is_absent(tmp_path) -> None:
    from deepseek_harness import DeepSeekHarness, DeepSeekHarnessConfig

    repo = Path(__file__).resolve().parents[1]
    runtime = repo / "backend" / "dsh_runtime"
    harness = DeepSeekHarness(DeepSeekHarnessConfig(
        cwd=str(tmp_path),
        runtime_cwd=str(runtime),
        runtime_bin=str(runtime / "node_modules" / "@deepseek-ai" / "dsh-sdk-jsonrpc-demo" / "lib" / "bin.js"),
        cordis=str(runtime / "session-jsonrpc.test.yml"),
        session_root=str(tmp_path / ".dsh-sessions"),
        shutdown_timeout_seconds=10,
    ))
    harness.start()
    recovered = harness.client.request(
        "session/open", {"sessionId": "reserved-before-crash", "mode": "recover"},
        response_model=OpenResponse,
    )
    checkpoint = harness.client.request(
        "session/checkpoint", {"sessionId": "reserved-before-crash"},
        response_model=CheckpointResponse,
    )
    harness.close()

    assert recovered.source == "created"
    assert checkpoint.checkpointSeq >= -1
