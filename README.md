# openchamber-droid-connector

让 [OpenChamber](https://github.com/btriapitsyn/openchamber) 把 [Factory Droid](https://factory.ai) 当作后端使用。

适配器对外模拟 OpenCode 的 HTTP + SSE 服务,对内通过官方 `@factory/droid-sdk` 驱动 `droid`。
OpenChamber 通过 `settings.opencodeBinary` 把它当作 `opencode serve` 来启动。

基于 [qingzhu521/openchamber-pi-connector](https://github.com/qingzhu521/openchamber-pi-connector)(MIT)改造,后端由 pi 换成 Droid。

## 要求

- Node 20+
- 已安装并登录的 `droid`(`FACTORY_API_KEY` 或 `droid` 登录态)
- OpenChamber 1.24.x(`@openchamber/web@1.24.2` 已联调)

## 使用

```bash
npm install
# OpenChamber 的 settings.json:
#   { "opencodeBinary": "/绝对路径/bin/opencode-droid" }
# 或设置环境变量 OPENCODE_BINARY
OPENCHAMBER_DATA_DIR=~/.config/openchamber-droid openchamber --port 3901
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `OCDROID_MODEL` | 默认模型,缺省取 `~/.factory/settings.json` 的 `sessionDefaultSettings.model` |
| `OCDROID_AUTONOMY` | Droid 自主级别,默认 `low`(需要权限时会在 UI 里询问) |
| `OCDROID_AGENT` | 暴露的 agent 名,默认 `build` |
| `OCDROID_TOOL_MODE` | Droid 的工具执行模式:缺省 `direct_only`(工具逐个直接调用);设为 `script_only` 启用 Programmatic Tool Calling,见下 |
| `OCDROID_STATE_DIR` | 适配器状态目录(归档标记、模型记忆) |

## Programmatic Tool Calling(`script_only`)

默认情况下适配器让 Droid 直接逐个调用工具(`direct_only`)。设置 `OCDROID_TOOL_MODE=script_only` 后,Droid 会把一轮里的多个工具调用写进一段 JavaScript,通过它的 `Script` 工具一次执行,可并行、可带循环和条件。

```bash
# 在启动 OpenChamber 的脚本里(适配器由 OpenChamber 拉起,继承其环境)
export OCDROID_TOOL_MODE=script_only
```

修改后需重启 OpenChamber。

界面上的表现:

- 脚本里调用的 Execute、Read、Edit 等仍显示为各自独立的普通工具卡片,权限询问也归属到对应的卡片;`Script` 外壳本身默认隐藏。
- 只有外壳自己出了错、没有任何内部调用(纯 JS 计算)时,才显示一张 `script` 卡片。
- 脚本源码和 `console.log` 输出目前在界面里看不到;历史恢复(重启后)与实时显示一致。

确认是否生效:

```bash
tr '\0' '\n' < /proc/<适配器进程pid>/environ | grep OCDROID_TOOL_MODE
# 会话文件里出现 "name":"Script" 与带 script_execution 的内部调用,即发生了 PTC
grep -c script_execution ~/.factory/sessions/<目录>/<会话>.jsonl
```

## 已支持

- 会话创建/列表/改名/归档/删除;会话来自 `~/.factory/sessions`,重启后历史与工具部件可恢复,并能续聊
- 流式文本、思考内容、工具调用(Execute→bash、Read、Create→write、Edit、Grep、Glob 等)
- 权限询问:`permission.asked` → `POST /permission/{id}/reply`(once / always / reject)
- 模型切换(含推理强度)、中止(interrupt);模型列表带上下文长度、推理强度、模态信息
- 上下文用量:取 Droid 最近一次模型调用的 token 数
- `/compact`:压缩上下文;Droid 自己触发的自动压缩也会实时显示。摘要显示为可折叠的 `compact` 卡片,重启后历史一致
- Droid 的 `TodoWrite` 显示为 OpenChamber 的 todo 列表,重启后可恢复
- `/btw`:`POST /session/{id}/fork` 与会话 `metadata`

## 已知缺口

- revert、share、文件 diff 为桩实现(diff 返回 501)
- Droid 的 AskUser 未映射到 question 事件
- `script_only` 下看不到脚本源码与 `console.log` 输出(需要给 OpenChamber 前端打补丁)
- 仅文本 parts,不处理图片/文件附件
- 只在 OpenChamber 1.24.x 验证,未测 2.x

## 测试(需真实 droid)

```bash
npm run smoke              # 33 项
npm run v2-smoke           # 44 项
npm run permission-smoke   # 14 项
npm run typecheck
```

## 许可

MIT
