## 上下文长度

上游模型目录**不返回**上下文窗口（只有 `modelName / modelValue / modelDescription / modelImage / gray`），
App 包里也没有窗口常量（`contextWindow / context_length / maxInputToken` 全无，`1048576`、`131072`
只是 MP4 的 bitmask）。所以 `limit.context` 只能实测。

针测试（暗号写在开头，后面灌填充，最后问暗号），2026-11-15：

| 模型 | 输入 | 是否答对 |
|---|---|---|
| GLM-5.3-Flash | ~100k tok | ✅ |
| GLM-5.3-Flash | ~300k tok | ✅ |
| GLM-5.3-Flash | ~950k tok | ✅ |
| DeepSeek-V4.1-Flash | ~950k tok | ✅ |

结论：窗口 ≈ 1M tokens，插件里统一填 `1000000`。

> 阅读这类回答时注意：受限/长上下文下模型可能把答案写进 `reasoning_content` 而 `content` 为空，
> 判定"答对"要把两段都读。
