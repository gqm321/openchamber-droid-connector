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
| `OCDROID_TOOL_MODE` | 透传给 Droid 的 toolExecutionMode |
| `OCDROID_STATE_DIR` | 适配器状态目录(归档标记、模型记忆) |

## 已支持

- 会话创建/列表/改名/归档/删除;会话来自 `~/.factory/sessions`,重启后历史与工具部件可恢复,并能续聊
- 流式文本、思考内容、工具调用(Execute→bash、Read、Create→write、Edit、Grep、Glob 等)
- 权限询问:`permission.asked` → `POST /permission/{id}/reply`(once / always / reject)
- 模型切换、中止(interrupt)

## 已知缺口

- revert、todo、share、文件 diff 为桩实现(diff 返回 501)
- Droid 的 AskUser 未映射到 question 事件
- Droid 默认用 `Script` 包装工具,`direct_only` 无法强制;适配器隐藏包装、只显示内部调用
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
