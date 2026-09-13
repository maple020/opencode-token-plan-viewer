# OpenCode Token Checker

OpenCode TUI 侧栏插件：始终在本机用量上方显示 **Remaining Quota**，再从本机 OpenCode 数据库汇总模型 Token、assistant 消息数和记录成本。远程提供商额度与本地使用统计是两条独立数据链路。

## 界面与数据含义

Remaining Quota 优先展示 Codex 和 DeepSeek；检测到的其他提供商会按[上游支持列表](https://github.com/slkiser/opencode-quota#providers)追加结果，不承诺任一提供商始终可检测或可用。查询不可用或需要认证时会明确显示状态，而不是悄悄消失。下方模型用量采用三行自适应布局，避免窄侧栏拆开数值。

- **提供商剩余量**优先来自远程额度或余额接口；上游仅能提供本地估算时，界面会标明“本机估算”。DeepSeek 显示账户货币余额，不转换成百分比。
- **本地缓存命中率**只按本机消息记录计算：`缓存读 /（输入 + 缓存读 + 缓存写）× 100%`。它不是提供商额度，也不表示订阅还剩多少。
- 订阅额度通常是账户或计划共享池，不会为每个模型虚构一份独立额度。
- 额度面板每 60 秒自动刷新；上游结果缓存时长由 `minIntervalMs` 配置决定，示例配置为 60 秒。手动刷新会尝试绕过缓存。界面时间是“检查时间”，不是结算时间，也不能替代账单。
- 文档、测试或截图中的数值都只能视为**示意数据**，不是任何个人账户的真实额度或余额。

“本会话 · 含子代理”和“全部历史 · 本机”两个本地用量范围默认都收起；展开后默认显示 Token 总量最高的 3 个模型，可继续自然展开全部内容。面板随内容增高并使用宿主侧栏滚动，不创建内部滚动区。

## 安装

需要 Node.js 22+、Bun 和 OpenCode（已在 OpenCode 1.18.30 验证）。

```sh
git clone https://github.com/maple020/opencode-token-plan-viewer.git opencode-token-checker
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

可选：复制不含凭据的额度显示配置，再按需调整。

```sh
mkdir -p ~/.config/opencode/opencode-quota
cp quota-toast.example.json ~/.config/opencode/opencode-quota/quota-toast.json
```

重启 OpenCode 后生效。

## 提供商认证

### Codex

Codex 使用 OpenCode 已有的 OAuth 登录来读取订阅额度。普通 OpenAI API key 代表 API 计费凭据，不等同于 Plus/Pro 等订阅额度认证。

### DeepSeek

DeepSeek 使用现有、受信任的 API key 查询账户货币余额。不要为本插件复制或提交额外密钥；额度行展示的是余额，不是每个模型的 Token 配额。

## 本地统计口径

- Token 共 5 桶：`输入 + 输出 + 推理 + 缓存读 + 缓存写`；不使用上游 `tokens.total`。
- “消息”是本机数据库里的 assistant 消息条数，不是 API 请求数。
- “记录成本”来自本机消息记录，只供参考，不是账单。
- 本会话范围包含该会话及递归子会话；全部历史范围覆盖运行 TUI 机器上的本地库。
- 展开的本会话每 5 秒重读本地数据，全部历史每 60 秒重读；这与远程额度的 60 秒查询/缓存周期互不替代。

## 诊断

在 OpenCode 中运行 `/quota_status` 可检查上游提供商。通用诊断中的 `quota_plugin_configured=false` 可能只是 wrapper 没有被识别为原 npm 包元数据，不表示额度功能已被禁用。

也可在项目根目录用已安装包的 Bun CLI 直接诊断：

```sh
bun ./node_modules/@slkiser/opencode-quota/dist/bin/opencode-quota.js status
```

OpenCode/Bun 与 Node 的网络栈可能表现不同；排查插件实际运行环境时优先参考 Bun 结果。诊断输出中的 `needs-auth` 或 unavailable 应按原样处理，不应猜测额度。

## 限制

- 连接远程 OpenCode server 时，本地模型用量仍来自运行 TUI 机器上的 `opencode db path`，不支持读取远程 server 数据库。
- 默认 wrapper `server.js` 仍转发原版 `@slkiser/opencode-quota` server；新的 TUI 入口自行拥有界面注册，因此不保证保留上游原生 TUI 的 slash menus。
- 上游额外提供商的支持范围、认证要求和接口由 [`@slkiser/opencode-quota`](https://github.com/slkiser/opencode-quota) 维护。
- 本项目通过 npm 依赖使用上游包，没有复制或 vendoring 其源码；许可与实现归上游项目维护。

## 回滚

分别从全局 `opencode.json` 和 `tui.jsonc` 删除本项目的 `server.js`、`tui.jsx` 两个 `file://` 条目并重启 OpenCode；不要删除其他插件项。本机额度配置不属于仓库。

## 测试

```sh
npm run test:all
```

以当前 `package.json` 中的 `test:all` 及其子脚本为准；它会运行项目现有的后端、wrapper 和 TUI 验证。可用 `OPENCODE_TEST_TMPDIR=/writable/temp/path` 指定测试临时目录。
