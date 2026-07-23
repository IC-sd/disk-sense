# AI 分析接入

Disk Sense 的 AI 能力是可选增强层，本地规则仍是基础。用户需要在“目录与文件 → AI 设置”中主动配置，并在选中对象后主动点击“请求 AI 深入解释”。

## 支持的接口

支持 OpenAI 兼容的 Chat Completions 接口。用户填写 Base URL 和 API
密钥后，配置页会自动请求 `GET /models`，把服务端实际返回的模型显示为
可选列表并默认选中一个，不要求用户预先知道模型名称。

Base URL 可以填写服务的基础地址，例如：

```text
https://api.example.com/v1
```

也可以填写完整地址：

```text
https://api.example.com/v1/chat/completions
```

## 环境变量

也可以在启动软件前设置：

```text
DISK_SENSE_AI_ENDPOINT
DISK_SENSE_AI_KEY
DISK_SENSE_AI_MODEL
```

界面配置优先于环境变量。API 密钥通过 Electron `safeStorage` 使用 Windows 系统加密保存，并且不会回显到前端。

## 发送给模型的内容

只发送当前选中对象的：

- 文件或目录名称
- 最多 8 层路径片段
- 最多 40 个同级名称
- 文件大小、类型和本地风险判断
- 跨盘关联位置
- 最多 1200 字的文本摘要

不会发送完整文件，也不会自动批量分析磁盘。AI 结果只用于解释，不会直接执行删除。

## 模型返回结构

模型被要求返回 JSON：

```json
{
  "what": "它是什么",
  "purpose": "有什么用",
  "belongsTo": "属于哪个系统或应用",
  "whyHere": "为什么出现在这个位置",
  "risk": "low|medium|high|unknown",
  "confidence": 0.8,
  "handling": "处理建议",
  "reasons": ["关键依据"]
}
```

证据不足时，模型必须明确表示不确定，不能把未知内容直接判断为垃圾。
