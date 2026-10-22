"""Case-centred ICDE interactions over existing signals, tools and saved reports."""
from __future__ import annotations

import asyncio
import copy
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
from harnessing_ts.patient_guide import guide_patient, PatientGuideInputError, needs_urgent_guidance
from harnessing_ts.reference_feature_extractor import execute_reference_feature_module
from harnessing_ts.settings.llm import read_effective_llm_config
from harnessing_ts.expert_collaboration import ModelServiceUnavailable, Plan, plan_check, propose, note_diff, measurement_changes
from harnessing_ts.variants.profiles import resolve_variant
from harnessing_ts.review_policy import Candidate, replay_row, boundary_tests
from harnessing_ts.agent_investigation import investigate as run_investigation, assess_replay, qrs_mapping_excerpt
from harnessing_ts import revision_loop as rev
from harnessing_ts.patient_report import generate_patient_report, report_basis
from harnessing_ts import patient_tasks as pt

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
        if record.get("patientReportId"):
            drafts = existing.get("patientReportDrafts", {"revision": 0, "items": []})
            generated = next((d for d in drafts["items"] if d["id"] == record["patientReportId"]), None)
            basis = report_basis(record["contextId"], record["labels"], [f["name"] for f in record["features"]],
                                 record.get("revisionItemId"), (record.get("reviewPolicy") or {}).get("roundId"),
                                 record.get("analysisRoundId"))
            linked = bool(existing["reviews"] and existing["reviews"][-1].get("patientReportId") == record["patientReportId"])
            if (not generated or generated["basis"] != basis or
                    (generated["baseReportRevision"] != expected and not linked)):
                raise HTTPException(409, "The patient report inputs changed. Generate the report again before publishing.")
            if record["status"] == "published" and not record.get("reportApproved"):
                raise HTTPException(422, "Review the generated patient report before publishing.")
            record = dict(record, author="RecursiveECG", patientReport={
                "generationId": generated["id"], "generator": "RecursiveECG", "source": generated["source"],
                "language": generated["language"], "generatedAt": generated["createdAt"],
                "expertEdited": record["note"].strip() != generated["note"].strip(),
                "expertReviewed": record["status"] == "published" and bool(record.get("reportApproved")),
                "reviewAuthority": "demo_review_not_verified_clinical_credentials"})
        if record.get("revisionItemId"):
            item = next((i for i in revision_state(existing)["items"] if i["id"] == record["revisionItemId"]), None)
            if not item or item["decision"] != "adopted" or not item["result"].get("candidate"):
                raise HTTPException(409, "Confirm the feedback result before using it in a report.")
            linked = existing["reviews"] and existing["reviews"][-1].get("revisionItemId") == item["id"]
            if item["baseReportRevision"] != expected and not linked:
                raise HTTPException(409, "The report changed since this feedback. Re-analyze before linking it.")
            # Build the immutable snapshot from saved server data, never from browser labels/text.
            result = item["result"]
            record = dict(record, feedbackImpact={"itemId": item["id"], "opinion": item["opinion"],
                "candidate": result["candidate"], "focus": result.get("focus"),
                "evaluation": result.get("evaluation"), "dataInfo": result.get("dataInfo"),
                "adoption": item.get("adoption"), "parentId": item.get("parentId"),
                "scope": "case_local_demo_assessment"})
        record = dict(record, revision=expected + 1, updatedAt=now())
        existing["revision"] = record["revision"]
        existing["reviews"].append(record)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(existing, ensure_ascii=False, indent=2))
        temp.replace(path)
        return record


def save_patient_report(path: Path, generated: dict, expected: int, report_revision: int,
                        revision_version: int, collaboration_version: int) -> dict:
    """Draft generation is separate from saved reports, adoption and publication."""
    with _LOCK:
        saved = read_record(path)
        drafts = saved.get("patientReportDrafts", {"revision": 0, "items": []})
        if (saved["revision"] != report_revision or drafts["revision"] != expected or
                revision_state(saved)["revision"] != revision_version or
                collaboration_state(saved)["revision"] != collaboration_version):
            raise HTTPException(409, "The report or feedback changed during generation. Refresh before generating again.")
        if len(drafts["items"]) >= 40:
            raise HTTPException(422, "This case has reached the 40-generation demo limit. Existing reports are retained.")
        drafts["items"].append(generated)
        drafts["revision"] += 1
        saved["patientReportDrafts"] = drafts
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(saved, ensure_ascii=False, indent=2))
        temp.replace(path)
        return {"generationRevision": drafts["revision"], "report": generated}


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
    policyRoundId: str | None = None
    revisionItemId: str | None = None
    patientReportId: str | None = None
    reportApproved: bool = False


class PatientReportRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    expectedGenerationRevision: int = Field(ge=0)
    labels: list[Literal["NORM", "MI", "STTC", "CD", "HYP"]] = Field(min_length=1, max_length=5)
    featureNames: list[str] = Field(default_factory=list, max_length=10)
    revisionItemId: str | None = None
    policyRoundId: str | None = None
    analysisRoundId: str | None = None
    language: Literal["zh", "en"] = "en"
    instructions: str = Field(default="", max_length=1000)
    previousDraft: str = Field(default="", max_length=3000)


class CollaborationRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    message: str = Field(min_length=3, max_length=2000)
    focus: str = Field(default="", max_length=100)
    action: Literal["auto", "review_evidence", "rerun_measurements", "audit_sources"] = "auto"
    autonomous: bool = False  # opt-in for legacy API clients; the expert UI enables it by default
    caseIds: list[int] = Field(default_factory=list, max_length=8)


class DecisionRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    roundId: str
    decision: Literal["accepted", "rejected"]
    validationId: str | None = None


class ValidationRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    roundId: str
    candidate: Candidate
    caseIds: list[int] = Field(min_length=1, max_length=8)


def collaboration_state(record: dict) -> dict:
    return record.get("collaboration", {"revision": 0, "rounds": []})


def save_collaboration(path: Path, expected: int, *, round_record: dict | None = None,
                       decision: DecisionRequest | None = None, report_revision: int | None = None,
                       validation: dict | None = None, round_id: str | None = None) -> dict:
    with _LOCK:
        saved = read_record(path)
        if report_revision is not None and saved["revision"] != report_revision:
            raise HTTPException(409, "The report changed during collaboration. Refresh before continuing.")
        collab = collaboration_state(saved)
        if collab["revision"] != expected:
            raise HTTPException(409, "Another collaboration update arrived. Refresh before continuing.")
        if round_record is not None:
            collab["rounds"].append(round_record)
        elif decision is not None or validation is not None:
            latest = collab["rounds"][-1] if collab["rounds"] else None
            if not latest or latest["id"] != (decision.roundId if decision else round_id) or latest["decision"] != "pending":
                raise HTTPException(409, "Only the latest pending suggestion can be accepted or rejected.")
            if validation is not None:
                latest.setdefault("validationHistory", []).append(validation)
                latest["validation"] = validation
            else:
                if decision.decision == "accepted" and latest.get("candidate"):
                    checked = latest.get("validation")
                    if not checked or decision.validationId != checked["id"]:
                        raise HTTPException(409, "Validate the current candidate before accepting it.")
                    version = 1 + sum(bool(r.get("policy")) for r in collab["rounds"])
                    latest["policy"] = {"version": version, "candidate": checked["candidate"], "validationId": checked["id"],
                        "counts": checked["counts"], "caseIds": [r["ecgId"] for r in checked["rows"]],
                        "caseResult": next(r for r in checked["rows"] if r["contextId"] == latest["contextId"]),
                        "expertEdited": checked.get("expertEdited", False),
                        "scope": "case_local_review_overlay", "adoptedAt": now(), "changesPredictions": False}
                latest["decision"] = decision.decision
                latest["decidedAt"] = now()
        collab["revision"] += 1
        saved["collaboration"] = collab
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(saved, ensure_ascii=False, indent=2))
        temp.replace(path)
        return collab


def revision_state(record: dict) -> dict:
    return record.get("revisions", {"revision": 0, "items": []})


def checked_revision_data(workspace: Path) -> rev.RevisionData:
    """Stale/unavailable inputs are a recoverable conflict, not an internal error."""
    try:
        return rev.load_revision_data(workspace)
    except rev.RevisionUnavailable as exc:
        raise HTTPException(409, f"{exc} Re-analyze before using this result.") from exc


def save_revision(path: Path, expected: int, *, item: dict | None = None, decision: str | None = None,
                  item_id: str | None = None, report_revision: int | None = None) -> dict:
    """Expert-informed candidate judgments. Stored beside, never over, reviews, predictions or collaboration."""
    with _LOCK:
        saved = read_record(path)
        if report_revision is not None and saved["revision"] != report_revision:
            raise HTTPException(409, "The report changed during the revision. Refresh before continuing.")
        state = revision_state(saved)
        if state["revision"] != expected:
            raise HTTPException(409, "Another revision update arrived. Refresh before continuing.")
        if item is not None:
            state["items"].append(item)
        else:
            latest = state["items"][-1] if state["items"] else None
            if not latest or latest["id"] != item_id or latest["decision"] != "pending":
                raise HTTPException(409, "Only the latest pending revision can be decided.")
            if decision == "adopted":
                if not latest["result"].get("candidate"):
                    raise HTTPException(422, "There is no recommended candidate to adopt.")
                latest["adoption"] = {"version": 1 + sum(1 for i in state["items"] if i.get("adoption")), "adoptedAt": now(),
                                      "scope": "case_review_candidate_judgment", "changesPredictions": False, "published": False}
            latest["decision"] = decision
            latest["decidedAt"] = now()
        state["revision"] += 1
        saved["revisions"] = state
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(saved, ensure_ascii=False, indent=2))
        temp.replace(path)
        return state


class RevisionRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    message: str = Field(min_length=3, max_length=1000)
    reportRevision: int | None = None
    parentId: str | None = None


class RevisionDecisionRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    itemId: str
    decision: Literal["adopted", "rejected"]


class CriterionRequest(BaseModel):
    text: str = Field(min_length=3, max_length=300)
    contextId: str
    caseIds: list[int] = Field(min_length=1, max_length=8)


class QuestionRequest(BaseModel):
    contextId: str
    reportRevision: int = Field(ge=1)
    question: str = Field(min_length=1, max_length=500)
    history: list[dict[str, str]] = Field(default_factory=list, max_length=6)
    language: Literal["zh", "en"] | None = None


class FeedbackRequest(BaseModel):
    contextId: str
    reportRevision: int = Field(ge=1)
    text: str = Field(min_length=3, max_length=1000)


class PatientGuideRequest(QuestionRequest):
    mode: Literal["explain", "evidence", "uncertainty", "prepare", "teachback"] = "explain"
    language: Literal["zh", "en"] = "en"
    selected: str = Field(default="", max_length=150)
    taskId: str | None = Field(default=None, max_length=100)


class PatientTaskRequest(BaseModel):
    contextId: str
    expectedRevision: int = Field(ge=0)
    reportRevision: int = Field(ge=1)
    question: str = Field(default="", max_length=500)
    label: str = Field(default="", max_length=10)
    language: Literal["zh", "en"] = "en"


class PatientTaskDecision(PatientTaskRequest):
    text: str = Field(default="", max_length=2800)
    draftId: str = Field(default="", max_length=100)
    approved: bool = False
    unresolved: bool = False
    workKind: Literal["", "revision", "collaboration", "published_report"] = ""
    workId: str = Field(default="", max_length=100)


def save_patient_task(path: Path, expected: int, published_revision: int, operation) -> dict:
    with _LOCK:
        saved = read_record(path)
        latest = next((r for r in reversed(saved["reviews"]) if r["status"] == "published"), None)
        if not latest or latest["revision"] != published_revision:
            raise HTTPException(409, "The published report changed. Refresh the review task before continuing.")
        state = pt.task_state(saved)
        if state["revision"] != expected:
            raise HTTPException(409, "The review task changed. Refresh before continuing.")
        operation(state, latest)
        state["revision"] += 1
        saved["patientTasks"] = state
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_suffix(".tmp")
        temp.write_text(json.dumps(saved, ensure_ascii=False, indent=2)); temp.replace(path)
        return state


def create_demo_router(current_workspace: Path) -> APIRouter:
    router = APIRouter(prefix="/api/demo")

    def require_collaboration() -> None:
        variant = resolve_variant()
        if not (variant.reference_feature_extractor and variant.case_review_reference_features):
            raise HTTPException(403, "Expert evidence collaboration is disabled by the active variant.")

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
            return workspace, {"dataset": dataset, "sample": sample, "waveform": waveform, "iteration": overview["iteration"], "contextId": context_id, "toolVersion": tool_version, "revision": saved["revision"], "review": saved["reviews"][-1] if saved["reviews"] else None, "publishedReport": published, "feedback": saved["feedback"], "patientTasks": pt.public_tasks(saved), "patientReportGenerationRevision": saved.get("patientReportDrafts", {}).get("revision", 0)}, path
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

    async def replay_candidate(dataset: str, ctx: dict, candidate: Candidate, case_ids: list[int]) -> dict:
        rows = []
        for sample_id in dict.fromkeys(case_ids):
            workspace, item, _ = await asyncio.to_thread(context, dataset, sample_id)
            result, _ = await asyncio.to_thread(evidence, workspace, item)
            feature = next((f for f in result["features"] if f["name"] == candidate.feature), None)
            rows.append(replay_row(candidate, feature, sample_id, item["contextId"]))
        for row in rows:
            _, fresh, _ = await asyncio.to_thread(context, dataset, row["ecgId"])
            check_context(fresh, row["contextId"])
        validation = {"candidate": candidate.model_dump(), "rows": rows, "expertEdited": False,
            "counts": {key: sum(r["outcome"] == key for r in rows) for key in ("changed", "unchanged", "not_assessable")},
            "boundaryTests": boundary_tests(candidate), "createdAt": now(), "baseReportRevision": ctx["revision"],
            "changesPredictions": False, "applied": False}
        validation["id"] = digest(validation)
        return validation

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

    @router.post("/{dataset}/cases/{ecg_id}/patient-report")
    async def patient_report(dataset: str, ecg_id: int, request: PatientReportRequest) -> dict:
        require_collaboration()
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        saved = read_record(path)
        if saved["revision"] != request.expectedRevision or saved.get("patientReportDrafts", {}).get("revision", 0) != request.expectedGenerationRevision:
            raise HTTPException(409, "The report or feedback changed during generation. Refresh before generating again.")
        if "NORM" in request.labels and len(set(request.labels)) > 1:
            raise HTTPException(422, "NORM cannot be combined with abnormal review labels.")
        revision_version = revision_state(saved)["revision"]
        collaboration_version = collaboration_state(saved)["revision"]
        revision_fingerprint = None
        if request.revisionItemId:
            require_collaboration()
            selected = next((i for i in revision_state(saved)["items"] if i["id"] == request.revisionItemId), None)
            if not selected or selected["decision"] != "adopted" or not selected["result"].get("candidate"):
                raise HTTPException(409, "Confirm the feedback result before using it in a report.")
            linked = ctx.get("review") and ctx["review"].get("revisionItemId") == selected["id"]
            if selected["baseReportRevision"] != ctx["revision"] and not linked:
                raise HTTPException(409, "The report changed since this feedback. Re-analyze before linking it.")
            if sorted(set(request.labels)) != sorted(selected["result"].get("focus", {}).get("after", [])):
                raise HTTPException(409, "Selected labels differ from the confirmed assessment. Select that result again.")
            data = await asyncio.to_thread(checked_revision_data, workspace)
            revision_fingerprint = data.input_fingerprint
            if selected["result"].get("dataInfo", {}).get("inputFingerprint") != revision_fingerprint:
                raise HTTPException(409, "The revision inputs changed. Re-analyze before using this result.")
        for round_id, needs_policy in ((request.analysisRoundId, False), (request.policyRoundId, True)):
            if round_id:
                require_collaboration()
                linked_round = next((r for r in collaboration_state(saved)["rounds"] if r["id"] == round_id and r["decision"] == "accepted"), None)
                if not linked_round or (needs_policy and not linked_round.get("policy")):
                    raise HTTPException(409, "Accept the analysis suggestion before linking it to a report draft.")
        result, _ = await asyncio.to_thread(evidence, workspace, ctx)
        known = {f["name"] for f in result["features"]}
        if set(request.featureNames) - known:
            raise HTTPException(422, "The report references an unknown measurement.")
        features = [f for f in result["features"] if f["name"] in request.featureNames]
        try:
            generated = await generate_patient_report(read_effective_llm_config(workspace), labels=sorted(set(request.labels)),
                features=features, language=request.language, instructions=request.instructions.strip(),
                previous_draft=request.previousDraft, assessment_changed=bool(request.revisionItemId))
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, f"{exc} Existing reports and your draft are unchanged.") from exc
        except Exception as exc:
            raise HTTPException(503, "The patient report service could not return a valid report. Existing reports and your draft are unchanged.") from exc
        _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(fresh, request.contextId)
        if revision_fingerprint is not None:
            data = await asyncio.to_thread(checked_revision_data, workspace)
            if data.input_fingerprint != revision_fingerprint:
                raise HTTPException(409, "The revision inputs changed. Re-analyze before using this result.")
        generated.update({"id": digest({"case": ctx["contextId"], "time": now(), "note": generated["note"]}),
            "createdAt": now(), "baseReportRevision": request.expectedRevision,
            "basis": report_basis(ctx["contextId"], request.labels, request.featureNames, request.revisionItemId,
                                  request.policyRoundId, request.analysisRoundId)})
        return await asyncio.to_thread(save_patient_report, path, generated, request.expectedGenerationRevision,
                                       request.expectedRevision, revision_version, collaboration_version)

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
        policy = None
        if request.policyRoundId:
            require_collaboration()
            rounds = collaboration_state(read_record(path))["rounds"]
            accepted = next((r for r in rounds if r["id"] == request.policyRoundId and r["decision"] == "accepted" and r.get("policy")), None)
            if not accepted:
                raise HTTPException(409, "Only an adopted review overlay can be linked to a report.")
            policy = {**accepted["policy"], "roundId": accepted["id"], "expertQuestion": accepted["message"]}
        if request.revisionItemId:
            require_collaboration()
            items = revision_state(read_record(path))["items"]
            selected = next((i for i in items if i["id"] == request.revisionItemId), None)
            data = await asyncio.to_thread(checked_revision_data, workspace)
            if not selected or selected["result"].get("dataInfo", {}).get("inputFingerprint", "") != data.input_fingerprint:
                raise HTTPException(409, "The revision inputs changed. Re-analyze before using this result.")
        _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(fresh, request.contextId)
        record = {"contextId": ctx["contextId"], "dataset": dataset, "ecgId": ecg_id, "iteration": ctx["iteration"], "toolVersion": ctx["toolVersion"], "labels": sorted(set(request.labels)), "note": request.note.strip(), "status": request.status, "features": features, "author": "Demo reviewer", "authority": "demo_review", "analysisRoundId": request.analysisRoundId, "reviewPolicy": policy, "revisionItemId": request.revisionItemId, "patientReportId": request.patientReportId, "reportApproved": request.reportApproved}
        return await asyncio.to_thread(save_review, path, record, request.expectedRevision)

    @router.get("/{dataset}/cases/{ecg_id}/collaboration")
    async def get_collaboration(dataset: str, ecg_id: int) -> dict:
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        return {"contextId": ctx["contextId"], **collaboration_state(read_record(path))}

    @router.post("/{dataset}/cases/{ecg_id}/collaboration")
    async def collaborate(dataset: str, ecg_id: int, request: CollaborationRequest) -> dict:
        require_collaboration()
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
        history = [{k: r.get(k) for k in ("message", "response", "draftNote", "decision", "checks", "measurementChanges", "toolVersion", "contextId")} for r in previous["rounds"][-4:]]
        config = read_effective_llm_config(workspace)

        async def guard() -> None:
            require_collaboration()
            _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
            check_context(fresh, request.contextId)
            if fresh["revision"] != ctx["revision"]:
                raise HTTPException(409, "The report changed during analysis. Refresh before requesting a new revision.")
            if collaboration_state(read_record(path))["revision"] != request.expectedRevision:
                raise HTTPException(409, "Another collaboration update arrived. Refresh before continuing.")

        async def execute_check(plan: Plan, current: dict) -> dict:
            await guard()
            changes = []
            checks = []
            if plan.action == "rerun_measurements":
                original = current
                current, _ = await asyncio.to_thread(evidence, workspace, ctx, True)
                changes = measurement_changes(original["features"], current["features"])
                checks.append({"name": "Re-execute measurement tool", "detail": f"Cache bypassed. {len(changes)} measurement values changed. Same full-record algorithm; no new segment or beat-boundary capability.", "status": "completed"})
            selected = [f for f in current["features"] if not plan.focus or f["name"] == plan.focus]
            sources = []
            for feature in selected:
                for excerpt in feature.get("evidence", []):
                    if request.autonomous and plan.action != "audit_sources":
                        continue  # do not claim source-file checks during a different agent action
                    ref = excerpt.get("referencePath", "")
                    resolved = (workspace / ref).resolve() if ref else None
                    available = bool(resolved and resolved.is_relative_to(workspace.resolve()) and resolved.is_file())
                    sources.append({"feature": feature["name"], "path": ref, "available": available, "quote": excerpt.get("quote", ""), "section": excerpt.get("section", ""), "page": excerpt.get("page")})
            if not request.autonomous or plan.action != "rerun_measurements":
                checks.append({"name": "Inspect attached sources" if plan.action == "audit_sources" else "Inspect measurement rules", "detail": f"Inspected {len(selected)} measurement records and {len(sources)} attached excerpts. {sum(s['available'] for s in sources)} source files available. No new literature search or verbatim quote validation performed.", "status": "completed"})
            observation = {"measurements": [{"name": f["name"], "value": f.get("value"), "judgment": f.get("judgment")} for f in selected],
                "sources": sources, "measurementChanges": changes,
                "cacheBypassed": plan.action == "rerun_measurements",
                "sourcesChecked": plan.action == "audit_sources",
                "limitations": current.get("adapterNotes", [])}
            if request.autonomous and plan.action == "audit_sources" and any(f["name"] == "qrs_duration_ms" for f in selected):
                mapping = await asyncio.to_thread(qrs_mapping_excerpt, workspace)
                if mapping:
                    observation["implementationExcerpt"] = mapping
                    checks.append({"name": "Inspect extractor output mapping", "detail": f"Read {len(mapping['lines'])} actual source lines for the QRS output mapping. No code changed.", "status": "completed"})
            return {"result": current, "changes": changes, "checks": checks, "sources": sources, "observation": observation}

        async def generate() -> tuple:
            checks = [{"name": "Load case evidence", "detail": "Retrieved cached full-record measurements." if cached else "Executed the existing full-record reference feature tool.", "status": "completed"}]
            investigation = None
            validation = None
            current = result
            if request.autonomous and request.action == "auto":
                outcome = await run_investigation(config, question=request.message, focus=request.focus,
                    result=current, history=history, execute=execute_check, guard=guard)
                plan, current = outcome["plan"], outcome["result"]
                checks.extend(outcome["checks"])
                sources, changes, investigation = outcome["sources"], outcome["changes"], outcome["investigation"]
            else:
                if request.action == "auto":
                    plan = await plan_check(config, request.message, request.focus, names, history[-1] if history else None)
                    await guard()
                else:
                    plan = Plan(action=request.action, focus=request.focus, reason="Check explicitly requested by the user.")
                outcome = await execute_check(plan, current)
                current, sources, changes = outcome["result"], outcome["sources"], outcome["changes"]
                checks.extend(outcome["checks"])
            checks.append({"name": "Scope boundary", "detail": "No raw-waveform morphology interpretation, segment remeasurement, code update, model retraining or clinical diagnosis.", "status": "limitation"})
            payload = {"ecgId": ecg_id, "modelPredictions": ctx["sample"].get("predicted", []), "datasetLabels": ctx["sample"].get("truth", []), "toolVersion": ctx["toolVersion"], "sources": sources, "currentReview": ctx.get("review"), "investigation": investigation}
            proposal = await propose(config, feedback=request.message, context=payload, result=current, plan=plan, checks=checks, history=history)
            await guard()
            if investigation and proposal.get("candidate"):
                ids = list(dict.fromkeys([ecg_id, *request.caseIds]))[:8]
                validation = await replay_candidate(dataset, ctx, Candidate.model_validate(proposal["candidate"]), ids)
                validation["initiatedBy"] = "agent"
                validation["id"] = digest({k: v for k, v in validation.items() if k != "id"})
                await guard()
                investigation["replayAssessment"] = await assess_replay(config, question=request.message,
                    proposal={**proposal, "executedInvestigation": investigation}, validation={**validation, "currentEcgId": ecg_id})
                investigation["assessmentValidationId"] = validation["id"]
                await guard()
                # Revalidate tool inputs after the final provider await, before recording anything.
                for row in validation["rows"]:
                    _, fresh, _ = await asyncio.to_thread(context, dataset, row["ecgId"])
                    check_context(fresh, row["contextId"])
                checks.append({"name": "Automatic candidate replay", "detail": f"Executed on {len(validation['rows'])} selected real records. No condition adopted and no predictions changed.", "status": "completed"})
            if investigation and investigation.get("question"):
                proposal["nextChecks"] = list(dict.fromkeys([investigation["question"], *proposal["nextChecks"]]))[:5]
            return plan, current, checks, sources, changes, proposal, investigation, validation

        try:
            plan, result, checks, sources, changes, proposal, investigation, validation = await asyncio.wait_for(generate(), timeout=150)
        except (HTTPException,):
            raise
        except TimeoutError as exc:
            raise HTTPException(503, "The agent investigation reached its time limit. Your question and existing reports are unchanged.") from exc
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, f"{exc} Your question and existing reports are unchanged.") from exc
        except ValueError as exc:
            raise HTTPException(503, "The model returned an invalid analysis format. Retry the question. Your question and existing reports are unchanged.") from exc
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
        if investigation:
            record["investigation"] = investigation
        if validation:
            record["validation"] = validation
            record["validationHistory"] = [validation]
        saved = await asyncio.to_thread(save_collaboration, path, request.expectedRevision, round_record=record, report_revision=ctx["revision"])
        return {"contextId": ctx["contextId"], **saved}

    @router.post("/{dataset}/cases/{ecg_id}/collaboration/validate")
    async def validate_candidate(dataset: str, ecg_id: int, request: ValidationRequest) -> dict:
        require_collaboration()
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        saved = collaboration_state(read_record(path))
        latest = saved["rounds"][-1] if saved["rounds"] else None
        if saved["revision"] != request.expectedRevision or not latest or latest["id"] != request.roundId or latest["decision"] != "pending" or latest["baseReportRevision"] != ctx["revision"]:
            raise HTTPException(409, "The analysis changed. Refresh before validating a candidate.")
        if not latest.get("candidate") or latest["candidate"]["feature"] != request.candidate.feature:
            raise HTTPException(422, "Validate a candidate for the measurement proposed in this round.")
        if ecg_id not in request.caseIds:
            raise HTTPException(422, "Include the current record in the replay before adopting a case-local overlay.")
        validation = await replay_candidate(dataset, ctx, request.candidate, request.caseIds)
        _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(fresh, request.contextId)
        validation["expertEdited"] = request.candidate.model_dump() != latest["candidate"]
        validation["id"] = digest({k: v for k, v in validation.items() if k != "id"})
        saved = await asyncio.to_thread(save_collaboration, path, request.expectedRevision, validation=validation,
            round_id=request.roundId, report_revision=ctx["revision"])
        return {"contextId": ctx["contextId"], **saved}

    @router.post("/{dataset}/cases/{ecg_id}/collaboration/decision")
    async def collaboration_decision(dataset: str, ecg_id: int, request: DecisionRequest) -> dict:
        require_collaboration()
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        latest = collaboration_state(read_record(path))["rounds"]
        if not latest or latest[-1]["baseReportRevision"] != ctx["revision"]:
            raise HTTPException(409, "The report changed since this suggestion. Request a fresh analysis before deciding.")
        if request.decision == "accepted" and latest[-1].get("candidate"):
            validation = latest[-1].get("validation")
            if not validation or validation["id"] != request.validationId:
                raise HTTPException(409, "Validate the current candidate before accepting it.")
            for row in validation["rows"]:
                _, fresh, _ = await asyncio.to_thread(context, dataset, row["ecgId"])
                check_context(fresh, row["contextId"])
        saved = await asyncio.to_thread(save_collaboration, path, request.expectedRevision, decision=request, report_revision=ctx["revision"])
        return {"contextId": ctx["contextId"], **saved}

    @router.get("/{dataset}/cases/{ecg_id}/revision")
    async def get_revision(dataset: str, ecg_id: int) -> dict:
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        status: dict[str, Any]
        try:
            data = await asyncio.to_thread(rev.load_revision_data, workspace)
            data = rev.for_review(data, ecg_id)
            status = {"available": True, "inValidationSet": ecg_id in data.index, "tuningN": len(data.subset("tuning")),
                      "holdoutN": len(data.subset("holdout")), "reconciliation": data.reconciliation}
        except rev.RevisionUnavailable as exc:
            status = {"available": False, "reason": str(exc)}
        return {"contextId": ctx["contextId"], **revision_state(read_record(path)), "status": status}

    @router.get("/{dataset}/cases/{ecg_id}/revision/{item_id}/evidence")
    async def get_revision_evidence(dataset: str, ecg_id: int, item_id: str) -> dict:
        from harnessing_ts.revision_evidence import candidate_evidence
        require_collaboration()
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        state = revision_state(read_record(path))
        item = next((i for i in state["items"] if i["id"] == item_id), None)
        if item is None:
            raise HTTPException(404, "The selected feedback report is unavailable. Refresh this case.")
        data = await asyncio.to_thread(checked_revision_data, workspace)
        if item["result"].get("dataInfo", {}).get("inputFingerprint") != data.input_fingerprint:
            raise HTTPException(409, "The revision inputs changed. Re-analyze before using this result.")
        recommended = bool(item["result"].get("candidate"))
        tried = item["result"].get("attempts", [])
        raw = item["result"].get("candidate") or (tried[-1]["candidate"] if tried else None)
        dossier = None
        if raw:
            cand = rev.parse_candidate(raw, data)
            dossier = await asyncio.to_thread(candidate_evidence, rev.for_review(data, ecg_id), cand, ecg_id)
            dossier.update(candidate=raw, recommended=recommended)
        _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(fresh, ctx["contextId"])
        current = await asyncio.to_thread(checked_revision_data, workspace)
        if (fresh["revision"] != ctx["revision"] or revision_state(read_record(path))["revision"] != state["revision"]
                or current.input_fingerprint != data.input_fingerprint):
            raise HTTPException(409, "The evidence changed while loading. Refresh this case.")
        return {"contextId": ctx["contextId"], "itemId": item_id, "evidence": dossier}

    @router.post("/{dataset}/cases/{ecg_id}/revision")
    async def revise(dataset: str, ecg_id: int, request: RevisionRequest) -> dict:
        require_collaboration()
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        previous = revision_state(read_record(path))
        if previous["revision"] != request.expectedRevision:
            raise HTTPException(409, "The revisions changed. Refresh this case.")
        if len(previous["items"]) >= 20:
            raise HTTPException(422, "This case has reached the 20-revision demo limit. Existing history is retained.")
        try:
            data = await asyncio.to_thread(rev.load_revision_data, workspace)
        except rev.RevisionUnavailable as exc:
            raise HTTPException(503, f"{exc} Your opinion and existing reports are unchanged.") from exc
        if ecg_id not in data.index:
            raise HTTPException(422, "This record is not part of the validation set used by the revision loop.")
        parent = next((i for i in previous["items"] if i["id"] == request.parentId), None) if request.parentId else (previous["items"][-1] if previous["items"] else None)
        if request.parentId and parent is None:
            raise HTTPException(409, "The selected feedback report is unavailable. Refresh this case.")
        if request.reportRevision is not None and (not ctx.get("review") or ctx["review"]["revision"] != request.reportRevision):
            raise HTTPException(409, "The expert report changed. Refresh before applying its feedback.")
        result, _ = await asyncio.to_thread(evidence, workspace, ctx)
        # Only tuning-set evaluation observations enter subsequent agent turns.
        history_items = [i for i in previous["items"][-3:] if not parent or i["id"] != parent["id"]] + ([parent] if parent else [])
        history = [{"id": i["id"], "opinion": i["opinion"], "decision": i["decision"],
                    "candidate": i["result"].get("candidate"),
                    "attempts": [{"candidate": a["candidate"], "tuning": a["subsets"]["tuning"],
                                  "caseEvidence": a.get("caseEvidence") if i["result"].get("dataInfo", {}).get("inputFingerprint") == data.input_fingerprint else None}
                                 for a in i["result"].get("attempts", [])]}
                   for i in history_items]
        if history:
            history[-1]["selectedForRefinement"] = True
        previous_checks = collaboration_state(read_record(path))["rounds"]
        evidence_context = {"features": result.get("features", []), "limitations": result.get("adapterNotes", []),
                            "previousChecks": previous_checks[-1].get("checks", []) if previous_checks else []}
        config = read_effective_llm_config(workspace)

        async def guard() -> None:
            require_collaboration()
            _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
            check_context(fresh, request.contextId)
            if fresh["revision"] != ctx["revision"]:
                raise HTTPException(409, "The report changed during the revision. Refresh before continuing.")
            if revision_state(read_record(path))["revision"] != request.expectedRevision:
                raise HTTPException(409, "Another revision update arrived. Refresh before continuing.")
            latest_data = await asyncio.to_thread(checked_revision_data, workspace)
            if latest_data.input_fingerprint != data.input_fingerprint:
                raise HTTPException(409, "The revision inputs changed. Re-analyze before using this result.")

        try:
            result = await asyncio.wait_for(rev.run_revision(config, data, focus_id=ecg_id, opinion=request.message.strip(), guard=guard,
                history=history, evidence_context=evidence_context), timeout=150)
        except HTTPException:
            raise
        except TimeoutError as exc:
            raise HTTPException(503, "The revision reached its time limit. Your opinion and existing reports are unchanged.") from exc
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, f"{exc} Your opinion and existing reports are unchanged.") from exc
        except ValueError as exc:
            raise HTTPException(503, "The model returned an invalid revision format. Retry. Your opinion and existing reports are unchanged.") from exc
        except Exception as exc:
            raise HTTPException(503, "The revision service could not return a valid result. Your opinion and existing reports are unchanged.") from exc
        await guard()
        _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(fresh, request.contextId)
        if fresh["revision"] != ctx["revision"]:
            raise HTTPException(409, "The report changed during the revision. Refresh before continuing.")
        item = {"id": digest({"case": request.contextId, "time": now(), "message": request.message}), "createdAt": now(),
                "opinion": request.message.strip(), "result": result, "decision": "pending", "contextId": request.contextId,
                "baseReportRevision": ctx["revision"], "toolVersion": ctx["toolVersion"],
                "parentId": parent["id"] if parent else None,
                "sourceReportRevision": request.reportRevision}
        saved = await asyncio.to_thread(save_revision, path, request.expectedRevision, item=item, report_revision=ctx["revision"])
        return {"contextId": ctx["contextId"], **saved}

    @router.post("/{dataset}/cases/{ecg_id}/revision/decision")
    async def revision_decision(dataset: str, ecg_id: int, request: RevisionDecisionRequest) -> dict:
        require_collaboration()
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        items = revision_state(read_record(path))["items"]
        if not items or items[-1]["baseReportRevision"] != ctx["revision"]:
            raise HTTPException(409, "The report changed since this revision. Request a fresh revision before deciding.")
        if request.decision == "adopted":
            data = await asyncio.to_thread(checked_revision_data, workspace)
            if items[-1]["result"].get("dataInfo", {}).get("inputFingerprint", "") != data.input_fingerprint:
                raise HTTPException(409, "The revision inputs changed. Re-analyze before using this result.")
        saved = await asyncio.to_thread(save_revision, path, request.expectedRevision, decision=request.decision,
                                        item_id=request.itemId, report_revision=ctx["revision"])
        return {"contextId": ctx["contextId"], **saved}

    @router.post("/{dataset}/cases/{ecg_id}/question")
    async def question(dataset: str, ecg_id: int, request: QuestionRequest) -> dict[str, Any]:
        # One report-only explainer and stale guards for all Demo clients.
        # The root workbench's separate Q&A remains unchanged.
        language = request.language or ("zh" if re.search(r"[\u4e00-\u9fff]", request.question) else "en")
        result = await understand(dataset, ecg_id, PatientGuideRequest(
            **request.model_dump(exclude={"language"}), language=language))
        material = next(m for m in result["materials"] if m["id"] == "report")
        return {"answer": "\n\n".join(result[k] for k in ("explanation", "symptoms", "dailyCare", "medication", "basis", "limitation") if result.get(k)),
                "source": result["source"], "reportRevision": result["reportRevision"],
                "contextUsed": {"note": material["text"], "labels": material["labels"],
                                "features": [m["name"] for m in result["materials"] if m["kind"] == "attached_measurement"]}}

    @router.post("/{dataset}/cases/{ecg_id}/understand")
    async def understand(dataset: str, ecg_id: int, request: PatientGuideRequest) -> dict[str, Any]:
        workspace, ctx, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        report = ctx["publishedReport"]
        if not report or report["revision"] != request.reportRevision:
            raise HTTPException(409, "Choose the current published demo report before asking.")
        clarification = None
        if request.taskId:
            selected_task = next((i for i in ctx["patientTasks"]["items"] if i["id"] == request.taskId), None)
            clarification = (pt.task_clarification(selected_task, report) if selected_task and selected_task.get("interactionMode") == "agent_investigation" and not selected_task.get("answer")
                             else selected_task.get("answer") if selected_task else None)
            if not clarification or clarification["reportRevision"] != report["revision"]:
                raise HTTPException(409, "This answer belongs to an earlier report. Start a new review against the current report.")
            clarification = dict(clarification, question=selected_task["question"])
        try:
            result = await guide_patient(read_effective_llm_config(workspace), report=pt.task_model_report(report),
                question=request.question.strip(), mode=request.mode, language=request.language,
                selected=request.selected, history=request.history, clarification=clarification)
        except PatientGuideInputError as exc:
            raise HTTPException(422, str(exc)) from exc
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, "The patient explanation could not be completed. Your question and published report are unchanged.") from exc
        _, latest, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(latest, request.contextId)
        if not latest["publishedReport"] or latest["publishedReport"]["revision"] != report["revision"]:
            raise HTTPException(409, "The published report changed during explanation. Refresh before asking again.")
        if request.taskId and latest["patientTasks"]["revision"] != ctx["patientTasks"]["revision"]:
            raise HTTPException(409, "The review task changed. Refresh before continuing.")
        return dict(result, contextId=ctx["contextId"], reportRevision=report["revision"], mode=request.mode)

    def task_item(state: dict, item_id: str) -> dict:
        item = next((i for i in state["items"] if i["id"] == item_id), None)
        if not item:
            raise HTTPException(404, "This review task is unavailable.")
        return item

    @router.get("/{dataset}/cases/{ecg_id}/patient-tasks/review")
    async def review_tasks(dataset: str, ecg_id: int) -> dict:
        require_collaboration()
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        saved = read_record(path)
        result = copy.deepcopy(pt.task_state(saved))
        for item in result["items"]:
            item["workOptions"] = pt.review_work_options(saved, item, ctx["publishedReport"])
        return {"contextId": ctx["contextId"], **result}

    @router.post("/{dataset}/cases/{ecg_id}/patient-tasks/investigate")
    async def patient_investigate(dataset: str, ecg_id: int, request: PatientTaskRequest) -> dict:
        require_collaboration()
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        report = ctx["publishedReport"]
        if not report or report["revision"] != request.reportRevision:
            raise HTTPException(409, "Choose the current published demo report before asking.")
        if not request.question.strip():
            raise HTTPException(422, "Write the question you would like checked.")
        if request.label and request.label not in report["labels"]:
            raise HTTPException(422, "Select a label from the published report.")
        if needs_urgent_guidance(request.question):
            raise HTTPException(422, "For chest pain, breathing difficulty or fainting, seek urgent medical care. This demo cannot assess symptoms.")
        saved = read_record(path)
        if len(pt.task_state(saved)["items"]) >= 30:
            raise HTTPException(422, "This case has reached the 30-task demo limit. Existing tasks are retained.")
        earlier = [r for r in saved["reviews"] if r["status"] == "published" and r["revision"] < report["revision"]]

        async def guard():
            require_collaboration()
            _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
            check_context(fresh, request.contextId)
            if (not fresh["publishedReport"] or fresh["publishedReport"]["revision"] != request.reportRevision or
                    fresh["patientTasks"]["revision"] != request.expectedRevision):
                raise HTTPException(409, "The report or review task changed during the check. Your question is retained.")
        await guard()
        try:
            result = await asyncio.wait_for(pt.investigate_task(read_effective_llm_config(workspace), report=report,
                previous=earlier[-1] if earlier else None, question=request.question.strip(), label=request.label,
                language=request.language, guard=guard), timeout=150)
        except HTTPException:
            raise
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, "The patient check could not finish. Your question and published report are unchanged.") from exc
        await guard()
        item = {"id": digest({"case": request.contextId, "time": now(), "question": request.question}),
                "contextId": request.contextId, "createdAt": now(), "status": "prepared",
                "question": request.question.strip(), "label": request.label,
                "reportRevision": request.reportRevision, "originalReport": pt.report_snapshot(report),
                "investigation": result, "language": request.language, "interactionMode": "agent_investigation"}
        def append(state, latest):
            if len(state["items"]) >= 30:
                raise HTTPException(422, "This case has reached the 30-task demo limit. Existing tasks are retained.")
            state["items"].append(item)
        state = await asyncio.to_thread(save_patient_task, path, request.expectedRevision, request.reportRevision, append)
        return {"contextId": ctx["contextId"], **pt.public_tasks({"patientTasks": state}), "selectedId": item["id"]}

    @router.post("/{dataset}/cases/{ecg_id}/patient-tasks/{item_id}/submit")
    async def submit_patient_task(dataset: str, ecg_id: int, item_id: str, request: PatientTaskDecision) -> dict:
        require_collaboration()
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        text = request.text.strip()
        if not 3 <= len(text) <= 500:
            raise HTTPException(422, "Use 3 to 500 characters for the clarification request.")
        def submit(state, latest):
            item = task_item(state, item_id)
            if item["status"] != "prepared" or item["reportRevision"] != latest["revision"]:
                raise HTTPException(409, "This prepared task is stale or already submitted. Start a new check if needed.")
            item.update(status="submitted", requestText=text, submittedAt=now())
        state = await asyncio.to_thread(save_patient_task, path, request.expectedRevision, request.reportRevision, submit)
        return {"contextId": ctx["contextId"], **pt.public_tasks({"patientTasks": state})}

    @router.post("/{dataset}/cases/{ecg_id}/patient-tasks/{item_id}/start")
    async def start_patient_task(dataset: str, ecg_id: int, item_id: str, request: PatientTaskDecision) -> dict:
        require_collaboration()
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        def start(state, latest):
            item = task_item(state, item_id)
            if item["status"] != "submitted":
                raise HTTPException(409, "Only a submitted task can be started.")
            saved = read_record(path)
            item.update(status="in_review", startedAt=now(), workBaseline={
                "revision": [w["id"] for w in saved.get("revisions", {}).get("items", [])],
                "collaboration": [w["id"] for w in saved.get("collaboration", {}).get("rounds", [])],
                "publishedRevision": latest["revision"]})
        state = await asyncio.to_thread(save_patient_task, path, request.expectedRevision, request.reportRevision, start)
        return {"contextId": ctx["contextId"], **state}

    @router.post("/{dataset}/cases/{ecg_id}/patient-tasks/{item_id}/answer-draft")
    async def draft_patient_task_answer(dataset: str, ecg_id: int, item_id: str, request: PatientTaskDecision) -> dict:
        require_collaboration()
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        saved = read_record(path); item = task_item(pt.task_state(saved), item_id)
        report = ctx["publishedReport"]
        if item["status"] != "in_review" or not report or report["revision"] != request.reportRevision:
            raise HTTPException(409, "Start the task and select the current published report before drafting an answer.")
        try:
            answer = await guide_patient(read_effective_llm_config(workspace), report=pt.task_model_report(report),
                question=item["requestText"], mode="explain", language=request.language, selected="report", history=[])
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, "The task answer could not be drafted. No answer was published.") from exc
        _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(fresh, request.contextId)
        if answer.get("source") == "safety":
            raise HTTPException(422, "For chest pain, breathing difficulty or fainting, seek urgent medical care. This demo cannot assess symptoms.")
        draft = {"id": digest({"task": item_id, "time": now()}), "reportRevision": request.reportRevision,
                 "text": "\n\n".join(answer[k] for k in ("explanation", "symptoms", "dailyCare", "medication", "limitation") if answer.get(k)), "createdAt": now(),
                 "language": request.language, "source": "llm"}
        def store(state, latest):
            item = task_item(state, item_id)
            if item["status"] != "in_review":
                raise HTTPException(409, "The review task changed. Refresh before continuing.")
            item["answerDraft"] = draft
        state = await asyncio.to_thread(save_patient_task, path, request.expectedRevision, request.reportRevision, store)
        return {"contextId": ctx["contextId"], **state}

    @router.post("/{dataset}/cases/{ecg_id}/patient-tasks/{item_id}/complete-review")
    async def complete_patient_review(dataset: str, ecg_id: int, item_id: str, request: PatientTaskDecision) -> dict:
        require_collaboration()
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        if not request.approved or not request.workId or not request.workKind:
            raise HTTPException(422, "Select actual analysis work and confirm its association with this evidence gap.")
        def finish(state, latest):
            item = task_item(state, item_id)
            options = pt.review_work_options(read_record(path), item, latest)
            work = next((w for w in options if w["kind"] == request.workKind and w["id"] == request.workId), None)
            if item["status"] != "in_review" or not work:
                raise HTTPException(409, "The linked analysis is unavailable or predates this review. Refresh the task.")
            item.update(status="reviewed", reviewedAt=now(), reviewOutcome={
                "id": digest({"task": item_id, "time": now(), "work": work}),
                "reportRevision": latest["revision"], "work": work,
                "unresolved": True, "association": "expert_linked_work_not_proof_of_causation_or_resolution",
                "change": pt.publication_change(item["originalReport"], latest)})
        state = await asyncio.to_thread(save_patient_task, path, request.expectedRevision, request.reportRevision, finish)
        return {"contextId": ctx["contextId"], **state}

    @router.post("/{dataset}/cases/{ecg_id}/patient-tasks/{item_id}/recheck")
    async def recheck_patient_task(dataset: str, ecg_id: int, item_id: str, request: PatientTaskRequest) -> dict:
        require_collaboration()
        workspace, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        item = copy.deepcopy(task_item(pt.task_state(read_record(path)), item_id))
        report = ctx["publishedReport"]
        if not report or report["revision"] != request.reportRevision:
            raise HTTPException(409, "Choose the current published demo report before asking.")
        outcome_id = (item.get("reviewOutcome") or {}).get("id", "")
        if len(item.get("rechecks", [])) >= 10:
            raise HTTPException(422, "This question has reached its retained recheck limit.")
        if (item["reportRevision"] == report["revision"] and not outcome_id or any(
                r["reportRevision"] == report["revision"] and r.get("reviewOutcomeId", "") == outcome_id
                for r in item.get("rechecks", []))):
            raise HTTPException(409, "There is no new published material or review action to recheck.")
        async def guard():
            require_collaboration()
            _, fresh, _ = await asyncio.to_thread(context, dataset, ecg_id)
            check_context(fresh, request.contextId)
            if (not fresh["publishedReport"] or fresh["publishedReport"]["revision"] != request.reportRevision or
                    fresh["patientTasks"]["revision"] != request.expectedRevision):
                raise HTTPException(409, "The report or review task changed during the check. Your question is retained.")
        await guard()
        try:
            result = await asyncio.wait_for(pt.investigate_task(read_effective_llm_config(workspace), report=report,
                previous=item["originalReport"], question=item["question"], label="", language=request.language, guard=guard), timeout=150)
        except HTTPException:
            raise
        except ModelServiceUnavailable as exc:
            raise HTTPException(503, str(exc)) from exc
        except Exception as exc:
            raise HTTPException(503, "The patient check could not finish. Your question and published report are unchanged.") from exc
        await guard()
        def store(state, latest):
            current = task_item(state, item_id)
            current.setdefault("rechecks", []).append({"reportRevision": latest["revision"], "createdAt": now(),
                "investigation": result, "reviewOutcomeId": outcome_id,
                "change": pt.publication_change(current["originalReport"], latest)})
        state = await asyncio.to_thread(save_patient_task, path, request.expectedRevision, request.reportRevision, store)
        return {"contextId": ctx["contextId"], **pt.public_tasks({"patientTasks": state})}

    @router.post("/{dataset}/cases/{ecg_id}/patient-tasks/{item_id}/resolve")
    async def resolve_patient_task(dataset: str, ecg_id: int, item_id: str, request: PatientTaskDecision) -> dict:
        require_collaboration()
        _, ctx, path = await asyncio.to_thread(context, dataset, ecg_id)
        check_context(ctx, request.contextId)
        if not request.approved or len(request.text.strip()) < 10:
            raise HTTPException(422, "Review and approve the answer before publishing it.")
        def resolve(state, latest):
            item = task_item(state, item_id); draft = item.get("answerDraft") or {}
            if (item["status"] != "in_review" or draft.get("id") != request.draftId or
                    draft.get("reportRevision") != latest["revision"]):
                raise HTTPException(409, "The answer draft or published report changed. Generate and review a fresh answer.")
            item.update(status="answered", answeredAt=now(), answer={"text": request.text.strip(),
                "reportRevision": latest["revision"], "reportSnapshot": pt.report_snapshot(latest),
                "change": pt.publication_change(item["originalReport"], latest),
                "unresolved": request.unresolved, "generator": "RecursiveECG", "source": "llm",
                "expertEdited": request.text.strip() != draft["text"].strip(), "expertReviewed": True,
                "reviewAuthority": "demo_review_not_verified_clinical_credentials", "createdAt": now()})
        state = await asyncio.to_thread(save_patient_task, path, request.expectedRevision, request.reportRevision, resolve)
        return {"contextId": ctx["contextId"], **state}

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
