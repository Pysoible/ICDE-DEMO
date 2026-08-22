from __future__ import annotations

from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAIN_TS = ROOT / "frontend" / "src" / "main.ts"


def test_frontend_uses_sse_without_snapshot_polling() -> None:
    source = MAIN_TS.read_text()

    assert "new EventSource('/api/events')" in source
    assert "fetchJson<Bootstrap>('/api/live')" not in source
    assert "fetchJson<Bootstrap>('/api/bootstrap')" not in source
    assert "setInterval(" not in source
    assert "livePoll" not in source


def test_chat_uses_keyed_incremental_dom_reconciliation() -> None:
    source = MAIN_TS.read_text()

    assert "data-message-key" in source
    assert "messageFingerprint" in source
    assert "function createMessageElement" in source
    assert "function renderStable" in source
    assert "els.chatStream.innerHTML = renderedParts.map" not in source


def test_knowledge_graph_sse_snapshot_updates_all_live_panels() -> None:
    source = MAIN_TS.read_text()

    assert "eventType === 'knowledge_graph_snapshot'" in source
    assert "state.bootstrap.knowledgeGraph = payload.knowledgeGraph" in source
    assert "state.bootstrap.knowledgeBaseSummary = payload.knowledgeBaseSummary" in source
    assert "state.bootstrap.knowledgeGraphBuild = payload.knowledgeGraphBuild" in source


def test_frontend_merges_incremental_transcript_parts() -> None:
    source = MAIN_TS.read_text()

    assert "function appendRealtimePart" in source
    assert "payload.mainPart" in source
    assert "payload.knowledgeGraphPart" in source
    assert "payload.chainSummaryPart" in source
    assert "payload.nodePartById" in source


def test_pause_waits_for_durable_execution_state_and_exposes_force_stop() -> None:
    source = MAIN_TS.read_text()

    assert "'/api/execution/pause'" in source
    assert "['paused', 'failed'].includes(data.execution?.phase || '')" in source
    assert "data.execution?.phase === 'paused', 300000" not in source
    assert "'/api/execution/force-stop'" in source
    assert "state.loadingMessage = null" in source
    assert "alreadyPaused" in (ROOT / "backend" / "harnessing_ts" / "orchestrator.py").read_text()


def test_frontend_clears_busy_when_pipeline_completes_from_node_parts() -> None:
    source = MAIN_TS.read_text()

    assert "syncRuntimeBusy(state.bootstrap)" in source
    assert "resolveRealtimeWaiters(state.bootstrap)" in source
    assert "function isPipelineComplete" in source
    assert "running: false, pipelineComplete: true" in source
    assert "completedNodes.includes('final-summary')" in source
    assert "return isBackendRunning(data) ? unresolved : []" in source


def test_frontend_suppresses_reasoning_only_assistant_parts() -> None:
    source = MAIN_TS.read_text()

    assert "function isReasoningOnlyPart" in source
    assert "item.thinking || item.signature || item.redacted_thinking" in source
    assert "isReasoningOnlyPart(part)" in source


def test_frontend_renders_semantic_tool_cards_and_suppresses_raw_protocol_parts() -> None:
    source = MAIN_TS.read_text()

    assert "function isDisplayableSessionPart" in source
    assert "part.type === 'tool_call' || part.type === 'tool_result'" in source
    assert "part.type === 'tool_use'" in source
    assert "part.role === 'system' && part.type === 'raw'" in source
    assert "function dshToolResultFailureText" in source
    assert "displaySafeSessionParts(log)" in source
    assert "part.status === 'failed'" in source
