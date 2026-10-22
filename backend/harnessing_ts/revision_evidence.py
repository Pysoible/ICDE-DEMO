"""Deterministic, tuning-only witnesses for a candidate; not clinical similarity search."""
from __future__ import annotations

from harnessing_ts.ecg_demo import ECG_CLASSES
from harnessing_ts.revision_loop import OPS, RevisionData, apply_candidate


def candidate_evidence(data: RevisionData, cand, focus_id: int) -> dict:
    before, after, assessed = apply_candidate(data, cand)
    target = ECG_CLASSES.index(cand.target)
    focus_index = data.index.get(focus_id)
    patient = lambda i: data.patient_ids[i] if data.patient_ids else str(data.ids[i])
    eligible = [i for i in data.subset("tuning") if i != focus_index and
                (focus_index is None or patient(i) != patient(focus_index))]
    conditions = ([{"source": "prob", "name": cand.target, "op": ">=", "value": cand.theta}]
                  if cand.kind == "threshold" else [c.model_dump() for c in cand.conditions])

    def checks(i):
        rows = []
        for c in conditions:
            value = data.probs[i][ECG_CLASSES.index(c["name"])] if c["source"] == "prob" else data.features[i].get(c["name"])
            rows.append({**c, "observed": value, "passes": None if value is None else OPS[c["op"]](value, c["value"])})
        return rows

    def effect(i):
        if not assessed[i]:
            return "unassessable"
        if before[i] == after[i]:
            return "unchanged"
        return "fixed" if after[i] == data.truth[i][target] else "broken"

    def record(i, role):
        decided = list(data.decisions[i]); decided[target] = after[i]
        return {"ecgId": data.ids[i], "role": role, "set": data.half[i],
                "before": [c for c, v in zip(ECG_CLASSES, data.decisions[i]) if v],
                "after": [c for c, v in zip(ECG_CLASSES, decided) if v],
                "targetLabel": data.truth[i][target], "effect": effect(i),
                "checks": checks(i), "assessed": assessed[i]}

    groups = {kind: [i for i in eligible if effect(i) == kind]
              for kind in ("broken", "fixed", "unchanged", "unassessable")}
    examples = []
    # Regressions and supporting changes are deterministic ID-ordered witnesses, not ranked similarity.
    for kind in ("broken", "fixed"):
        if groups[kind]:
            examples.append(record(min(groups[kind], key=lambda i: data.ids[i]), kind))

    def distance(i):
        return sum(abs(c["observed"] - c["value"]) / max(abs(c["value"]), 1.0) for c in checks(i))

    if groups["unchanged"]:
        examples.append(record(min(groups["unchanged"], key=lambda i: (distance(i), data.ids[i])), "boundary"))
    return {"target": cand.target, "focus": record(focus_index, "focus") if focus_index is not None else None,
            "examples": examples, "counts": {key: len(rows) for key, rows in groups.items()},
            "eligibleN": len(eligible), "source": "tuning", "excludesFocusPatient": True,
            "selection": "Lowest ECG ID for changed witnesses; nearest normalized condition boundary for unchanged witnesses. Not clinical similarity or representative sampling.",
            "inputFingerprint": data.input_fingerprint}
