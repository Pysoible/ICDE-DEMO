from __future__ import annotations

from array import array
import csv
import json
from pathlib import Path
import struct
import zipfile

from harnessing_ts.ecg_demo import (
    EcgDemoUnavailable,
    build_ecg_overview,
    list_ecg_datasets,
    load_ecg_waveform,
    resolve_ecg_workspace,
)


def _workspace(tmp_path: Path) -> Path:
    iteration = tmp_path / "runs" / "iterations" / "006"
    iteration.mkdir(parents=True)
    (iteration / "metrics_formal.json").write_text(json.dumps({
        "split": "val",
        "n": 2,
        "macro_auc": 0.91,
        "macro_f1": 0.72,
        "thresholds": {name: 0.5 for name in ("NORM", "MI", "STTC", "CD", "HYP")},
        "per_class": [{"class": "NORM", "support_true": 1, "FN": 1, "recall": 0.0, "f1": 0.0}],
    }), encoding="utf-8")
    with zipfile.ZipFile(iteration / "val_probs.npz", "w") as archive:
        archive.writestr("ids.npy", _npy("<i8", (2,), [8, 9], "q"))
        archive.writestr("probs.npy", _npy("<f4", (2, 5), [0.2, 0.8, 0.1, 0.1, 0.1, 0.8, 0.1, 0.1, 0.1, 0.1], "f"))

    processed = tmp_path / "data" / "processed"
    processed.mkdir(parents=True)
    fields = ["ecg_id", "age", "sex", "filename_lr"] + [f"SUP_{name}" for name in ("NORM", "MI", "STTC", "CD", "HYP")] + ["SC_NORM", "SC_AMI"]
    with (processed / "ptbxl_meta_labels.csv").open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=fields)
        writer.writeheader()
        writer.writerow({"ecg_id": 8, "age": 56, "sex": 1, "filename_lr": "records100/00000/00008_lr", "SUP_NORM": 1, "SUP_MI": 0, "SUP_STTC": 0, "SUP_CD": 0, "SUP_HYP": 0, "SC_NORM": 1, "SC_AMI": 0})
        writer.writerow({"ecg_id": 9, "age": 61, "sex": 0, "filename_lr": "records100/00000/00009_lr", "SUP_NORM": 1, "SUP_MI": 0, "SUP_STTC": 0, "SUP_CD": 0, "SUP_HYP": 0, "SC_NORM": 1, "SC_AMI": 0})
    return tmp_path


def _npy(dtype: str, shape: tuple[int, ...], values: list[int | float], code: str) -> bytes:
    header = repr({"descr": dtype, "fortran_order": False, "shape": shape})
    header = (header + " " * ((64 - (10 + len(header) + 1) % 64) % 64) + "\n").encode("latin1")
    return b"\x93NUMPY\x01\x00" + len(header).to_bytes(2, "little") + header + struct.pack("<" + code * len(values), *values)


def test_overview_reads_latest_iteration_and_filters_errors(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)

    payload = build_ecg_overview(workspace)

    assert payload["iteration"] == "006"
    assert payload["matchedCount"] == 1
    assert payload["samples"][0]["ecgId"] == 8
    assert payload["samples"][0]["truth"] == ["NORM"]
    assert payload["samples"][0]["predicted"] == ["MI"]


def test_overview_can_select_a_case_beyond_page_limit(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)

    payload = build_ecg_overview(workspace, status="all", limit=1, ecg_id=9)

    assert payload["samples"][0]["ecgId"] == 9
    assert payload["matchedCount"] == 1


def test_waveform_decodes_real_wfdb_format_16_values(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    record = workspace / "data" / "raw" / "dataset" / "records100" / "00000" / "00008_lr"
    record.parent.mkdir(parents=True)
    lines = ["00008_lr 2 100 3", "00008_lr.dat 16 1000.0(0)/mV 16 0 0 0 0 I", "00008_lr.dat 16 2000.0(0)/mV 16 0 0 0 0 II"]
    record.with_suffix(".hea").write_text("\n".join(lines) + "\n", encoding="ascii")
    values = array("h", [1000, 2000, -1000, -2000, 500, 1000])
    record.with_suffix(".dat").write_bytes(values.tobytes())

    payload = load_ecg_waveform(workspace, 8)

    assert payload["sampleRate"] == 100
    assert payload["leads"][0] == {"name": "I", "unit": "mV", "values": [1.0, -1.0, 0.5]}
    assert payload["leads"][1]["values"] == [1.0, -1.0, 0.5]


def test_dataset_registry_lists_only_demo_ready_workspaces(tmp_path: Path, monkeypatch) -> None:
    current = _workspace(tmp_path / "PTB-XL_learning")
    (current / "data" / "raw" / "dataset").mkdir(parents=True)
    monkeypatch.setattr("harnessing_ts.ecg_demo.WORKSPACE_ROOT", tmp_path / "root")

    payload = list_ecg_datasets(current)

    keys = {item["key"] for item in payload["datasets"]}
    assert keys == {"ptbxl", "georgia", "cpsc"}
    assert payload["selected"] == "ptbxl"
    assert next(item for item in payload["datasets"] if item["key"] == "ptbxl")["available"] is True
    assert all(item["name"] in {"PTB-XL", "Georgia", "CPSC"} for item in payload["datasets"])


def test_resolve_ecg_workspace_rejects_unknown_dataset(tmp_path: Path, monkeypatch) -> None:
    current = _workspace(tmp_path / "current")
    (current / "data" / "raw" / "dataset").mkdir(parents=True)
    monkeypatch.setattr("harnessing_ts.ecg_demo.WORKSPACE_ROOT", tmp_path / "root")

    try:
        resolve_ecg_workspace(current, "missing")
    except EcgDemoUnavailable as exc:
        assert "Unknown ECG dataset" in str(exc)
    else:
        raise AssertionError("Unknown dataset should be rejected")


def test_resolve_ecg_workspace_rejects_unavailable_dataset(tmp_path: Path, monkeypatch) -> None:
    current = _workspace(tmp_path / "PTB-XL_learning")
    (current / "data" / "raw" / "dataset").mkdir(parents=True)
    monkeypatch.setattr("harnessing_ts.ecg_demo.WORKSPACE_ROOT", tmp_path / "root")

    try:
        resolve_ecg_workspace(current, "georgia")
    except EcgDemoUnavailable as exc:
        assert "没有可直接展示" in str(exc)
    else:
        raise AssertionError("Unavailable dataset should be rejected")


def test_all_status_keeps_correct_and_error_samples_in_ecg_order(tmp_path: Path) -> None:
    workspace = _workspace(tmp_path)
    iteration = workspace / "runs" / "iterations" / "006"
    with zipfile.ZipFile(iteration / "val_probs.npz", "w") as archive:
        archive.writestr("ids.npy", _npy("<i8", (2,), [8, 9], "q"))
        archive.writestr("probs.npy", _npy("<f4", (2, 5), [
            0.8, 0.1, 0.1, 0.1, 0.1,
            0.1, 0.8, 0.1, 0.1, 0.1,
        ], "f"))

    payload = build_ecg_overview(workspace, status="all", limit=2)

    assert [sample["ecgId"] for sample in payload["samples"]] == [8, 9]
    assert [sample["exact"] for sample in payload["samples"]] == [True, False]
