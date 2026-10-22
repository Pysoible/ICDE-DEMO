"""Bounded, published-material investigation and version-linked patient review tasks."""
from __future__ import annotations

import copy
import json
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from harnessing_ts.expert_collaboration import complete_json, prompt
from harnessing_ts.patient_context import patient_context, needs_urgent_guidance, context_quote_candidates
from harnessing_ts.patient_guide import (guide_materials, patient_model_report, validate_patient_wording,
    technical_requested, PatientCareFields, general_education, validate_care_wording, everyday_terms,
    concise_patient_text, validate_context_updates, personal_context_expected, ground_context_updates, validate_followup_question)


class TaskStep(PatientCareFields):
    model_config = ConfigDict(extra="forbid")
    action: Literal["read_report", "inspect_attachments", "compare_publications", "finish"]
    explanation: str = Field(default="", max_length=1600)
    basis: str = Field(default="", max_length=700)
    limitation: str = Field(default="", max_length=900)
    reviewQuestion: str = Field(default="", max_length=500)


def task_state(record: dict) -> dict:
    return record.get("patientTasks", {"revision": 0, "items": []})


def public_tasks(record: dict) -> dict:
    state = copy.deepcopy(task_state(record))
    report = next((r for r in reversed(record.get("reviews", [])) if r.get("status") == "published"), None)
    for item in state["items"]:
        item.pop("answerDraft", None)
        if report and item.get("originalReport"):
            item["currentImpact"] = publication_change(item["originalReport"], report)
    return state


def report_snapshot(report: dict) -> dict:
    return {key: copy.deepcopy(report.get(key)) for key in ("revision", "note", "labels", "features", "updatedAt")}


def task_model_report(report: dict) -> dict:
    """Compatibility name for the shared patient-only prose projection."""
    return patient_model_report(report)


def publication_change(before: dict, after: dict) -> dict:
    old, new = set(before.get("labels") or []), set(after.get("labels") or [])
    features_changed = before.get("features", []) != after.get("features", [])
    return {"beforeRevision": before["revision"], "afterRevision": after["revision"],
            "added": sorted(new-old), "removed": sorted(old-new), "retained": sorted(old & new),
            "textChanged": before.get("note") != after.get("note"),
            "attachmentsChanged": features_changed,
            "kind": "labels_changed" if old != new else "explanation_updated" if before.get("note") != after.get("note") else "evidence_updated" if features_changed else "assessment_retained"}


def review_work_options(record: dict, item: dict, report: dict | None) -> list[dict]:
    """Real operations performed after explicit start, not claims of causation or success."""
    if not item.get("startedAt"):
        return []
    options = []
    for kind, collection, key in (("revision", "revisions", "items"), ("collaboration", "collaboration", "rounds")):
        for work in record.get(collection, {}).get(key, []):
            if (work.get("createdAt", "") >= item["startedAt"] and
                    work["id"] not in item.get("workBaseline", {}).get(kind, []) and
                    work.get("contextId") == item["contextId"] and
                    work.get("baseReportRevision", -1) >= item["reportRevision"]):
                options.append({"kind": kind, "id": work["id"], "createdAt": work["createdAt"],
                                "baseReportRevision": work["baseReportRevision"]})
    if (report and report["revision"] > item.get("workBaseline", {}).get("publishedRevision", item["reportRevision"]) and
            report.get("updatedAt", "") >= item["startedAt"]):
        options.append({"kind": "published_report", "id": str(report["revision"]),
                        "createdAt": report["updatedAt"], "baseReportRevision": report["revision"]})
    return options


def task_clarification(item: dict, report: dict) -> dict:
    """Agent follow-up is available without an expert reply. No unpublished work enters it."""
    recheck = item.get("rechecks", [])[-1] if item.get("rechecks") else None
    current = recheck if recheck and recheck["reportRevision"] == report["revision"] else item if item["reportRevision"] == report["revision"] else None
    investigation = current["investigation"] if current else None
    return {"text": "\n".join(investigation.get(k, "") for k in ("explanation", "symptoms", "dailyCare", "medication", "basis", "limitation") if investigation.get(k)) if investigation else "",
            "question": item["question"], "reportRevision": report["revision"],
            "unresolved": True, "kind": "agent_material_check_not_clinical_verification",
            "change": publication_change(item["originalReport"], report),
            "checks": copy.deepcopy(investigation.get("checks", [])) if investigation else [],
            "currentCheckAvailable": investigation is not None}


def _has_number(value) -> bool:
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        return math.isfinite(value)
    if isinstance(value, dict):
        return any(_has_number(v) for v in value.values())
    if isinstance(value, list):
        return any(_has_number(v) for v in value)
    return False


def check_materials(action: str, report: dict, previous: dict | None) -> dict:
    """Application-computed facts; never infer class validity from an attachment."""
    if action == "read_report":
        return {"action": action, "reportRevision": report["revision"], "labels": report["labels"],
                "hasText": bool((report.get("note") or "").strip()),
                "scope": "published_snapshot_only_not_diagnostic_verification"}
    if action == "inspect_attachments":
        rows = []
        for f in report.get("features", []):
            status = (f.get("judgment") or {}).get("status", f.get("status", "unknown"))
            rows.append({"id": "measurement:"+f["name"], "name": f["name"], "status": status,
                         "hasNumericValue": _has_number(f.get("value")),
                         "warningCount": len(f.get("warnings") or [])})
        return {"action": action, "attachmentCount": len(rows), "rows": rows,
                "scope": "attachment_inventory_not_proof_of_label_or_cause"}
    if action == "compare_publications":
        return {"action": action, "available": previous is not None,
                "change": publication_change(previous, report) if previous else None,
                "scope": "published_versions_only_not_why_a_rule_changed"}
    raise ValueError("Unsupported patient check")


async def investigate_task(config, *, report: dict, previous: dict | None, question: str,
                           label: str, language: str, guard, complete=None) -> dict:
    if needs_urgent_guidance(question):
        raise ValueError('Urgent symptom guidance takes priority over report investigation')
    observations = []
    context = patient_context(question, [], report)
    technical = technical_requested(question)
    response_issue = ""
    for _ in range(4):
        raw = await (complete or complete_json)(config, [
            {"role": "system", "content": prompt("patient-guide") + "\n\n" + prompt("patient-task-next")},
            {"role": "user", "content": json.dumps({"question": question, "selectedLabel": label,
                "patientContext": context,
                "contextQuoteCandidates": context_quote_candidates(question, []),
                "language": language, "materials": guide_materials(task_model_report(report), technical=technical),
                "patientContextExpected": personal_context_expected(question, []),
                "generalEducation": general_education(report),
                "technicalDetailRequested": technical, "responseCorrectionRequired": response_issue,
                "legacyResearchClausesOmitted": task_model_report(report)["researchClausesOmitted"],
                "earlierPublicationAvailable": previous is not None,
                "observations": observations, "remainingChecks": 3-len(observations)}, ensure_ascii=False)}])
        await guard()
        try:
            step = TaskStep.model_validate(raw)
        except ValueError:
            response_issue = 'Return the exact TaskStep schema: contextUpdates has at most THREE distinct exact user quotes; followUpQuestion is one string. No unknown fields. Use the existing observations; do not invent actions.'
            continue
        if step.action == "finish":
            if not observations:
                response_issue = "No actual check has run. Choose read_report, inspect_attachments or compare_publications before finish. Do not claim a check occurred."
                continue
            if not all(x.strip() for x in (step.explanation, step.reviewQuestion)):
                response_issue = "Finish with a useful explanation and reviewQuestion. If no evidence gap was established, say so in reviewQuestion; do not invent one."
                continue
            try:
                for key in ('explanation','symptoms','dailyCare','medication','limitation'):
                    setattr(step,key,concise_patient_text(getattr(step,key)))
                if not step.explanation.strip():
                    raise ValueError('A check must give a useful answer, not boilerplate alone')
                if not technical:
                    for key in ('explanation','symptoms','dailyCare','medication','basis','limitation'):
                        setattr(step,key,everyday_terms(getattr(step,key),language))
                if personal_context_expected(question, []) and not step.contextUpdates:
                    raise ValueError('Include contextUpdates for the actual patient context')
                updates=[u.model_dump() for u in step.contextUpdates]
                ground_context_updates(updates,{k:getattr(step,k) for k in ('explanation','symptoms','dailyCare','medication')})
                validate_context_updates(updates, question, [],
                    [getattr(step,k) for k in ('explanation','symptoms','dailyCare','medication')])
                validate_patient_wording(step.explanation, step.limitation,allow_technical=technical)
                validate_patient_wording(step.basis)
                validate_patient_wording(step.symptoms, step.dailyCare, step.medication,allow_technical=technical)
                validate_care_wording(step.explanation, step.symptoms, step.dailyCare, step.medication)
                validate_patient_wording(step.followUpQuestion,allow_technical=technical)
                validate_care_wording(step.followUpQuestion)
                validate_followup_question(step.followUpQuestion)
                if language == 'zh' and not technical and any(len(getattr(step,k))>limit for k,limit in (('explanation',300),('basis',160),('limitation',90),('symptoms',180),('dailyCare',180),('medication',240))):
                    raise ValueError('Everyday investigation answer is too long')
            except ValueError as exc:
                response_issue = str(exc) + ". Finish with concrete useful meaning/general education: zh explanation<=300, basis<=160, limitation<=90, symptoms/dailyCare<=180, medication<=240 characters. No unrequested technical codes/numbers/research comparisons. No medication doses/schedules. Optional fields may be empty. Name only actually performed check actions; do not perform more checks."
                continue
            return {"checks": observations, "explanation": step.explanation.strip(), "basis": step.basis.strip(),
                    "symptoms": step.symptoms.strip(), "dailyCare": step.dailyCare.strip(), "medication": step.medication.strip(),
                    "contextUpdates": updates,
                    "patientContext": context, "followUpQuestion": step.followUpQuestion.strip(),
                    "limitation": step.limitation.strip(), "reviewQuestion": step.reviewQuestion.strip(),
                    "source": "llm", "changesReport": False}
        if len(observations) >= 3 or any(o["action"] == step.action for o in observations):
            raise ValueError("Repeated or over-budget patient check")
        observations.append(check_materials(step.action, report, previous))
        await guard()
    raise ValueError("Patient investigation did not finish")
