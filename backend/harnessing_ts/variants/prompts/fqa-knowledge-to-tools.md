## Ablation Variant NOD-FQA-KTL-CXR-SUB-ADA: Build Reference Source Only

本节点仍必须根据 references 原文构建完整 `tools/reference-feature-extractor/**`，但它在本变体中不是后续可执行特征工具，而是替代原始 references 的静态参考材料。

- 可以读取 `references/**`，但不得读取 knowledge graph 内部文件。
- 必须写出完整 `manifest.json`、`reference-rules.json`、`evidence-map.json`、`feature-plan.json`、`evaluation-report.json`、`README.md`、`test-cases.json` 和 `extractor.py`，因为后续 extractor-source QA 会读取这些文件回答领域问题。
- `extractor.py` 仍应是确定性、可审计、可静态校验的 Python 源码，但不要把它描述为后续 case review 可调用工具。
- 调用 `mcp__ts_harness__validate_reference_feature_extractor` 触发后端校验；在本变体中后端会执行静态校验，不会运行测试样本或 import extractor。
- 完成后，后续节点只能通过 `mcp__ts_harness__query_knowledge` 基于 extractor source bundle 获取领域知识，不再读取原始 references 或 knowledge graph。
