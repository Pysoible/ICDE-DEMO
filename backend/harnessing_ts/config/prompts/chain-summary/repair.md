# Draft 局部修复

这是第 {attempt}/{max_attempts} 次局部修复。

后端校验文件：`{draft_path}`

验收错误：

```text
{validation_error}
```

请使用 DSH `bash` 工具读取错误位置附近的 draft 内容，再以最小范围修改文件。完成后只回复一句简体中文确认，后端会立即重新校验 draft。
