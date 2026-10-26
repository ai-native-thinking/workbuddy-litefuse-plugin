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

## 本地安装（Windows）

下面的步骤基于 Windows 11 + WorkBuddy 桌面版的实测。整体流程和 macOS 一致，但有两处
Windows 桌面版的坑需要处理（端口冲突 + 桌面版禁用插件自带 hook），否则会出现
"插件显示已启用、却永远不上报数据" 的情况。

WorkBuddy 桌面版在 Windows 上的 CLI 路径为：

```bat
%LOCALAPPDATA%\Programs\WorkBuddy\resources\app.asar.unpacked\cli\bin\codebuddy
```

在 Git Bash 中等价为（下文统一用 `$CODEBUDDY` 指代）：

```bash
CODEBUDDY="/c/Users/$USER/AppData/Local/Programs/WorkBuddy/resources/app.asar.unpacked/cli/bin/codebuddy"
```

和 macOS 一样，必须指定配置目录，否则 CLI 会默认去读 `~/.codebuddy`，桌面版加载不到插件：

```bash
export CODEBUDDY_CONFIG_DIR="$HOME/.workbuddy"
export WORKBUDDY_CONFIG_DIR="$HOME/.workbuddy"
```

### 1. 注册 marketplace 并安装插件

直接用 CLI 安装时会遇到两个 Windows 特有的问题：

- **端口冲突（EADDRINUSE 127.0.0.1:60389）**：CLI 会去 bind 桌面进程已经占用的端口。
  解决方法是用一个"干净环境"启动 CLI，只保留必需变量，并**务必保留**
  `CODEBUDDY_FORCE_LITE_WB_BUNDLE=1`（否则 CLI 会去找不存在的 `../dist/codebuddy`）。
- **写操作被沙箱拦截**：`plugin enable` 偶尔会被沙箱策略拦下并提示
  "Sandbox 未返回具体资源"，但 `plugin install` 其实已经把文件落盘了，无需重试。

推荐用下面这条"干净环境"命令完成注册与安装（在 Git Bash 中先 `cd` 到仓库根目录）：

```bash
env -i HOME="$HOME" \
  PATH="$(dirname "$(which node)"):/usr/bin:/bin" \
  CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 \
  CODEBUDDY_CONFIG_DIR="$HOME/.workbuddy" \
  WORKBUDDY_CONFIG_DIR="$HOME/.workbuddy" \
  node "$CODEBUDDY" plugin marketplace add "$PWD"

env -i HOME="$HOME" \
  PATH="$(dirname "$(which node)"):/usr/bin:/bin" \
  CODEBUDDY_FORCE_LITE_WB_BUNDLE=1 \
  CODEBUDDY_CONFIG_DIR="$HOME/.workbuddy" \
  WORKBUDDY_CONFIG_DIR="$HOME/.workbuddy" \
  node "$CODEBUDDY" plugin install tracing@workbuddy-litefuse-plugin
```

前提是本机有 Node.js 22+（`which node` 能解析到）。`env -i` 的作用是清掉桌面端注入的
端口 / gateway 相关变量，避免端口冲突。安装完成后插件文件会落在：

```
%USERPROFILE%\.workbuddy\plugins\cache\workbuddy-litefuse-plugin\tracing\0.1.0\
```

### 2. 启用插件

如果第 1 步里 `plugin install` 之后 `plugin enable` 被沙箱拦了，可以直接编辑
`~/.workbuddy/settings.json`，在 `enabledPlugins` 里加一行（没有该字段就新建）：

```json
{
  "enabledPlugins": {
    "tracing@workbuddy-litefuse-plugin": true
  }
}
```

### 3. 注册 hook（关键，Windows 桌面版必须做）

**重要**：WorkBuddy 桌面版在启动 CLI 时会注入 `CODEBUDDY_DISABLE_EXTENDED_PLUGIN_HOOKS=1`，
导致插件自带的 `hooks.json`（即 `Stop` 事件里的 `node "${CODEBUDDY_PLUGIN_ROOT}/dist/index.mjs"`）
**不会被执行**。这跟 macOS / Windows 无关，是桌面版的通用行为（已在 Windows 安装包 `app.asar`
中确认；macOS 桌面版同源，建议同样处理）。结果是：插件即便显示"已启用"，也永远不会有数据上报。

规避办法：把 hook 命令显式写进**用户级** `settings.json` 的 `hooks.Stop`。用户级 hooks 不受
上面的开关约束。在 `~/.workbuddy/settings.json` 中找到或新建 `hooks.Stop` 数组，追加一条：

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "node \"C:/Users/<你的用户名>/.workbuddy/plugins/cache/workbuddy-litefuse-plugin/tracing/0.1.0/dist/index.mjs\"",
            "timeout": 30
          }
        ]
      }
    ]
  }
}
```

> - 把路径里的 `<你的用户名>` 替换成实际用户名；Windows 路径用正斜杠 `/` 或双反斜杠 `\\` 均可。
> - 如果 `hooks.Stop` 里已经有其它命令（例如其它观测工具），把它们并列放在同一个 `hooks`
>   数组里即可——各 hook 之间 fail-open，互不影响。

### 4. 填写配置

见下方「配置」一节，创建 `~/.workbuddy/litefuse.json` 并填入 `public_key` / `secret_key` /
`base_url`。

### 5. 重启并验证

**完全退出** WorkBuddy（托盘图标右键退出，不是关窗口），重新启动，跑一轮新对话，然后检查去重
sidecar 是否生成：

```bash
find "$HOME/.workbuddy/projects" -name '*.litefuse-workbuddy' -print
```

能看到 sidecar 文件即说明 hook 真正跑起来了。如果看不到，先确认 `~/.workbuddy/settings.json`
里 `hooks.Stop` 已包含上面那条 `node .../dist/index.mjs` 命令，且 `enabledPlugins` 中插件为
`true`。

## 禁用与卸载

以下命令必须使用与安装时相同的 WorkBuddy 配置目录。如果打开了新的终端，请先重新设置
`CODEBUDDY_CONFIG_DIR` / `WORKBUDDY_CONFIG_DIR`，并把 `CODEBUDDY` 换成对应平台的 CLI 路径
（Windows 见上方「本地安装（Windows）」）。

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
