# Litefuse Tracing Plugin for WorkBuddy

将 WorkBuddy 会话中的用户轮次、模型调用、工具调用、Token 用量和子代理上传到
[Litefuse](https://litefuse.ai)，便于调试、评估和成本分析。

Litefuse 是 Langfuse 的 fork（底层存储替换为 Doris），并保持了对 Langfuse 生态的完全兼容，
因此本插件可以直接复用 `@langfuse/otel` 与 `@langfuse/tracing` SDK，把数据通过标准的
OTLP 端点 `/api/public/otel/v1/traces` 写入 Litefuse。

本项目参考并适配了
[`workbuddy-observability-plugin`](https://github.com/ai-native-thinking/workbuddy-observability-plugin)
（Langfuse 版本），核心差异是配置与端点：

- 配置文件为 `~/.workbuddy/litefuse.json`，而不是 `langfuse.json`。
- 环境变量前缀为 `LITEFUSE_WORKBUDDY_*`，并回退到通用 `LITEFUSE_*`。
- `base_url` 默认为自托管地址 `http://localhost:3000`，而不是 Langfuse Cloud。
- 去重 sidecar 后缀为 `*.litefuse-workbuddy`。

## 采集内容

- 每个用户轮次对应一个 `WorkBuddy Turn` trace。
- 每次模型响应对应一个 `LLM` generation，包含模型名、推理、回复、工具请求和 Token 用量。
- 每次工具执行对应一个 tool observation，包含参数、输出、错误状态和耗时。
- `Agent` 工具创建的 `subagents/agent-*.jsonl` 会嵌套为 `WorkBuddy Subagent Turn`。
- 同一 WorkBuddy session 的轮次通过 Litefuse session id 聚合。

## 前置条件

- WorkBuddy 5.3.14 / CodeBuddy CLI 2.115.0 或兼容版本
- Node.js 22+
- Litefuse 实例的 public/secret API key

### Litefuse 兼容性说明

Litefuse 的 OTLP 入口要求客户端声明 SDK 版本（`x-langfuse-sdk-name` 为 `javascript` 且
`x-langfuse-sdk-version >= 5.0.0`），否则会直接返回 400。本插件内置的 `@langfuse/otel`
版本为 5.x，满足该要求，无需额外配置。

获取 API key：在 Litefuse Web UI 的项目设置中创建，并确认该实例的
`/api/public/otel/v1/traces` 路由可访问。

## 本地安装

克隆仓库并进入项目目录：

```bash
git clone https://github.com/ai-native-thinking/workbuddy-litefuse-plugin.git
cd workbuddy-litefuse-plugin
pnpm install
pnpm run build
```

WorkBuddy 自带的 CLI 位于：

```bash
CODEBUDDY="/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
```

桌面版 WorkBuddy 从 `~/.workbuddy` 读取配置；但其内置的 CodeBuddy CLI 默认使用
`~/.codebuddy`。安装插件前必须同时指定下面两个配置目录变量，否则 CLI 虽然可能提示安装成功，
桌面版 WorkBuddy 实际上不会加载该插件：

```bash
export CODEBUDDY_CONFIG_DIR="$HOME/.workbuddy"
export WORKBUDDY_CONFIG_DIR="$HOME/.workbuddy"
```

添加当前目录为本地 marketplace，并安装、启用插件：

```bash
"$CODEBUDDY" plugin marketplace add "$PWD"
"$CODEBUDDY" plugin install tracing@workbuddy-litefuse-plugin
"$CODEBUDDY" plugin enable tracing@workbuddy-litefuse-plugin
```

确认插件已经安装到 WorkBuddy 的配置目录：

```bash
"$CODEBUDDY" plugin list
```

输出中应包含 `tracing@workbuddy-litefuse-plugin`，且状态为启用。然后完全退出并重新启动
WorkBuddy；若出现 hook 安全审查，请检查 `Stop` hook 后选择信任。

完成一次新的 WorkBuddy 对话后，可以检查是否生成去重 sidecar，以确认 hook 已经执行：

```bash
find "$HOME/.workbuddy/projects" -name '*.litefuse-workbuddy' -print
```

如果找不到 sidecar，请首先确认当前终端仍设置了 `CODEBUDDY_CONFIG_DIR` 和
`WORKBUDDY_CONFIG_DIR`，再运行 `plugin list` 检查插件状态。

## 禁用与卸载

以下命令必须使用与安装时相同的 WorkBuddy 配置目录。如果打开了新的终端，请先重新设置：

```bash
CODEBUDDY="/Applications/WorkBuddy.app/Contents/Resources/app.asar.unpacked/cli/bin/codebuddy"
export CODEBUDDY_CONFIG_DIR="$HOME/.workbuddy"
export WORKBUDDY_CONFIG_DIR="$HOME/.workbuddy"
```

临时停止采集，但保留插件及其配置：

```bash
"$CODEBUDDY" plugin disable tracing@workbuddy-litefuse-plugin
```

需要恢复时重新启用：

```bash
"$CODEBUDDY" plugin enable tracing@workbuddy-litefuse-plugin
```

彻底卸载插件：

```bash
"$CODEBUDDY" plugin uninstall tracing@workbuddy-litefuse-plugin
```

如果不再需要通过当前源码目录安装插件，还可以移除本地 marketplace：

```bash
"$CODEBUDDY" plugin marketplace remove workbuddy-litefuse-plugin
```

执行禁用、重新启用或卸载后，请完全退出并重新启动 WorkBuddy。卸载插件不会删除
`~/.workbuddy/litefuse.json`，也不会删除已经生成的 `*.litefuse-workbuddy` sidecar 文件。

## 配置

默认不上传任何数据。推荐创建 `~/.workbuddy/litefuse.json`：

```json
{
  "enabled": true,
  "public_key": "pk-lf-...",
  "secret_key": "sk-lf-...",
  "base_url": "http://localhost:3000",
  "environment": "development",
  "tags": ["workbuddy"]
}
```

也可以在项目下创建 `<project>/.workbuddy/litefuse.json`。优先级为：默认值 → 全局配置 →
项目配置 → 环境变量。

| 环境变量                           | 说明                                             |
| ---------------------------------- | ------------------------------------------------ |
| `TRACE_WORKBUDDY_TO_LITEFUSE`      | 设为 `true` 开启上传；也兼容 `TRACE_TO_LITEFUSE` |
| `LITEFUSE_WORKBUDDY_PUBLIC_KEY`    | Public key；回退到 `LITEFUSE_PUBLIC_KEY`         |
| `LITEFUSE_WORKBUDDY_SECRET_KEY`    | Secret key；回退到 `LITEFUSE_SECRET_KEY`         |
| `LITEFUSE_WORKBUDDY_BASE_URL`      | Litefuse 地址；回退到 `LITEFUSE_BASE_URL`        |
| `LITEFUSE_WORKBUDDY_ENVIRONMENT`   | Environment 标签                                 |
| `LITEFUSE_WORKBUDDY_VERSION`       | 附加到 trace 的应用版本                          |
| `LITEFUSE_WORKBUDDY_USER_ID`       | 附加到 trace 的用户 id                           |
| `LITEFUSE_WORKBUDDY_TAGS`          | JSON 数组或逗号分隔标签                          |
| `LITEFUSE_WORKBUDDY_METADATA`      | JSON 对象形式的 trace metadata                   |
| `LITEFUSE_WORKBUDDY_TRACE_SEED`    | 用于生成可预测 trace id 的 seed                  |
| `LITEFUSE_WORKBUDDY_MAX_CHARS`     | 单个输入/输出最大字符数，默认 `20000`            |
| `LITEFUSE_WORKBUDDY_DEBUG`         | 将调试日志写入 stderr                            |
| `LITEFUSE_WORKBUDDY_FAIL_ON_ERROR` | 测试时让上传错误导致 hook 失败；默认 fail-open   |

指向 Litefuse Cloud 时只需覆盖 `base_url`：

```bash
export LITEFUSE_WORKBUDDY_BASE_URL="https://cloud.litefuse.ai"
```

## 数据与隐私

开启后会上传用户提示、模型回复、推理文本、工具参数与输出、模型元数据和 Token 用量。
不要在不应离开本机的敏感会话中开启。插件会在 transcript 旁写入
`<transcript>.litefuse-workbuddy` 去重 sidecar；不会修改 transcript 本身。

## 开发

```bash
pnpm install
pnpm test
pnpm run lint
```

`plugins/tracing/dist/index.mjs` 是包含全部运行时依赖的单文件 bundle，WorkBuddy 加载插件时
不需要执行安装步骤。修改源码后必须重新执行 `pnpm run build` 并提交新的 bundle。

## License

MIT。适配实现基于 Langfuse GmbH 的 MIT 许可参考项目。
