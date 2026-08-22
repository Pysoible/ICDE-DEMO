from __future__ import annotations

"""MCP bridge for DeepSeek Harness.

DSH starts this module over stdio through its official MCP client
plugin.  In the web server, stateful calls carry a capability back to the
live server-owned orchestrator; direct CLI invocation keeps a local fallback.
"""

import asyncio
import inspect
import json
import os
from pathlib import Path
import sys
from typing import Any, Callable
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

from harnessing_ts.schema import NODE_TYPES


def text_result(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False)


def _require_intend(schema: dict[str, Any]) -> dict[str, Any]:
    properties = dict(schema.get("properties") or {})
    properties["intend"] = {
        "type": "string",
        "description": "One short sentence describing why this tool is being called now.",
    }
    required = list(schema.get("required") or [])
    if "intend" not in required:
        required.append("intend")
    out = dict(schema)
    out["properties"] = properties
    out["required"] = required
    return out


def _without_intend(args: dict[str, Any]) -> dict[str, Any]:
    return {key: value for key, value in args.items() if key != "intend"}


def _workspace_path() -> Path:
    value = os.getenv("TS_HARNESS_WORKSPACE")
    if not value:
        raise RuntimeError("TS_HARNESS_WORKSPACE is required for the DeepSeek Harness MCP bridge.")
    return Path(value).resolve()


def _orchestrator() -> Any:
    """Compatibility fallback for direct CLI MCP use without the web server."""
    from harnessing_ts.orchestrator import HarnessOrchestrator

    orchestrator = HarnessOrchestrator(
        _workspace_path(),
        mode=os.getenv("TS_HARNESS_CONTROL_MODE") or None,
        dry_run=os.getenv("TS_HARNESS_DRY_RUN", "").strip().lower() in {"1", "true", "yes"},
    )
    orchestrator.initialize()
    return orchestrator


def _control_url() -> str | None:
    value = os.getenv("DSH_MCP_CONTROL_URL", "").strip()
    return value.rstrip("/") if value else None


def _control_capability() -> str | None:
    value = os.getenv("DSH_MCP_CAPABILITY", "").strip()
    return value or None


async def _call_control(tool: str, args: dict[str, Any]) -> Any:
    """Call the live server-owned orchestrator when DSH runs under the UI.

    Direct CLI MCP invocation still has no parent service to call, so it keeps
    the legacy local facade as a deliberately isolated compatibility path.
    """
    control_url = _control_url()
    capability = _control_capability()
    if not control_url or not capability:
        return await _call_local_control(tool, args)
    payload = {
        "workspace": str(_workspace_path()),
        "role": _role(),
        "nodeSessionId": os.getenv("TS_HARNESS_DSH_NODE_SESSION_ID") or None,
        "tool": tool,
        "args": args,
    }
    return await asyncio.to_thread(_post_control, control_url, capability, payload)


def _post_control(control_url: str, capability: str, payload: dict[str, Any]) -> Any:
    request = Request(
        f"{control_url}/internal/dsh/mcp",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "X-TS-Harness-Capability": capability,
        },
        method="POST",
    )
    try:
        with urlopen(request, timeout=305) as response:  # nosec B310: loopback URL is capability-gated
            return json.loads(response.read().decode("utf-8"))
    except HTTPError as exc:
        body = exc.read().decode("utf-8", errors="replace")
        try:
            detail = json.loads(body).get("detail") or body
        except json.JSONDecodeError:
            detail = body
        raise RuntimeError(f"HarnessingTS control request failed ({exc.code}): {detail}") from None
    except URLError as exc:
        raise RuntimeError(f"HarnessingTS control endpoint is unavailable: {exc.reason}") from None


async def _call_local_control(tool: str, args: dict[str, Any]) -> Any:
    orchestrator = _orchestrator()
    if tool == "enter_node":
        return await orchestrator.request_enter_node(args)
    if tool == "query_knowledge":
        return await orchestrator.request_query_knowledge(args)
    if tool == "extract_reference_features":
        return orchestrator.request_extract_reference_features(args)
    if tool == "inspect_reference_feature_extractor":
        return orchestrator.request_inspect_reference_feature_extractor(args)
    if tool == "validate_reference_feature_extractor":
        return await orchestrator.request_validate_reference_feature_extractor(args)
    if tool == "finish_node":
        return await orchestrator.request_finish_node_for_node(args, _node_id())
    if tool in {"record_artifact", "record_run"}:
        node = orchestrator.store.read_node_session(_node_id())
        if not node:
            raise RuntimeError("Unknown active node session.")
        if tool == "record_artifact":
            return orchestrator.record_artifact_for_node(args, _node_id(), node["nodeType"])
        return orchestrator.record_run_for_node(args, _node_id(), node["nodeType"])
    if tool == "get_runtime_settings":
        return orchestrator.get_runtime_settings()
    raise RuntimeError(f"Unknown HarnessingTS MCP tool: {tool}")


def _allowed(tool_name: str) -> bool:
    raw = os.getenv("TS_HARNESS_DSH_ALLOWED_TOOLS", "")
    allowed = {item for item in raw.split(",") if item}
    return f"mcp__ts_harness__{tool_name}" in allowed


def _role() -> str:
    return os.getenv("TS_HARNESS_DSH_SESSION_ROLE", "main")


def _node_id() -> str:
    value = os.getenv("TS_HARNESS_DSH_NODE_SESSION_ID", "")
    if not value:
        raise RuntimeError("Node MCP bridge calls require TS_HARNESS_DSH_NODE_SESSION_ID.")
    return value


def create_dsh_mcp_server() -> Any:
    try:
        from mcp.server.fastmcp import FastMCP
    except Exception as exc:
        raise RuntimeError(
            "The 'mcp' package is required for the DeepSeek Harness MCP bridge "
            f"(interpreter: {sys.executable})."
        ) from exc

    server = FastMCP("ts_harness")
    role = _role()

    if role == "knowledge_builder":
        _register_knowledge_base_tools(server)
        return server

    if role == "main" and _allowed("enter_node"):
        @server.tool(name="enter_node", description="Request entry into a time-series harness node.")
        async def enter_node(nodeType: str, rationale: str, intend: str, inputSummary: str | None = None, retryFailedNode: bool | None = None) -> str:
            if nodeType not in NODE_TYPES:
                raise ValueError(f"Unknown node type: {nodeType}")
            return text_result(await _call_control("enter_node", _without_intend({
                "nodeType": nodeType, "rationale": rationale, "inputSummary": inputSummary, "retryFailedNode": retryFailedNode, "intend": intend,
            })))

    if role in {"main", "node"} and _allowed("query_knowledge"):
        @server.tool(name="query_knowledge", description="Ask the configured independent knowledge reasoning agent a domain question.")
        async def query_knowledge(question: str, intend: str, domain: str | None = None, context: dict[str, Any] | None = None, observations: list[str] | None = None, includeEvidence: bool = False) -> str:
            return text_result(await _call_control("query_knowledge", _without_intend({
                "question": question, "domain": domain, "context": context, "observations": observations, "includeEvidence": includeEvidence, "intend": intend,
            })))

    if role in {"main", "node"} and _allowed("extract_reference_features"):
        @server.tool(name="extract_reference_features", description="Run the validated deterministic reference feature extractor.")
        async def extract_reference_features(input: Any, intend: str) -> str:
            return text_result(await _call_control("extract_reference_features", {"input": input}))

    if role in {"main", "node"} and _allowed("inspect_reference_feature_extractor"):
        @server.tool(name="inspect_reference_feature_extractor", description="Inspect the generated deterministic reference feature extractor.")
        async def inspect_reference_feature_extractor(intend: str) -> str:
            return text_result(await _call_control("inspect_reference_feature_extractor", {}))

    if role in {"main", "node"} and _allowed("validate_reference_feature_extractor"):
        @server.tool(name="validate_reference_feature_extractor", description="Validate the generated deterministic reference feature extractor.")
        async def validate_reference_feature_extractor(intend: str, runTests: bool = True) -> str:
            return text_result(await _call_control("validate_reference_feature_extractor", {"runTests": runTests}))

    if role == "node" and _allowed("finish_node"):
        @server.tool(name="finish_node", description="Request completion of the active harness node.")
        async def finish_node(success: bool, summary: str, intend: str, goalMet: bool | None = None, nextNode: str | None = None, loopDecision: str | None = None, outputPaths: list[str] | None = None) -> str:
            return text_result(await _call_control("finish_node", _without_intend({
                "success": success, "summary": summary, "goalMet": goalMet, "nextNode": nextNode,
                "loopDecision": loopDecision, "outputPaths": outputPaths or [], "intend": intend,
            })))

    if role == "node" and _allowed("record_artifact"):
        @server.tool(name="record_artifact", description="Record a produced artifact path in the harness timeline.")
        async def record_artifact(path: str, intend: str, summary: str | None = None) -> str:
            return text_result(await _call_control("record_artifact", {"path": path, "summary": summary or ""}))

    if role == "node" and _allowed("record_run"):
        @server.tool(name="record_run", description="Record a tool-guided solving run.")
        async def record_run(runId: str, status: str, startedAt: str, artifactPaths: list[str], intend: str, finishedAt: str | None = None, summary: str | None = None, metrics: dict[str, Any] | None = None) -> str:
            return text_result(await _call_control("record_run", {
                "runId": runId, "status": status, "startedAt": startedAt, "artifactPaths": artifactPaths,
                "finishedAt": finishedAt, "summary": summary or "", "metrics": metrics or {},
            }))

    if role == "node" and _allowed("get_runtime_settings"):
        @server.tool(name="get_runtime_settings", description="Read live HarnessingTS runtime parameters.")
        async def get_runtime_settings(intend: str) -> str:
            return text_result(await _call_control("get_runtime_settings", {}))

    return server


def _register_knowledge_base_tools(server: Any) -> None:
    from harnessing_ts.knowledge_graph import build_knowledge_base_tool_callbacks

    callbacks = build_knowledge_base_tool_callbacks(_workspace_path())

    def callback(name: str, args: dict[str, Any]) -> str:
        value = callbacks[name](_without_intend(args))
        if inspect.isawaitable(value):
            raise RuntimeError(f"Knowledge-base callback {name} must be synchronous in the stdio bridge.")
        return text_result(value)

    @server.tool(name="scan_references")
    async def scan_references(intend: str, include_processed: bool = False) -> str:
        return callback("scan_references", locals())

    @server.tool(name="extract_reference_text")
    async def extract_reference_text(intend: str, reference_id: str | None = None, path: str | None = None, pages: str | None = None, max_chars_per_page: int | None = None) -> str:
        return callback("extract_reference_text", locals())

    @server.tool(name="update_reference_brief")
    async def update_reference_brief(reference_id: str, brief: str, intend: str, title: str | None = None) -> str:
        return callback("update_reference_brief", locals())

    @server.tool(name="add_evidence")
    async def add_evidence(reference_file: str, quoted_fragments: list[str], intend: str, page: str | None = None, section: str | None = None, notes: str | None = None) -> str:
        return callback("add_evidence", locals())

    @server.tool(name="add_knowledge")
    async def add_knowledge(topic: str, description: str, evidence_ids: list[str], intend: str, summary: str | None = None, notes: str | None = None) -> str:
        return callback("add_knowledge", locals())

    @server.tool(name="list_pending_knowledge")
    async def list_pending_knowledge(intend: str, limit: int = 10) -> str:
        return callback("list_pending_knowledge", locals())

    @server.tool(name="get_knowledge")
    async def get_knowledge(knowledge_id: str, intend: str, detail: str = "compact") -> str:
        return callback("get_knowledge", locals())

    @server.tool(name="search_classes")
    async def search_classes(query: str, intend: str, top_k: int = 10) -> str:
        return callback("search_classes", locals())

    @server.tool(name="upsert_class")
    async def upsert_class(label: str, concept_level: int, concept_type: str, description_addition: str, source_knowledge_ids: list[str], intend: str, aliases: list[str] | None = None, evidence_ids: list[str] | None = None) -> str:
        return callback("upsert_class", locals())

    @server.tool(name="search_relations")
    async def search_relations(intend: str, source_class_id: str | None = None, target_class_id: str | None = None, relation_type: str | None = None) -> str:
        return callback("search_relations", locals())

    @server.tool(name="upsert_relation")
    async def upsert_relation(source_class_id: str, relation_type: str, target_class_id: str, description_addition: str, source_knowledge_ids: list[str], intend: str, relation_depth: int | None = None, evidence_ids: list[str] | None = None) -> str:
        return callback("upsert_relation", locals())

    @server.tool(name="validate_knowledge_base")
    async def validate_knowledge_base(intend: str) -> str:
        return callback("validate_knowledge_base", locals())

    @server.tool(name="finalize_knowledge_base")
    async def finalize_knowledge_base(intend: str) -> str:
        return callback("finalize_knowledge_base", locals())


def main() -> None:
    create_dsh_mcp_server().run(transport="stdio")


if __name__ == "__main__":
    main()
