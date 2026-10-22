"""Expert-informed revision loop: a closed candidate space, evaluated deterministically.

Scope and limits (docs/EXPERT_COLLABORATION.md):
- The agent may only propose candidates from a closed space: a per-class decision threshold, or a
  conjunction of up to three numeric conditions on extractor measurements / classifier probabilities
  that adds or removes ONE label. No generated code is executed.
- Every number is computed here, deterministically, from the stored validation probabilities, the
  frozen per-class thresholds, the dataset labels and a precomputed extractor feature table.
- The outcome is an expert-informed CANDIDATE judgment shown beside the original prediction. Original
  predictions are never changed and nothing is published by this module.
- Dataset labels are weak labels. Agreement with a dataset label is not clinical correctness.
"""
from __future__ import annotations

import hashlib
import json
import math
import operator
import time
from concurrent.futures import ProcessPoolExecutor
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Any, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, TypeAdapter, field_validator

from harnessing_ts.ecg_demo import (
    ECG_CLASSES, EcgDemoUnavailable, _latest_complete_iteration, _optional_number, _read_json,
    _read_metadata, _read_npz_array, _truth_value, load_ecg_waveform,
)
from harnessing_ts.reference_feature_extractor import execute_reference_feature_module

TABLE_RELATIVE = Path("state/revision-loop/val-features.json")
TOOL_FILES = ("extractor.py", "manifest.json", "feature-plan.json", "reference-rules.json", "evidence-map.json")


class RevisionUnavailable(RuntimeError):
    """The deterministic inputs are missing, stale or fail reconciliation."""


def _num(x: Any) -> bool:
    return isinstance(x, (int, float)) and not isinstance(x, bool) and math.isfinite(x)


def tool_version(workspace: Path) -> str:
    """Same fingerprint the demo uses for its context id, so a stale table is detectable."""
    folder = workspace / "tools/reference-feature-extractor"
    parts = {name: hashlib.sha256((folder / name).read_bytes()).hexdigest() if (folder / name).is_file() else None
             for name in TOOL_FILES}
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()[:12]


def flatten_features(output: dict[str, Any]) -> dict[str, float]:
    """Numeric scalars (and one level of numeric dict fields) become flat, named columns."""
    cols: dict[str, float] = {}
    for feature in output.get("features", []):
        name, value = str(feature.get("name", "")), feature.get("value")
        if isinstance(value, bool):
            cols[name] = 1.0 if value else 0.0
        elif _num(value):
            cols[name] = float(value)
        elif isinstance(value, dict):
            for key, item in value.items():
                if isinstance(item, bool):
                    cols[f"{name}.{key}"] = 1.0 if item else 0.0
                elif _num(item):
                    cols[f"{name}.{key}"] = float(item)
    return cols


# ---------------------------------------------------------------- feature table

def _extract_one(job: tuple[str, int, Any]) -> tuple[int, dict[str, float] | None, str]:
    workspace, ecg_id, age = job
    try:
        wave = load_ecg_waveform(Path(workspace), ecg_id)
        tool_input = {"ecg_id": ecg_id, "age": age, "sex": None, "fs": wave["sampleRate"],
                      "lead_names": [lead["name"] for lead in wave["leads"]],
                      "waveform": [[round(v * 1000, 6) for v in lead["values"]] for lead in wave["leads"]]}
        return ecg_id, flatten_features(execute_reference_feature_module(Path(workspace), tool_input)), ""
    except Exception as exc:  # a failed record is reported, never guessed
        return ecg_id, None, str(exc)[:200]


def build_feature_table(workspace: Path, workers: int = 4, log=print) -> Path:
    """Runs the deterministic extractor over every validation record, once, offline."""
    iteration = _latest_complete_iteration(workspace)
    version = tool_version(workspace)
    ids, _ = _read_npz_array(iteration / "val_probs.npz", "ids")
    metadata = _read_metadata(workspace)
    jobs = [(str(workspace), int(i), _optional_number(metadata.get(int(i), {}).get("age"))) for i in ids]
    started, rows, failed = time.time(), {}, {}
    with ProcessPoolExecutor(max_workers=workers) as pool:
        for n, (ecg_id, cols, err) in enumerate(pool.map(_extract_one, jobs, chunksize=8), 1):
            if cols is None:
                failed[str(ecg_id)] = err
            else:
                rows[str(ecg_id)] = cols
            if n % 250 == 0:
                log(f"{n}/{len(jobs)} records, {time.time() - started:.0f}s")
    columns = sorted({c for r in rows.values() for c in r})
    if tool_version(workspace) != version or _latest_complete_iteration(workspace) != iteration:
        raise RevisionUnavailable("The extractor or iteration changed during the build. Rebuild the feature table.")
    table = {"schema": 1, "iteration": iteration.name, "toolVersion": version,
             "builtAt": datetime.now(timezone.utc).isoformat(), "columns": columns, "rows": rows, "failed": failed}
    path = workspace / TABLE_RELATIVE
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(table, ensure_ascii=False))
    temp.replace(path)
    log(f"wrote {path} rows={len(rows)} failed={len(failed)} columns={len(columns)} in {time.time() - started:.0f}s")
    return path


# ---------------------------------------------------------------- data + reconciliation

def _confusion(decided: list[bool], truth: list[bool], idx: list[int]) -> dict[str, Any]:
    tp = fp = fn = tn = 0
    for i in idx:
        if decided[i] and truth[i]: tp += 1
        elif decided[i]: fp += 1
        elif truth[i]: fn += 1
        else: tn += 1
    precision = tp / (tp + fp) if tp + fp else 0.0
    recall = tp / (tp + fn) if tp + fn else 0.0
    f1 = 2 * precision * recall / (precision + recall) if precision + recall else 0.0
    return {"tp": tp, "fp": fp, "fn": fn, "tn": tn, "precision": round(precision, 6), "recall": round(recall, 6), "f1": round(f1, 6)}


@dataclass
class RevisionData:
    iteration: str
    tool_version: str
    ids: list[int]
    probs: list[list[float]]
    thresholds: dict[str, float]
    truth: list[list[bool]]
    half: list[str]                       # "tuning" or "holdout", by patient
    features: list[dict[str, float]]
    columns: list[str]
    decisions: list[list[bool]]           # baseline: prob >= frozen threshold
    index: dict[int, int]
    reconciliation: dict[str, Any]
    input_fingerprint: str = ""
    patient_ids: list[str] = field(default_factory=list)

    def subset(self, name: str) -> list[int]:
        return list(range(len(self.ids))) if name == "all" else [i for i, h in enumerate(self.half) if h == name]


def patient_half(patient_id: str) -> str:
    """Patient-disjoint, deterministic split of the validation fold."""
    key = str(int(float(patient_id))) if patient_id not in ("", None) else "unknown"
    return "tuning" if int(hashlib.sha1(key.encode()).hexdigest(), 16) % 2 == 0 else "holdout"


_CACHE: dict[tuple, RevisionData] = {}


def input_fingerprint(workspace: Path, iteration: Path) -> str:
    paths = [workspace / TABLE_RELATIVE, iteration / "metrics_formal.json", iteration / "val_probs.npz",
             workspace / "data/processed/ptbxl_meta_labels.csv"]
    try:
        parts = [hashlib.sha256(p.read_bytes()).hexdigest() for p in paths]
        return hashlib.sha256(json.dumps([tool_version(workspace), *parts]).encode()).hexdigest()
    except OSError as exc:
        raise RevisionUnavailable("Revision inputs are unavailable. Rebuild or restore the validation artifacts.") from exc


def for_review(data: RevisionData, focus_id: int) -> RevisionData:
    """Never score a patient shown to the agent as an unseen holdout patient."""
    i = data.index.get(focus_id)
    if i is None or data.half[i] != "holdout":
        return data
    patient = data.patient_ids[i] if data.patient_ids else str(focus_id)
    half = ["review" if h == "holdout" and (data.patient_ids[j] if data.patient_ids else str(e)) == patient else h
            for j, (e, h) in enumerate(zip(data.ids, data.half))]
    return replace(data, half=half)


def load_revision_data(workspace: Path) -> RevisionData:
    iteration = _latest_complete_iteration(workspace)
    table_path = workspace / TABLE_RELATIVE
    if not table_path.is_file():
        raise RevisionUnavailable("The validation feature table has not been built. Run the offline build step first.")
    # Check content and the extractor BEFORE cache lookup, including same-mtime rewrites.
    version = tool_version(workspace)
    fingerprint = input_fingerprint(workspace, iteration)
    key = (str(workspace), iteration.name, version, fingerprint)
    if key in _CACHE:
        return _CACHE[key]
    table = json.loads(table_path.read_text())
    if table.get("iteration") != iteration.name or table.get("toolVersion") != version:
        raise RevisionUnavailable("The feature table is stale (iteration or extractor changed). Rebuild it.")
    metrics = _read_json(iteration / "metrics_formal.json")
    ids_raw, _ = _read_npz_array(iteration / "val_probs.npz", "ids")
    flat, shape = _read_npz_array(iteration / "val_probs.npz", "probs")
    meta = _read_metadata(workspace)
    ids = [int(i) for i in ids_raw]
    if shape != (len(ids), len(ECG_CLASSES)):
        raise RevisionUnavailable("Validation probabilities have an unexpected shape.")
    probs = [[float(x) for x in flat[i * 5:(i + 1) * 5]] for i in range(len(ids))]
    thresholds = {c: float(metrics["thresholds"][c]) for c in ECG_CLASSES}
    truth = [[_truth_value(meta[i], c) for c in ECG_CLASSES] for i in ids]
    half = [patient_half(meta[i].get("patient_id", "")) for i in ids]
    rows = table["rows"]
    features = [rows.get(str(i), {}) for i in ids]
    decisions = [[p[k] >= thresholds[c] for k, c in enumerate(ECG_CLASSES)] for p in probs]
    # Reconcile against the authoritative metrics artifact before any candidate is evaluated.
    allidx = list(range(len(ids)))
    mismatches, f1s = [], []
    for k, ref in enumerate(metrics["per_class"]):
        got = _confusion([d[k] for d in decisions], [t[k] for t in truth], allidx)
        f1s.append(got["f1"])
        for field, name in (("tp", "TP"), ("fp", "FP"), ("fn", "FN"), ("tn", "TN")):
            if got[field] != ref[name]:
                mismatches.append(f"{ref['class']}.{name}: recomputed {got[field]} != recorded {ref[name]}")
    macro = round(sum(f1s) / len(f1s), 6)
    if abs(macro - float(metrics["macro_f1"])) > 1e-5:
        mismatches.append(f"macro_f1: recomputed {macro} != recorded {metrics['macro_f1']}")
    if mismatches:
        raise RevisionUnavailable("Baseline does not reconcile with metrics_formal.json: " + "; ".join(mismatches[:4]))
    data = RevisionData(iteration.name, version, ids, probs, thresholds, truth, half, features, list(table["columns"]),
                        decisions, {e: n for n, e in enumerate(ids)},
                        {"reconciled": True, "checked": ["per-class TP/FP/FN/TN", "macro_f1"], "iteration": iteration.name,
                         "macroF1": macro, "n": len(ids), "missingFeatureRows": sum(1 for f in features if not f)},
                        fingerprint, [str(int(float(meta[i]["patient_id"]))) if meta[i].get("patient_id") else f"record-{i}" for i in ids])
    if input_fingerprint(workspace, iteration) != fingerprint:
        raise RevisionUnavailable("Revision inputs changed while loading. Refresh before continuing.")
    _CACHE.clear()
    _CACHE[key] = data
    return data


# ---------------------------------------------------------------- candidates (closed space)

OPS = {">=": operator.ge, ">": operator.gt, "<=": operator.le, "<": operator.lt}


class Condition(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    source: Literal["feature", "prob"]
    name: str = Field(min_length=1, max_length=80)
    op: Literal[">=", ">", "<=", "<"]
    value: float = Field(ge=-100000, le=100000)


class ThresholdCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    kind: Literal["threshold"]
    target: Literal["NORM", "MI", "STTC", "CD", "HYP"]
    theta: float = Field(gt=0, lt=1)
    rationale: str = Field(min_length=3, max_length=800)


class CriterionCandidate(BaseModel):
    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)
    kind: Literal["criterion"]
    target: Literal["NORM", "MI", "STTC", "CD", "HYP"]
    action: Literal["add_label", "remove_label"]
    conditions: list[Condition] = Field(min_length=1, max_length=3)
    rationale: str = Field(min_length=3, max_length=800)


Candidate = Annotated[Union[ThresholdCandidate, CriterionCandidate], Field(discriminator="kind")]
_candidate_adapter = TypeAdapter(Candidate)


def parse_candidate(raw: Any, data: RevisionData):
    """Validates shape AND that every referenced column / class really exists. Never evaluates text."""
    cand = _candidate_adapter.validate_python(raw)
    if cand.kind == "criterion":
        for c in cand.conditions:
            if c.source == "feature" and c.name not in data.columns:
                raise ValueError(f"Unknown measurement column: {c.name}")
            if c.source == "prob":
                if c.name not in ECG_CLASSES:
                    raise ValueError(f"Unknown class for probability condition: {c.name}")
                if not 0 <= c.value <= 1:
                    raise ValueError("Probability conditions must use a value between 0 and 1.")
    return cand


def apply_candidate(data: RevisionData, cand) -> tuple[list[bool], list[bool], list[bool]]:
    """Returns (before, after, assessed) for the target class over every validation record."""
    t = ECG_CLASSES.index(cand.target)
    before = [d[t] for d in data.decisions]
    n = len(before)
    if cand.kind == "threshold":
        return before, [p[t] >= cand.theta for p in data.probs], [True] * n
    after, assessed = [], []
    for i in range(n):
        outcomes, usable = [], True
        for c in cand.conditions:
            v = data.probs[i][ECG_CLASSES.index(c.name)] if c.source == "prob" else data.features[i].get(c.name)
            if v is None:
                usable = False
                break
            outcomes.append(OPS[c.op](v, c.value))
        if not usable:  # missing measurement: keep the original decision, say so
            after.append(before[i])
            assessed.append(False)
            continue
        matched = all(outcomes)
        after.append((before[i] or matched) if cand.action == "add_label" else (before[i] and not matched))
        assessed.append(True)
    return before, after, assessed


# ---------------------------------------------------------------- deterministic evaluation

def _subset_summary(data: RevisionData, t: int, before: list[bool], after: list[bool], assessed: list[bool], name: str) -> dict:
    idx = data.subset(name)
    truth = [tr[t] for tr in data.truth]
    base, rev = _confusion(before, truth, idx), _confusion(after, truth, idx)
    f1s = [_confusion([d[k] for d in data.decisions], [tr[k] for tr in data.truth], idx)["f1"] for k in range(len(ECG_CLASSES))]
    macro_before = sum(f1s) / len(f1s)
    f1s[t] = rev["f1"]
    macro_after = sum(f1s) / len(f1s)
    fixed = sum(1 for i in idx if before[i] != truth[i] and after[i] == truth[i])
    broken = sum(1 for i in idx if before[i] == truth[i] and after[i] != truth[i])
    return {"n": len(idx), "baseline": base, "revised": rev, "fixed": fixed, "broken": broken,
            "changed": sum(1 for i in idx if before[i] != after[i]),
            "unassessable": sum(1 for i in idx if not assessed[i]),
            "macroF1": {"baseline": round(macro_before, 6), "revised": round(macro_after, 6)}}


def _outcome(summary: dict) -> str:
    """Record-level agreement AND the target-class F1 must agree; otherwise the honest answer is 'mixed'."""
    if summary["changed"] == 0:
        return "no_change"
    net = summary["fixed"] - summary["broken"]
    df1 = round(summary["revised"]["f1"] - summary["baseline"]["f1"], 6)
    if net > 0:
        return "gain" if df1 >= 0 else "mixed"
    if net < 0:
        return "loss" if df1 <= 0 else "mixed"
    return "neutral" if df1 == 0 else "mixed"


def evaluate(data: RevisionData, cand, max_flips: int = 300) -> dict:
    t = ECG_CLASSES.index(cand.target)
    before, after, assessed = apply_candidate(data, cand)
    subsets = {name: _subset_summary(data, t, before, after, assessed, name) for name in ("tuning", "holdout", "all")}
    flips = []
    for i, e in enumerate(data.ids):
        if before[i] != after[i]:
            label = data.truth[i][t]
            flips.append({"ecgId": e, "set": data.half[i], "before": before[i], "after": after[i], "label": label,
                          "effect": "fixed" if after[i] == label else "broken"})
    flips.sort(key=lambda f: (f["effect"] != "broken", f["ecgId"]))
    # Mechanical verdict, never model prose. Holdout is the only generalization evidence.
    verdict = {name: _outcome(subsets[name]) for name in ("tuning", "holdout")}
    return {"target": cand.target, "subsets": subsets, "verdict": verdict, "flipCount": len(flips),
            "flips": flips[:max_flips], "flipsTruncated": len(flips) > max_flips}


def focus_view(data: RevisionData, cand, ecg_id: int) -> dict | None:
    i = data.index.get(ecg_id)
    if i is None:
        return None
    t = ECG_CLASSES.index(cand.target)
    before, after, assessed = apply_candidate(data, cand)
    decided_after = list(data.decisions[i])
    decided_after[t] = after[i]
    label = data.truth[i][t]
    effect = "unassessable" if not assessed[i] else "unchanged" if before[i] == after[i] else ("fixed" if after[i] == label else "broken")
    return {"ecgId": ecg_id, "truth": [c for c, v in zip(ECG_CLASSES, data.truth[i]) if v],
            "before": [c for c, v in zip(ECG_CLASSES, data.decisions[i]) if v],
            "after": [c for c, v in zip(ECG_CLASSES, decided_after) if v],
            "probs": {c: round(p, 4) for c, p in zip(ECG_CLASSES, data.probs[i])},
            "measurements": {k: round(v, 3) for k, v in data.features[i].items()},
            "targetLabel": label, "effect": effect}


def column_stats(data: RevisionData) -> dict[str, dict]:
    """Distribution of every measurement on the TUNING half only (the holdout is never shown to the agent)."""
    idx = data.subset("tuning")
    stats = {}
    for col in data.columns:
        values = sorted(data.features[i][col] for i in idx if col in data.features[i])
        if not values:
            continue
        q = lambda f: values[min(len(values) - 1, int(f * (len(values) - 1) + 0.5))]  # noqa: E731
        stats[col] = {"n": len(values), "missing": len(idx) - len(values), "min": round(values[0], 3), "p25": round(q(.25), 3),
                      "median": round(q(.5), 3), "p75": round(q(.75), 3), "max": round(values[-1], 3)}
    return stats


def tuning_digest(ev: dict) -> dict:
    """What the agent is allowed to see after an evaluation: tuning-set numbers only."""
    t = ev["subsets"]["tuning"]
    sample = [f for f in ev["flips"] if f["set"] == "tuning"][:6]
    return {"baseline": t["baseline"], "revised": t["revised"], "fixed": t["fixed"], "broken": t["broken"],
            "changed": t["changed"], "unassessable": t["unassessable"], "sampleFlips": sample}


# ---------------------------------------------------------------- bounded agent loop

MAX_EVALUATIONS = 3


class RevisionStep(BaseModel):
    model_config = ConfigDict(extra="forbid")
    action: Literal["evaluate", "finish", "cannot_express"]
    candidate: dict[str, Any] | None = None
    chosen: int | None = None
    explanation: str = Field(default="", max_length=1500)
    missing: str = Field(default="", max_length=400)

    @field_validator("explanation", "missing", mode="before")
    @classmethod
    def _null_text_is_empty(cls, value: Any) -> Any:
        return "" if value is None else value   # models write null for unused text fields


def focus_baseline(data: RevisionData, ecg_id: int) -> dict | None:
    i = data.index.get(ecg_id)
    if i is None:
        return None
    return {"ecgId": ecg_id, "truth": [c for c, v in zip(ECG_CLASSES, data.truth[i]) if v],
            "predicted": [c for c, v in zip(ECG_CLASSES, data.decisions[i]) if v],
            "probs": {c: round(p, 4) for c, p in zip(ECG_CLASSES, data.probs[i])},
            "measurements": {k: round(v, 3) for k, v in data.features[i].items()}}


def class_baseline(data: RevisionData, subset: str = "tuning") -> dict:
    idx = data.subset(subset)
    return {c: _confusion([d[k] for d in data.decisions], [tr[k] for tr in data.truth], idx) for k, c in enumerate(ECG_CLASSES)}


def describe_error(exc: Exception) -> str:
    """Short 'field: reason' text for the agent, without library help links."""
    errors = getattr(exc, "errors", None)
    if callable(errors):
        try:
            return "; ".join(f"{'.'.join(str(x) for x in e['loc'])}: {e['msg']}" for e in errors()[:3])[:240]
        except Exception:
            pass
    return str(exc)[:240]


async def run_revision(config: Any, data: RevisionData, *, focus_id: int, opinion: str, guard,
                       history: list[dict] | None = None, evidence_context: dict | None = None) -> dict:
    """Observation-driven search over the closed candidate space. All numbers come from evaluate()."""
    from harnessing_ts.expert_collaboration import complete_json, prompt  # local: avoids import cycles at module load
    from harnessing_ts.revision_evidence import candidate_evidence
    data = for_review(data, focus_id)
    focus = focus_baseline(data, focus_id)
    if focus is None:
        raise ValueError("This record is not part of the validation set used by the revision loop.")
    context = {"opinion": opinion, "focusCase": focus, "classes": list(ECG_CLASSES), "frozenThresholds": data.thresholds,
               "baselineOnTuningSet": class_baseline(data), "columns": column_stats(data),
               "tuningSetSize": len(data.subset("tuning")), "previousFeedback": (history or [])[-4:],
               "evidenceContext": evidence_context or {}}
    system = prompt("system") + "\n" + prompt("revise-next")
    trace: list[dict] = []          # what the agent is told: tuning numbers or the rejection reason
    kept: list[tuple[Any, dict]] = []  # (candidate, full evaluation) for every valid evaluate step
    seen: set[str] = set()
    stop, decision = "budget", None
    for call in range(MAX_EVALUATIONS + 1):
        raw = await complete_json(config, [{"role": "system", "content": system},
            {"role": "user", "content": json.dumps({**context, "executed": trace,
                                                     "remainingEvaluations": max(0, MAX_EVALUATIONS - len(trace))}, ensure_ascii=False)}])
        await guard()
        step = RevisionStep.model_validate(raw)
        if step.action != "evaluate":
            stop, decision = step.action, step
            break
        if call == MAX_EVALUATIONS:
            stop = "budget"
            break
        try:
            cand = parse_candidate(step.candidate, data)
        except ValueError as exc:       # a rejected candidate costs a step and is shown to the agent
            trace.append({"index": len(trace) + 1, "candidate": step.candidate, "error": describe_error(exc)})
            continue
        key = json.dumps(cand.model_dump(exclude={"rationale"}), sort_keys=True)
        if key in seen:
            trace.append({"index": len(trace) + 1, "candidate": cand.model_dump(), "error": "Identical to an earlier candidate."})
            stop = "duplicate"
            break
        seen.add(key)
        ev = evaluate(data, cand)
        kept.append((cand, ev))
        trace.append({"index": len(trace) + 1, "candidate": cand.model_dump(), "reason": step.explanation[:240],
                      "tuning": tuning_digest(ev), "caseEvidence": candidate_evidence(data, cand, focus_id), "evaluated": len(kept)})
    chosen_no = None
    note = {"duplicate": "The agent repeated a tested candidate. Search stopped without a recommendation; inspect the actual test evidence.",
            "budget": "The bounded search ended without a final recommendation. Tested candidates remain inspectable."}.get(stop, "")
    if stop == "finish":
        n = decision.chosen
        if n is not None and 1 <= n <= len(kept):
            chosen_no = n
        elif n is not None:
            note = "The agent named an evaluation that does not exist, so no candidate is recommended."
    attempts = []
    for k, (cand, ev) in enumerate(kept, 1):
        attempts.append({"index": k, "candidate": cand.model_dump(), "reason": next((t.get("reason", "") for t in trace if t.get("evaluated") == k), ""),
                         "subsets": ev["subsets"], "verdict": ev["verdict"], "flipCount": ev["flipCount"],
                         "caseEvidence": candidate_evidence(data, cand, focus_id),
                         "focus": focus_view(data, cand, focus_id), "chosen": k == chosen_no})
    chosen = kept[chosen_no - 1] if chosen_no else None
    return {"opinion": opinion, "stopReason": stop, "explanation": decision.explanation if decision else "", "notice": note,
            "missing": decision.missing if decision and stop == "cannot_express" else "",
            "chosen": chosen_no, "candidate": chosen[0].model_dump() if chosen else None,
            "attempts": attempts, "rejected": [t for t in trace if "error" in t],
            "evaluation": chosen[1] if chosen else None, "focus": focus_view(data, chosen[0], focus_id) if chosen else None,
            "focusBaseline": focus,
            "frozenThresholds": dict(data.thresholds),
            "dataInfo": {"iteration": data.iteration, "toolVersion": data.tool_version, "n": len(data.ids),
                         "tuningN": len(data.subset("tuning")), "holdoutN": len(data.subset("holdout")),
                         "reviewN": len(data.subset("review")), "inputFingerprint": data.input_fingerprint,
                         "reconciliation": data.reconciliation},
            "changesPredictions": False, "published": False}


if __name__ == "__main__":  # python -m harnessing_ts.revision_loop build --workspace PATH [--workers N]
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["build", "check"])
    parser.add_argument("--workspace", required=True)
    parser.add_argument("--workers", type=int, default=4)
    args = parser.parse_args()
    ws = Path(args.workspace).expanduser().resolve()
    if args.command == "build":
        build_feature_table(ws, args.workers)
    d = load_revision_data(ws)
    sizes = {h: len(d.subset(h)) for h in ("tuning", "holdout", "all")}
    print(json.dumps({"iteration": d.iteration, "toolVersion": d.tool_version, "sizes": sizes,
                      "columns": d.columns, "reconciliation": d.reconciliation}, ensure_ascii=False, indent=1))
