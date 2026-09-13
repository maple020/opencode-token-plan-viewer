# OpenCode Token Checker

OpenCode TUI 侧栏插件：上游额度插件显示提供商剩余额度，本项目从本机 OpenCode 数据库汇总每个模型的 Token、消息和记录成本。两条数据链路彼此独立，不重复发起额度网络请求。

## 安装

需要 Node.js 22+、Bun 和 OpenCode（已在 OpenCode 1.18.30 验证）。

```sh
git clone https://github.com/neverendingstory/opencode-token-checker.git
cd opencode-token-checker
npm ci --ignore-scripts
```

把绝对路径加入全局 `~/.config/opencode/opencode.json`，保留原有插件：

```json
{
  "plugin": [
    "file:///absolute/path/opencode-token-checker/server.js"
  ]
}
```

把 TUI 入口加入 `~/.config/opencode/tui.jsonc`，同样保留原有插件：

```json
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": [
    "file:///absolute/path/opencode-token-checker/tui.jsx"
  ]
}
```

可选：复制非敏感额度显示配置，再按需调整。

```sh
mkdir -p ~/.config/opencode/opencode-quota
cp quota-toast.example.json ~/.config/opencode/opencode-quota/quota-toast.json
```

重启 OpenCode 后生效。

## 使用

鼠标点击“本会话 · 含子代理”或“全部历史 · 本机”可展开/收起，点击 `[刷新]` 立即重读；默认显示五类 Token 总量最高的 3 个模型，超过 3 个时可展开全部。展开后面板随内容自然增高，仅使用宿主侧栏滚动，没有内部滚动条。`[查看明细]` 显示推理、缓存写和记录成本。

命令面板提供：`model-usage.refresh`、`model-usage.session`、`model-usage.history`、`model-usage.models`、`model-usage.details`。这些命令不覆盖输入区按键。

## 统计口径

- Token 共 5 桶：`输入 + 输出 + 推理 + 缓存读 + 缓存写`。
- 缓存命中率：`缓存读 /（输入 + 缓存读 + 缓存写）× 100%`；汇总值先合计各桶再计算。
- “消息”是本机数据库里的 assistant 消息条数，不是 API 请求数。
- “记录成本”来自消息记录，只供参考，不是账单。
- 本会话范围包含该会话及递归子会话；全部历史范围覆盖运行 TUI 机器上的本地库。
- 已展开的本会话每 5 秒刷新，全部历史每 60 秒刷新；额度提供商的最短缓存间隔为 60 秒。

## 限制

- 连接远程 OpenCode server 时，模型用量仍来自运行 TUI 机器上的 `opencode db path`，不支持读取远程 server 数据库。
- 提供商支持、认证要求和额度接口由上游维护，详见 [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota)。诊断中的 `quota_plugin_configured=false` 可能只是没有按 npm 包名识别本地 wrapper，不等于 TUI 入口加载失败。
- 本项目通过 npm 依赖使用 `@slkiser/opencode-quota`，没有复制或 vendoring 上游源码；其许可与实现归上游项目维护。

## 回滚

分别从全局 `opencode.json` 和 `tui.jsonc` 删除本项目的 `server.js`、`tui.jsx` 两个 `file://` 条目并重启 OpenCode；不要删除其他插件项。本机额度配置位于 `~/.config/opencode/opencode-quota/quota-toast.json`，不属于仓库。

## 测试

```sh
node --test usage.test.js integration.test.js
bun test usage.test.js
BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test --preload @opentui/solid/preload panel.ui.test.js
BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test --preload @opentui/solid/preload tui.smoke.test.js
```

`npm run test:all` 会依次启动独立进程。可用 `OPENCODE_TEST_TMPDIR=/writable/temp/path` 指定测试临时目录。
