"""Case-centred ICDE interactions over existing signals, tools and saved reports."""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import operator
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from harnessing_ts.ecg_demo import EcgDemoUnavailable, build_ecg_overview, load_ecg_waveform, resolve_ecg_workspace
from harnessing_ts.patient_qa import answer_patient_question
from harnessing_ts.reference_feature_extractor import execute_reference_feature_module
from harnessing_ts.settings.llm import read_effective_llm_config
from harnessing_ts.expert_collaboration import ModelServiceUnavailable, Plan, plan_check, propose, note_diff, measurement_changes
from harnessing_ts.variants.profiles import resolve_variant

LABELS = {"NORM", "MI", "STTC", "CD", "HYP"}
METRICS = {"qrs_duration_ms": ("qrs_ms", "ms"), "pr_interval_ms": (None, "ms"), "pathological_q_wave_count_other_leads": ("count", "leads")}
OPS = {">=": operator.ge, ">": operator.gt, "<=": operator.le, "<": operator.lt}
_LOCK = threading.RLock()
_CACHE: dict[str, dict[str, Any]] = {}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def digest(value: Any) -> str:
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:16]


def read_record(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text()) if path.is_file() else {"revision": 0, "reviews": [], "feedback": []}


def save_review(path: Path, record: dict[str, Any], expected: int) -> dict[str, Any]:
    """Optimistic revision check prevents one role overwriting another role's work."""
    with _LOCK:
        existing = read_record(path)
        if existing["revision"] != expected:
            raise HTTPException(409, "The report changed. Refresh this case before saving.")
        record = dict(record, revision=expected + 1, updatedAt=now())
        existing["revision"] = record["revision"]
        existing["reviews"].append(record)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(existing, ensure_ascii=False, indent=2))
        temp.replace(path)
        return record


def measured(feature: dict[str, Any]) -> float | None:
    key, _ = METRICS[feature["name"]]
    value = feature.get("value")
    if key and isinstance(value, dict):
        value = value.get(key)
    if isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value):
        return float(value)
    return None


def draft_criterion(text: str) -> dict[str, Any]:
    """A deliberately bounded grammar; unsupported prose is never silently executed."""
    normalized = text.strip().replace("≥", ">=").replace("≤", "<=").lower()
    names = {"qrs": "qrs_duration_ms", "pr": "pr_interval_ms", "q wave count": "pathological_q_wave_count_other_leads", "q波数量": "pathological_q_wave_count_other_leads"}
    match = re.match(r"(qrs|pr|q wave count)\s*(>=|<=|>|<)\s*(\d+(?:\.\d+)?)\s*(ms|leads|导联)?", normalized)
    if not match:
        raise HTTPException(422, "Use a supported criterion, for example: QRS >= 120 ms: needs review. Available measurements: QRS, PR and Q wave count.")
    name = names[match[1]]
    unit = METRICS[name][1]
    if match[4] and match[4] != unit:
        raise HTTPException(422, f"Use {unit} for this measurement.")
    remainder = normalized[match.end():].strip(" :,-")
    if remainder not in {"needs review", "need review", "review", "requires review", "需要复核", "需复核", "待复核"}:
        raise HTTPException(422, "The supported action is needs review. Add ': needs review' after the condition.")
    threshold = float(match[3])
    if threshold > 10000:
        raise HTTPException(422, "The threshold is outside the supported preview range.")
    return {"feature": name, "operator": match[2], "threshold": threshold, "unit": unit, "action": "needs_review", "text": text.strip()}


class EvidenceRequest(BaseModel):
    contextId: str
    lead: str | None = Field(default=None, max_length=10)


class ReviewRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    labels: list[Literal["NORM", "MI", "STTC", "CD", "HYP"]] = Field(min_length=1, max_length=5)
    note: str = Field(min_length=10, max_length=3000)
    status: Literal["draft", "published"] = "published"
    featureNames: list[str] = Field(default_factory=list, max_length=10)
    analysisRoundId: str | None = None


class CollaborationRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    message: str = Field(min_length=3, max_length=2000)
    focus: str = Field(default="", max_length=100)
    action: Literal["auto", "review_evidence", "rerun_measurements", "audit_sources"] = "auto"


class DecisionRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    roundId: str
    decision: Literal["accepted", "rejected"]


def collaboration_state(record: dict) -> dict:
    return record.get("collaboration", {"revision": 0, "rounds": []})


def save_collaboration(path: Path, expected: int, *, round_record: dict | None = None,
                       decision: DecisionRequest | None = None, report_revision: int | None = None) -> dict:
    with _LOCK:
        saved = read_record(path)
        if report_revision is not None and saved["revision"] != report_revision:
            raise HTTPException(409, "The report changed during collaboration. Refresh before continuing.")
        collab = collaboration_state(saved)
        if collab["revision"] != expected:
            raise HTTPException(409, "Another collaboration update arrived. Refresh before continuing.")
        if round_record is not None:
            collab["rounds"].append(round_record)
        elif decision is not None:
            latest = collab["rounds"][-1] if collab["rounds"] else None
            if not latest or latest["id"] != decision.roundId or latest["decision"] != "pending":
                raise HTTPException(409, "Only the latest pending suggestion can be accepted or rejected.")
            latest["decision"] = decision.decision
            latest["decidedAt"] = now()
        collab["revision"] += 1
        saved["collaboration"] = collab
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(saved, ensure_ascii=False, indent=2))
        temp.replace(path)
        return collab


class CriterionRequest(BaseModel):
    text: str = Field(min_length=3, max_length=300)
    contextId: str
    caseIds: list[int] = Field(min_length=1, max_length=8)


class QuestionRequest(BaseModel):
    contextId: str
    reportRevision: int = Field(ge=1)
    question: str = Field(min_length=1, max_length=500)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=6)


class FeedbackRequest(BaseModel):
    contextId: str
    reportRevision: int = Field(ge=1)
    text: str = Field(min_length=3, max_length=1000)


def create_demo_router(current_workspace: Path) -> APIRouter:
    router = APIRouter(prefix="/api/demo")

    def context(dataset: str, ecg_id: int) -> tuple[Path, dict[str, Any], Path]:
        try:
            workspace = resolve_ecg_workspace(current_workspace, dataset)
            overview = build_ecg_overview(workspace, status="all", ecg_id=ecg_id, limit=1, dataset_key=dataset)
            if not overview["samples"]:
                raise HTTPException(404, "Case not present in this run.")
            sample = overview["samples"][0]
            source = workspace / "tools/reference-feature-extractor/extractor.py"
            tool_files = [source.parent / name for name in ("extractor.py", "manifest.json", "feature-plan.json", "reference-rules.json", "evidence-map.json")]
            tool_version = digest({f.name: hashlib.sha256(f.read_bytes()).hexdigest() if f.is_file() else None for f in tool_files})[:12] if source.is_file() else "unavailable"
            waveform = load_ecg_waveform(workspace, ecg_id)
            context_id = digest({"dataset": dataset, "iteration": overview["iteration"], "sample": sample, "waveform": waveform, "tool": tool_version})
            path = workspace / "state/icde-demo" / f"{dataset}-{ecg_id}-{context_id}.json"
            saved = read_record(path)
            published = next((r for r in reversed(saved["reviews"]) if r["status"] == "published"), None)
            return workspace, {"dataset": dataset, "sample": sample, "waveform": waveform, "iteration": overview["iteration"], "contextId": context_id, "toolVersion": tool_version, "revision": saved["revision"], "review": saved["reviews"][-1] if saved["reviews"] else None, "publishedReport": published, "feedback": saved["feedback"]}, path
        except EcgDemoUnavailable as exc:
            raise HTTPException(404, str(exc)) from exc

    def evidence(workspace: Path, ctx: dict[str, Any], force: bool = False) -> tuple[dict[str, Any], bool]:
        key = ctx["contextId"]
        if key in _CACHE and not force:
            return _CACHE[key], True
        waveform = ctx["waveform"]
        # The viewer exposes mV; the existing extractor requires 0.001-mV units.
        tool_input = {"ecg_id": ctx["sample"]["ecgId"], "age": ctx["sample"].get("age"), "sex": None, "fs": waveform["sampleRate"], "lead_names": [lead["name"] for lead in waveform["leads"]], "waveform": [[round(v * 1000, 6) for v in lead["values"]] for lead in waveform["leads"]]}
        try:
            result = execute_reference_feature_module(workspace, tool_input)
        except (RuntimeError, OSError, ValueError) as exc:
            raise HTTPException(422, f"Case tool could not execute: {str(exc)[:500]}") from exc
        # Sex-specific voltage interpretation is withheld until metadata convention is verified.
        result["adapterNotes"] = ["Full-record measurements use the recorded 10-second ECG, not a selected fragment.", "Sex-specific interpretation is withheld pending metadata convention verification."]
        if len(_CACHE) >= 128:
            _CACHE.pop(next(iter(_CACHE)))
        _CACHE[key] = result
        return result, False

    def check_context(ctx: dict[str, Any], supplied: str) -> None:
        if ctx["contextId"] != supplied:
            raise HTTPException(409, "The signal, run or tool changed. Reload this case.")

    @router.get("/cases")
    async def cases(dataset: str = "ptbxl") -> dict[str, Any]:
        workspace = resolve_ecg_workspace(current_workspace, dataset)
        overview = await asyncio.to_thread(build_ecg_overview, workspace, status="all", limit=200, dataset_key=dataset)
        samples = overview["samples"][:35]
        for ecg_id in (3919, 62, 1222):
            focused = await asyncio.to_thread(build_ecg_overview, workspace, status="all", ecg_id=ecg_id, limit=1, dataset_key=dataset)
            if focused["samples"] and not any(s["ecgId"] == ecg_id for s in samples):
                samples.insert(0, focused["samples"][0])
        return {"samples": samples, "iteration": overview["iteration"], "sampleCount": overview["sampleCount"]}

    @router.get("/{dataset}/cases/{ecg_id}")
    async def case(dataset: str, ecg_id: int) -> dict[str, Any]:
        _, ctx, _ = await asyncio.to_thread(context, dataset, ecg_id)
        return ctx

    @router.post("/{dataset}/cases/{ecg_id}/evidence")
    async def run_evidence(dataset: str, ecg_id: int, request: EvidenceRequest) -> dict[str, Any]:
        start = time.perf_counter()
        workspace, ctx, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        if request.lead and request.lead not in [l["name"] for l in ctx["waveform"]["leads"]]:
            raise HTTPException(422, "Unknown lead.")
        result, cached = await asyncio.to_thread(evidence, workspace, ctx)
        return {"contextId": ctx["contextId"], "toolVersion": ctx["toolVersion"], "cached": cached, "executedAt": now(), "elapsedMs": round((time.perf_counter()-start)*1000), "focusLead": request.lead, "result": result}

    @router.post("/{dataset}/cases/{ecg_id}/criteria/preview")
    async def preview(dataset: str, ecg_id: int, request: CriterionRequest) -> dict[str, Any]:
        _, ctx, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        criterion = draft_criterion(request.text)
        rows = []
        for sample_id in dict.fromkeys(request.caseIds):
            workspace, item, _ = await asyncio.to_thread(context, dataset, sample_id)
            result, _ = await asyncio.to_thread(evidence, workspace, item)
            feature = next((f for f in result["features"] if f["name"] == criterion["feature"]), None)
            value = measured(feature) if feature else None
            # A non-measurable feature cannot acquire a certain result from a rule edit.
            usable = feature and feature.get("judgment", {}).get("status") not in {"indeterminate", "not_applicable"}
            matched = OPS[criterion["operator"]](value, criterion["threshold"]) if value is not None and usable else None
            rows.append({"ecgId": sample_id, "contextId": item["contextId"], "value": value, "originalStatus": feature.get("judgment", {}).get("status", "unavailable") if feature else "unavailable", "matched": matched, "previewStatus": "needs_review" if matched else "no_new_flag" if matched is False else "measurement_unavailable"})
        return {"criterion": criterion, "previewId": digest({"criterion": criterion, "rows": rows}), "rows": rows, "changesPredictions": False, "applied": False}

    @router.post("/{dataset}/cases/{ecg_id}/review")
    async def review(dataset: str, ecg_id: int, request: ReviewRequest) -> dict[str, Any]:
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        if "NORM" in request.labels and len(set(request.labels)) > 1:
            raise HTTPException(422, "NORM cannot be combined with abnormal review labels.")
        if len(request.note.strip()) < 10:
            raise HTTPException(422, "Add at least 10 characters of supporting notes.")
        features = []
        if request.featureNames:
            result, _ = await asyncio.to_thread(evidence, workspace, ctx)
            known = {f["name"] for f in result["features"]}
            if set(request.featureNames) - known:
                raise HTTPException(422, "The report references an unknown measurement.")
            features = [f for f in result["features"] if f["name"] in request.featureNames]
        if request.analysisRoundId:
            rounds = collaboration_state(read_record(path))["rounds"]
            if not any(r["id"] == request.analysisRoundId and r["decision"] == "accepted" for r in rounds):
                raise HTTPException(409, "Accept the analysis suggestion before linking it to a report draft.")
        record = {"contextId": ctx["contextId"], "dataset": dataset, "ecgId": ecg_id, "iteration": ctx["iteration"], "toolVersion": ctx["toolVersion"], "labels": sorted(set(request.labels)), "note": request.note.strip(), "status": request.status, "features": features, "author": "Demo reviewer", "authority": "demo_review", "analysisRoundId": request.analysisRoundId}
        return await asyncio.to_thread(save_review, path, record, request.expectedRevision)

    @router.get("/{dataset}/cases/{ecg_id}/collaboration")
    async def get_collaboration(dataset: str, ecg_id: int) -> dict:
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        return {"contextId": ctx["contextId"], **collaboration_state(read_record(path))}

    @router.post("/{dataset}/cases/{ecg_id}/collaboration")
    async def collaborate(dataset: str, ecg_id: int, request: CollaborationRequest) -> dict:
        variant = resolve_variant()
        if not (variant.reference_feature_extractor and variant.case_review_reference_features):
            raise HTTPException(403, "Expert evidence collaboration is disabled by the active variant.")
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        previous = collaboration_state(read_record(path))
        if previous["revision"] != request.expectedRevision:
            raise HTTPException(409, "The collaboration changed. Refresh this case.")
        if len(previous["rounds"]) >= 40:
            raise HTTPException(422, "This case has reached the 40-round demo limit. Existing history is retained.")
        result, cached = await asyncio.to_thread(evidence, workspace, ctx)
        names = [f["name"] for f in result["features"]]
        if request.focus and request.focus not in names:
            raise HTTPException(422, "Select a measurement available in this case.")
        history = [{k: r[k] for k in ("message", "response", "draftNote", "decision")} for r in previous["rounds"][-4:]]
        config = read_effective_llm_config(workspace)
        try:
            if request.action == "auto":
                plan = await plan_check(config, request.message, request.focus, names, history[-1] if history else None)
            else:
                plan = Plan(action=request.action, focus=request.focus, reason="Check explicitly requested by the user.")
            checks = [{"name": "Load case evidence", "detail": "Retrieved cached full-record measurements." if cached else "Executed the existing full-record reference feature tool.", "status": "completed"}]
            changes = []
            if plan.action == "rerun_measurements":
                original = result
                result, _ = await asyncio.to_thread(evidence, workspace, ctx, True)
                changes = measurement_changes(original["features"], result["features"])
                checks.append({"name": "Re-execute measurement tool", "detail": f"Cache bypassed. {len(changes)} measurement values changed. Same full-record algorithm; no new segment or beat-boundary capability.", "status": "completed"})
            selected = [f for f in result["features"] if not plan.focus or f["name"] == plan.focus]
            sources = []
            for feature in selected:
                for excerpt in feature.get("evidence", []):
                    ref = excerpt.get("referencePath", "")
                    resolved = (workspace / ref).resolve() if ref else None
                    available = bool(resolved and resolved.is_relative_to(workspace.resolve()) and resolved.is_file())
                    sources.append({"feature": feature["name"], "path": ref, "available": available, "quote": excerpt.get("quote", ""), "section": excerpt.get("section", ""), "page": excerpt.get("page")})
            checks.append({"name": "Inspect attached sources" if plan.action == "audit_sources" else "Inspect measurement rules", "detail": f"Inspected {len(selected)} measurement records and {len(sources)} attached excerpts. {sum(s['available'] for s in sources)} source files available. No new literature search or verbatim quote validation performed.", "status": "completed"})
            checks.append({"name": "Scope boundary", "detail": "No raw-waveform morphology interpretation, segment remeasurement, code update, model retraining or clinical diagnosis.", "status": "limitation"})
            payload = {"ecgId": ecg_id, "modelPredictions": ctx["sample"].get("predicted", []), "datasetLabels": ctx["sample"].get("truth", []), "toolVersion": ctx["toolVersion"], "sources": sources, "currentReview": ctx.get("review")}
            proposal = await propose(config, feedback=request.message, context=payload, result=result, plan=plan, checks=checks, history=history)
        except (HTTPException,):
            raise
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, f"{exc} Your question and existing reports are unchanged.") from exc
        except Exception as exc:
            # Never substitute a canned reflection or leak provider credentials/errors.
            raise HTTPException(503, "The expert analysis service could not return a valid response. Your question and existing reports are unchanged; retry or inspect the evidence directly.") from exc
        _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(fresh, request.contextId)
        if fresh["revision"] != ctx["revision"]:
            raise HTTPException(409, "The report changed during analysis. Refresh before requesting a new revision.")
        before = history[-1]["draftNote"] if history else (ctx.get("review") or {}).get("note", "")
        record = {"id": digest({"case": request.contextId, "time": now(), "message": request.message}),
                  "createdAt": now(), "message": request.message, "focus": plan.focus,
                  "plan": plan.model_dump(), "checks": checks, "sources": sources,
                  **proposal, "beforeNote": before, "diff": note_diff(before, proposal["draftNote"]),
                  "measurementChanges": changes, "features": [f for f in result["features"] if f["name"] in proposal["featureNames"]],
                  "decision": "pending", "source": "llm", "contextId": request.contextId,
                  "baseReportRevision": ctx["revision"], "toolVersion": ctx["toolVersion"]}
        saved = await asyncio.to_thread(save_collaboration, path, request.expectedRevision, round_record=record, report_revision=ctx["revision"])
        return {"contextId": ctx["contextId"], **saved}

    @router.post("/{dataset}/cases/{ecg_id}/collaboration/decision")
    async def collaboration_decision(dataset: str, ecg_id: int, request: DecisionRequest) -> dict:
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        latest = collaboration_state(read_record(path))["rounds"]
        if not latest or latest[-1]["baseReportRevision"] != ctx["revision"]:
            raise HTTPException(409, "The report changed since this suggestion. Request a fresh analysis before deciding.")
        saved = await asyncio.to_thread(save_collaboration, path, request.expectedRevision, decision=request, report_revision=ctx["revision"])
        return {"contextId": ctx["contextId"], **saved}

    @router.post("/{dataset}/cases/{ecg_id}/question")
    async def question(dataset: str, ecg_id: int, request: QuestionRequest) -> dict[str, Any]:
        workspace, ctx, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        report = ctx["publishedReport"]
        if not report or report["revision"] != request.reportRevision:
            raise HTTPException(409, "Choose the current published demo report before asking.")
        try:
            result = await answer_patient_question(question=request.question.strip(), sample=ctx["sample"], history=request.history, llm_config=read_effective_llm_config(workspace), report_context={"revision": report["revision"], "review_labels": report["labels"], "review_note": report["note"], "measurements": report["features"], "authority": "demo review, not independently verified clinical care"})
        except Exception as exc:
            raise HTTPException(503, "The model answer is unavailable. Your published report is still available.") from exc
        return dict(result, reportRevision=report["revision"], contextUsed={"note": report["note"], "features": [f["name"] for f in report["features"]], "labels": report["labels"]})

    @router.post("/{dataset}/cases/{ecg_id}/feedback")
    async def feedback(dataset: str, ecg_id: int, request: FeedbackRequest) -> dict[str, Any]:
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        if not ctx["publishedReport"] or ctx["publishedReport"]["revision"] != request.reportRevision:
            raise HTTPException(409, "The report changed. Refresh before sending feedback.")
        with _LOCK:
            saved = read_record(path)
            latest = next((r for r in reversed(saved["reviews"]) if r["status"] == "published"), None)
            if not latest or latest["revision"] != request.reportRevision:
                raise HTTPException(409, "The report changed. Refresh before sending feedback.")
            item = {"id": digest({"text": request.text, "time": now()}), "text": request.text.strip(), "reportRevision": request.reportRevision, "status": "awaiting_clarification", "createdAt": now()}
            saved["feedback"].append(item)
            saved["feedback"] = saved["feedback"][-100:]
            path.parent.mkdir(parents=True, exist_ok=True)
            temp = path.with_suffix(".tmp")
            temp.write_text(json.dumps(saved, ensure_ascii=False, indent=2)); temp.replace(path)
        return item

    return router
