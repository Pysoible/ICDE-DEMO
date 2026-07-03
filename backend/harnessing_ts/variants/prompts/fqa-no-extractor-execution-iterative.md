## Ablation Variant NOD-FQA-KTL-CXR-SUB-ADA: Extractor Source QA + No Extractor Execution

本变体保留 candidate review、case review、subagent 和自适应迭代，但改变领域知识和 case review 证据边界：

- 领域知识只能通过 `mcp__ts_harness__query_knowledge` 获取；该工具只根据 `tools/reference-feature-extractor/**` 的源码、规则、manifest、README 和评估报告回答。
- 不得读取 `references/**`、`knowledge_base/**` 或 `artifacts/knowledge-graph.json` 来补充领域知识。
- 不得执行、import 或调用 `tools/reference-feature-extractor/extractor.py`，也不得使用 `mcp__ts_harness__extract_reference_features` 或 `mcp__ts_harness__inspect_reference_feature_extractor`。
- case review 仍必须生成 `reports/iterations/<iteration-id>-case-review.md`，但只能使用原始输入值、当前候选方法输出、数据统计、可视化、good/prototype 对照和 extractor-source QA 的静态规则解释。
- case review 中的 reference feature evidence 一律标注为 `reference feature extractor execution disabled by variant`；不要伪造每个 case 的 extractor 输出。
- 不生成 `runs/iterations/<iteration-id>/reference-feature-usage.json`，也不要在 `record_run` 或 `finish_node.outputPaths` 中记录 reference-feature usage 工件。

基础 iterative guidance 中要求实际调用 reference feature extractor 的条款在本变体中禁用；case review 结构、候选比较、运行记录、迭代总结和停止判断要求仍然保留。
