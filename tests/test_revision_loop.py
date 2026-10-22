from __future__ import annotations

import os
import json
from pathlib import Path

import pytest

from harnessing_ts import revision_loop as rl
from harnessing_ts.ecg_demo import ECG_CLASSES


def make_data(rows):
    """rows: dicts with id, half, probs (5), truth (5 bools), features."""
    thresholds = {c: 0.5 for c in ECG_CLASSES}
    probs = [r["probs"] for r in rows]
    return rl.RevisionData(
        iteration="t", tool_version="v", ids=[r["id"] for r in rows], probs=probs, thresholds=thresholds,
        truth=[r["truth"] for r in rows], half=[r["half"] for r in rows], features=[r.get("features", {}) for r in rows],
        columns=sorted({k for r in rows for k in r.get("features", {})}),
        decisions=[[p >= 0.5 for p in pr] for pr in probs],
        index={r["id"]: n for n, r in enumerate(rows)}, reconciliation={"reconciled": True})


def row(i, half, p_cd, truth_cd, **features):
    return {"id": i, "half": half, "probs": [0.1, 0.1, 0.1, p_cd, 0.1],
            "truth": [False, False, False, truth_cd, False], "features": features}


CD = ECG_CLASSES.index("CD")


def threshold(theta):
    return rl.parse_candidate({"kind": "threshold", "target": "CD", "theta": theta, "rationale": "test"}, DATA)


DATA = make_data([
    row(1, "tuning", 0.45, True, **{"qrs": 120.0}),    # missed by baseline; a lower theta fixes it
    row(2, "tuning", 0.45, False, **{"qrs": 80.0}),    # correct "no"; a lower theta breaks it
    row(3, "tuning", 0.9, True, **{"qrs": 130.0}),     # correct "yes"
    row(4, "holdout", 0.45, False, **{"qrs": 85.0}),   # breaks under the lower theta
    row(5, "holdout", 0.45, False, **{"qrs": 90.0}),   # breaks under the lower theta
    row(6, "holdout", 0.2, False),                     # no measurement at all
])


def test_threshold_flips_are_exactly_fixed_or_broken_and_totals_reconcile():
    ev = rl.evaluate(DATA, threshold(0.4))
    tuning, holdout = ev["subsets"]["tuning"], ev["subsets"]["holdout"]
    assert (tuning["fixed"], tuning["broken"], tuning["changed"]) == (1, 1, 2)
    assert (holdout["fixed"], holdout["broken"], holdout["changed"]) == (0, 2, 2)
    for s in ev["subsets"].values():
        assert s["changed"] == s["fixed"] + s["broken"]
    assert ev["flipCount"] == 4 and {f["effect"] for f in ev["flips"]} == {"fixed", "broken"}
    assert ev["flips"][0]["effect"] == "broken"           # regressions are listed first, never hidden
    # tuning: equal counts but F1 rises (mixed); holdout: two new false positives (loss)
    assert ev["verdict"] == {"tuning": "mixed", "holdout": "loss"}


def test_criterion_add_and_remove_and_missing_measurement_is_not_assessable():
    add = rl.parse_candidate({"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "test",
                              "conditions": [{"source": "feature", "name": "qrs", "op": ">=", "value": 100}]}, DATA)
    ev = rl.evaluate(DATA, add)
    assert ev["subsets"]["tuning"]["fixed"] == 1 and ev["subsets"]["tuning"]["broken"] == 0   # id 1 gains CD
    assert ev["subsets"]["holdout"]["unassessable"] == 1                                      # id 6 has no qrs
    assert [f["ecgId"] for f in ev["flips"]] == [1]
    remove = rl.parse_candidate({"kind": "criterion", "target": "CD", "action": "remove_label", "rationale": "test",
                                 "conditions": [{"source": "prob", "name": "CD", "op": ">=", "value": 0.8}]}, DATA)
    ev2 = rl.evaluate(DATA, remove)
    assert ev2["subsets"]["tuning"]["broken"] == 1 and ev2["subsets"]["tuning"]["fixed"] == 0  # id 3 loses a true CD
    assert ev2["verdict"]["tuning"] == "loss"


def test_no_change_candidate_is_reported_as_no_change_not_improvement():
    ev = rl.evaluate(DATA, threshold(0.5))
    assert ev["flipCount"] == 0 and ev["verdict"] == {"tuning": "no_change", "holdout": "no_change"}


@pytest.mark.parametrize("raw", [
    {"kind": "threshold", "target": "CD", "theta": 1.5, "rationale": "x"},
    {"kind": "threshold", "target": "XX", "theta": .4, "rationale": "x"},
    {"kind": "threshold", "target": "CD", "theta": .4, "rationale": "x", "extra": 1},
    {"kind": "code", "target": "CD", "rationale": "x"},
    {"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "x", "conditions": []},
    {"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "x",
     "conditions": [{"source": "feature", "name": "qrs", "op": ">=", "value": 1}] * 4},
    {"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "x",
     "conditions": [{"source": "feature", "name": "no_such_column", "op": ">=", "value": 1}]},
    {"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "x",
     "conditions": [{"source": "prob", "name": "ZZ", "op": ">=", "value": .5}]},
    {"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "x",
     "conditions": [{"source": "prob", "name": "MI", "op": ">=", "value": 3}]},
    {"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "x",
     "conditions": [{"source": "feature", "name": "qrs", "op": "==", "value": 1}]},
])
def test_candidate_space_is_closed(raw):
    with pytest.raises(ValueError):          # pydantic ValidationError is a ValueError
        rl.parse_candidate(raw, DATA)


def test_agent_only_sees_tuning_half():
    data = make_data([row(1, "tuning", .1, False, **{"qrs": 100.0}), row(2, "holdout", .1, False, **{"qrs": 9999.0})])
    stats = rl.column_stats(data)
    assert stats["qrs"]["max"] == 100.0 and stats["qrs"]["n"] == 1
    ev = rl.evaluate(DATA, threshold(0.4))
    digest = rl.tuning_digest(ev)
    assert all(f["set"] == "tuning" for f in digest["sampleFlips"])
    assert set(digest) == {"baseline", "revised", "fixed", "broken", "changed", "unassessable", "sampleFlips"}


def test_patient_halves_are_deterministic_disjoint_and_balanced():
    assert rl.patient_half("15709.0") == rl.patient_half("15709")
    halves = [rl.patient_half(str(i)) for i in range(2000)]
    assert 0.45 < halves.count("tuning") / len(halves) < 0.55


def test_focus_view_effects():
    cand = threshold(0.4)
    assert rl.focus_view(DATA, cand, 1)["effect"] == "fixed" and rl.focus_view(DATA, cand, 1)["after"] == ["CD"]
    assert rl.focus_view(DATA, cand, 2)["effect"] == "broken"
    assert rl.focus_view(DATA, cand, 3)["effect"] == "unchanged"
    assert rl.focus_view(DATA, cand, 999) is None
    unassessable = rl.parse_candidate({"kind": "criterion", "target": "CD", "action": "add_label", "rationale": "test",
                                       "conditions": [{"source": "feature", "name": "qrs", "op": ">=", "value": 1}]}, DATA)
    assert rl.focus_view(DATA, unassessable, 6)["effect"] == "unassessable"


def test_flatten_features_keeps_only_numeric_scalars():
    out = {"features": [{"name": "pr", "value": 190.0}, {"name": "qrs", "value": {"qrs_ms": 100.0, "lead": "V3", "ok": True, "nested": {"a": 1}}},
                        {"name": "missing", "value": None}, {"name": "flag", "value": False}]}
    assert rl.flatten_features(out) == {"pr": 190.0, "qrs.qrs_ms": 100.0, "qrs.ok": 1.0, "flag": 0.0}


REAL = os.environ.get("REVISION_TEST_WORKSPACE")


@pytest.mark.skipif(not REAL or not (Path(REAL) / rl.TABLE_RELATIVE).is_file(), reason="needs a built feature table")
def test_real_workspace_baseline_reconciles_and_candidates_evaluate():
    data = rl.load_revision_data(Path(REAL))
    assert data.reconciliation["reconciled"] and len(data.ids) == 2193
    assert len(data.subset("tuning")) + len(data.subset("holdout")) == len(data.ids)
    cand = rl.parse_candidate({"kind": "threshold", "target": "CD", "theta": data.thresholds["CD"], "rationale": "identity"}, data)
    assert rl.evaluate(data, cand)["flipCount"] == 0      # the frozen threshold changes nothing


def test_verdict_requires_count_and_f1_to_agree():
    base = {"changed": 4, "fixed": 3, "broken": 1, "baseline": {"f1": 0.80}, "revised": {"f1": 0.85}}
    assert rl._outcome(base) == "gain"
    assert rl._outcome({**base, "revised": {"f1": 0.79}}) == "mixed"          # more fixed than broken, but F1 fell
    assert rl._outcome({**base, "fixed": 1, "broken": 3, "revised": {"f1": 0.7}}) == "loss"
    assert rl._outcome({**base, "fixed": 1, "broken": 3, "revised": {"f1": 0.9}}) == "mixed"
    assert rl._outcome({**base, "fixed": 2, "broken": 2, "revised": {"f1": 0.80}}) == "neutral"
    assert rl._outcome({**base, "changed": 0}) == "no_change"


def test_reviewed_patient_is_not_counted_as_unseen_holdout():
    data = make_data([row(1, "holdout", .4, True), row(2, "holdout", .4, False),
                      row(3, "holdout", .4, False), row(4, "tuning", .4, True)])
    data.patient_ids = ["10", "10", "11", "12"]
    reviewed = rl.for_review(data, 1)
    assert reviewed.half == ["review", "review", "holdout", "tuning"]
    assert data.half == ["holdout", "holdout", "holdout", "tuning"]
    assert reviewed.subset("all") == [0, 1, 2, 3]


@pytest.fixture
def cached_inputs(tmp_path, monkeypatch):
    rl._CACHE.clear()
    iteration = tmp_path / "iteration-001"; iteration.mkdir()
    (iteration / "val_probs.npz").write_bytes(b"probs fixture")
    metrics = {"thresholds": {c: .5 for c in ECG_CLASSES}, "macro_f1": 0,
               "per_class": [{"class": c, "TP": 0, "FP": 0, "FN": 0, "TN": 1} for c in ECG_CLASSES]}
    (iteration / "metrics_formal.json").write_text(json.dumps(metrics))
    meta_path = tmp_path / "data/processed/ptbxl_meta_labels.csv"
    meta_path.parent.mkdir(parents=True); meta_path.write_text("metadata fixture")
    tool = tmp_path / "tools/reference-feature-extractor/extractor.py"
    tool.parent.mkdir(parents=True); tool.write_text("# version 1")
    table = tmp_path / rl.TABLE_RELATIVE; table.parent.mkdir(parents=True)
    table.write_text(json.dumps({"iteration": iteration.name, "toolVersion": rl.tool_version(tmp_path),
                                 "columns": ["qrs"], "rows": {"1": {"qrs": 100}}}))
    monkeypatch.setattr(rl, "_latest_complete_iteration", lambda _: iteration)
    monkeypatch.setattr(rl, "_read_npz_array", lambda _, name: ([1], (1,)) if name == "ids" else ([.1]*5, (1, 5)))
    monkeypatch.setattr(rl, "_read_metadata", lambda _: {1: {"patient_id": "10", **{c: False for c in ECG_CLASSES}}})
    monkeypatch.setattr(rl, "_truth_value", lambda m, c: m[c])
    yield tmp_path, iteration, table, tool, meta_path
    rl._CACHE.clear()


def rewrite_same_mtime(path, content):
    stat = path.stat(); path.write_text(content)
    os.utime(path, ns=(stat.st_atime_ns, stat.st_mtime_ns))


def test_cache_checks_extractor_even_when_table_and_mtime_are_unchanged(cached_inputs):
    ws, _, table, tool, _ = cached_inputs
    data = rl.load_revision_data(ws)
    assert rl.load_revision_data(ws) is data
    rewrite_same_mtime(tool, "# version 2")
    with pytest.raises(rl.RevisionUnavailable, match="stale"):
        rl.load_revision_data(ws)
    assert table.is_file()


@pytest.mark.parametrize("artifact", ["table", "metadata", "metrics", "probabilities"])
def test_cache_invalidates_content_changes_even_with_preserved_mtime(cached_inputs, artifact):
    ws, iteration, table, _, meta = cached_inputs
    original = rl.load_revision_data(ws)
    target = {"table": table, "metadata": meta, "metrics": iteration/"metrics_formal.json", "probabilities": iteration/"val_probs.npz"}[artifact]
    rewrite_same_mtime(target, target.read_text() + " ")
    refreshed = rl.load_revision_data(ws)
    assert refreshed is not original and refreshed.input_fingerprint != original.input_fingerprint


def test_cache_rejects_input_changed_during_load(cached_inputs, monkeypatch):
    ws, *_ = cached_inputs
    fingerprints = iter(["before", "after"])
    monkeypatch.setattr(rl, "input_fingerprint", lambda *_: next(fingerprints))
    with pytest.raises(rl.RevisionUnavailable, match="changed while loading"):
        rl.load_revision_data(ws)
    assert not rl._CACHE
