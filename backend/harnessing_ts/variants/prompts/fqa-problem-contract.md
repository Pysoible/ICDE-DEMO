## Ablation Variant NOD-FQA-KTL-CXR-SUB-ADA: Extractor Source QA

本变体不构建 knowledge graph。`problem-contract` 阶段可以读取 `references/**` 原文和数据文件来确定任务边界，因为 reference feature extractor 尚未生成。

- 不要求或等待 Knowledge Graph builder。
- 不读取 `knowledge_base/tables/*.csv`、`knowledge_base/indexes/**`、`knowledge_base/cache/**` 或 `artifacts/knowledge-graph.json`。
- problem contract 和 data spec 应明确：后续 `knowledge-to-tools` 会把 references 中的规则沉淀为 `tools/reference-feature-extractor/**`，再由后续节点把这些源码、规则和 README 当作唯一领域参考材料。
- 不要声称后续节点可以执行 reference feature extractor；本变体只允许把它作为静态参考材料。
