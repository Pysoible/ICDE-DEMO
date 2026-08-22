from __future__ import annotations

import asyncio

from harnessing_ts.orchestrator import HarnessOrchestrator
from harnessing_ts.state.workspace_store import WorkspaceStore


class _BackgroundFinishRunner:
    def __init__(self, orchestrator: HarnessOrchestrator) -> None:
        self.orchestrator = orchestrator
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self._running = False
        self.closed = False

    @property
    def is_running(self) -> bool:
        return self._running

    async def send_with_user_echo(self, _text: str, context_text: str | None = None) -> list[dict]:
        self._running = True
        self.started.set()
        await self.release.wait()
        active = self.orchestrator.active_node_session
        assert active is not None
        workspace = self.orchestrator.workspace_path
        (workspace / "user").mkdir(parents=True, exist_ok=True)
        (workspace / "user" / "problem-contract.md").write_text("contract", encoding="utf-8")
        (workspace / "user" / "data-spec.md").write_text("spec", encoding="utf-8")
        await self.orchestrator.finish_node({
            "success": True,
            "summary": "completed by fake runner",
            "goalMet": False,
            "nextNode": "none",
            "outputPaths": ["user/problem-contract.md", "user/data-spec.md"],
        })
        self._running = False
        return []

    async def interrupt(self) -> None:
        self._running = False
        self.release.set()

    async def close(self) -> None:
        self.closed = True
        self._running = False


def test_enter_node_returns_immediately_and_duplicate_request_is_idempotent(tmp_path) -> None:
    async def scenario() -> None:
        orchestrator = HarnessOrchestrator(tmp_path, mode="auto")
        orchestrator.initialize()
        runner = _BackgroundFinishRunner(orchestrator)
        orchestrator._spawn_node_runner = lambda node: setattr(orchestrator, "active_node_runner", runner)  # type: ignore[assignment]
        args = {"nodeType": "problem-contract", "rationale": "start", "inputSummary": "task"}

        started = await orchestrator.request_enter_node(args)
        assert started["status"] == "started"
        await asyncio.wait_for(runner.started.wait(), timeout=1)
        assert orchestrator.is_active_node_task_running()

        duplicate = await orchestrator.request_enter_node(args)
        assert duplicate["status"] == "already_started"
        assert duplicate["nodeSessionId"] == started["nodeSessionId"]
        assert len(orchestrator.store.list_node_sessions()) == 1

        runner.release.set()
        for _ in range(20):
            if not orchestrator.is_active_node_task_running():
                break
            await asyncio.sleep(0.01)
        assert not orchestrator.is_active_node_task_running()
        assert orchestrator.get_state()["activeNode"] is None
        assert orchestrator.store.read_node_session(started["nodeSessionId"])["status"] == "completed"

    asyncio.run(scenario())


def test_server_restart_fences_running_execution_and_preserves_dsh_identity(tmp_path) -> None:
    store = WorkspaceStore(tmp_path)
    state = store.initialize(mode="auto")
    node = store.create_node_session("knowledge-to-tools")
    node.update({"status": "running", "sdkSessionId": "dsh-session-1"})
    store.write_node_session(node)
    state["activeNode"] = node["nodeType"]
    state["activeNodeSessionId"] = node["id"]
    store.write_state(state)

    first = HarnessOrchestrator(tmp_path, mode="auto")
    first.initialize()
    asyncio.run(first.execution.begin(f"node:{node['id']}", "dsh-session-1"))

    restarted = HarnessOrchestrator(tmp_path, mode="auto")
    restarted.initialize()
    assert restarted.recover_interrupted_execution() is True
    recovered = restarted.store.read_node_session(node["id"])
    assert recovered["status"] == "paused"
    assert recovered["sdkSessionId"] == "dsh-session-1"
    assert restarted.execution.snapshot()["sessionId"] == "dsh-session-1"
    assert restarted.execution.snapshot()["phase"] == "recovering"

    class RecoveryRunner:
        session_id = "dsh-session-1"
        checkpoint_seq = 11

        def adopt_recovery_session(self, session_id: str) -> None:
            self.session_id = session_id

        async def recover(self) -> None:
            return None

    restarted._spawn_node_runner = lambda _node: setattr(restarted, "active_node_runner", RecoveryRunner())  # type: ignore[method-assign]
    asyncio.run(restarted.complete_interrupted_recovery())
    assert restarted.execution.snapshot()["phase"] == "paused"
    assert restarted.execution.snapshot()["checkpointSeq"] == 11


def test_workflow_reset_preserves_assets_and_initial_user_message(tmp_path) -> None:
    store = WorkspaceStore(tmp_path)
    store.initialize(mode="auto")
    (tmp_path / "data" / "raw" / "dataset.csv").write_text("raw", encoding="utf-8")
    (tmp_path / "references" / "paper.txt").write_text("reference", encoding="utf-8")
    (tmp_path / "knowledge_base" / "tables" / "knowledge.csv").write_text("id\nK1\n", encoding="utf-8")
    (tmp_path / "artifacts" / "knowledge-graph.json").write_text("{}", encoding="utf-8")
    store.append_main_part({"id": "initial", "timestamp": "2026-01-01T00:00:00Z", "role": "user", "type": "text", "text": "initial task"})
    store.append_main_part({"id": "later", "timestamp": "2026-01-01T00:01:00Z", "role": "assistant", "type": "text", "text": "later output"})
    (tmp_path / "data" / "processed" / "derived.csv").write_text("derived", encoding="utf-8")
    (tmp_path / ".dsh-sessions").mkdir(exist_ok=True)
    (tmp_path / ".dsh-sessions" / "old.jsonl").write_text("old", encoding="utf-8")

    state = store.reset_workflow_preserving_assets()

    assert state["activeNode"] is None
    assert state["completedNodes"] == []
    assert (tmp_path / "data" / "raw" / "dataset.csv").exists()
    assert (tmp_path / "references" / "paper.txt").exists()
    assert (tmp_path / "knowledge_base" / "tables" / "knowledge.csv").exists()
    assert (tmp_path / "artifacts" / "knowledge-graph.json").exists()
    assert not (tmp_path / "data" / "processed" / "derived.csv").exists()
    assert not (tmp_path / ".dsh-sessions").exists()
    assert [part["text"] for part in store.read_main_parts(limit=None)] == ["initial task"]
