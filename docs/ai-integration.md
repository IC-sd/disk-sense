# AI 分析接入

Disk Sense 的 AI 能力是可选增强层，本地规则仍是基础。用户需要在“目录与文件 → AI 设置”中主动配置，并在选中对象后主动选择“普通分析”或“深入分析”。

- 普通分析：低思考，响应更快，最大输出预算较低。
- 深入分析：高思考，交叉检查更多上下文，最大输出预算更高。

## 支持的接口

支持四种接入类型：

- OpenAI 兼容的 Chat Completions。
- OpenAI Responses API。
- Azure OpenAI 部署。
- Ollama、vLLM 等提供 OpenAI 兼容接口的本地服务。

配置页会尝试通过 `GET /models` 读取模型，但模型列表不是保存配置的前置条件；
服务不提供该接口时可以直接填写模型名称，Azure 模式填写部署名称。

Base URL 可以填写服务的基础地址，例如：

```text
https://api.example.com/v1
```

也可以填写完整地址：

```text
https://api.example.com/v1/chat/completions
```

Responses 模式可以填写 `https://api.openai.com/v1` 或完整的
`https://api.openai.com/v1/responses`。Azure 模式可以填写资源地址，由程序根据
部署名称和 API 版本构造请求，也可以填写完整部署地址。

远程服务必须使用 HTTPS。本地模型模式允许 `localhost`、回环地址和局域网私有
地址使用 HTTP，例如 `http://127.0.0.1:11434/v1`。

## 环境变量

也可以在启动软件前设置：

```text
DISK_SENSE_AI_ENDPOINT
DISK_SENSE_AI_KEY
DISK_SENSE_AI_MODEL
DISK_SENSE_AI_PROVIDER
DISK_SENSE_AI_API_VERSION
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
  "risk": "danger|elevated|attention|low|safe",
  "confidence": 0.8,
  "handling": "处理建议",
  "reasons": ["关键依据"]
}
```

证据不足时，模型必须明确表示不确定，不能把未知内容直接判断为垃圾。
