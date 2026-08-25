权威设计：docs/ROADMAP.md Phase 9「Chrome extension browser bridge」

## 目标

新增一个 Chrome Extension browser transport，让 gpt-loop 能通过用户日常已登录
ChatGPT 的 Chrome tab 发消息、读回复，而不需要 gpt-loop 自己启动/接管一个
Chrome 实例。Jack 会看到：装好这个扩展后，把 `GPT_BROWSER_MODE` 设成
`extension`，`npm run ask` / GPT review 请求会通过他自己浏览器里已登录的
ChatGPT tab 完成，不再需要独立的 Chrome profile 或 CDP 启动参数。现有
`launch`/`cdp` 两种模式行为不变，默认值不变。

## 文件改动清单

改：

- `package.json` — 新增依赖 `ws`（`^8.18.0`），Node 20 无内建 WebSocket
  server API，`ws` 是唯一合理选项；同步更新 `package-lock.json`。
- `src/config.js` — `browserMode` 枚举加 `'extension'`；新增字段
  `extensionHost`（默认 `127.0.0.1`）、`extensionPort`（默认 `8877`）、
  `extensionConnectTimeoutMs`（默认 `15000`）；对应环境变量前缀
  `GPT_LOOP_EXTENSION_*`，解析方式复用现有 `parseIntEnv`。
- `src/orchestrator/adapters/gptReviewerAdapter.js` — `askGptFn` 默认值从
  硬绑定 `chatgptWeb.askGpt` 改为 `askGptFn ?? resolveAskGpt(effectiveConfig)`；
  `review()` 签名、prompt 构造、`parseReviewResult`、`AdapterError` 映射规则
  全部不动。
- `tests/gptReviewerAdapter.test.js` — 追加 1 个用例：`browserMode:
  'extension'` 且不传 `askGptFn` 时，`resolveAskGpt` 解析出的函数被调用
  （不是默认的 Playwright `askGpt`）。

新增：

- `src/bridge/extensionProtocol.js` — 协议常量（`PROTOCOL_ID =
  'gpt-loop-extension/v1'`）、消息 envelope 构建/校验的纯函数、错误码常量。
  Node 侧（server）和浏览器侧（extension）都引用各自一份文件（见下方
  extension 目录说明），字段定义必须逐字段一致，不共享同一份物理文件
  （extension 沙箱不能 `import` `src/` 下的文件）。
- `src/bridge/extensionServer.js` — localhost WebSocket server 的生命周期：
  惰性启动（首次 `askGpt` 调用时）、进程内单例、单一 active connection
  （新连接握手成功后关闭旧连接）、`Origin` header 校验、request/response
  关联表、pending request 超时清理。
- `src/bridge/chatgptExtension.js` — 导出与 `chatgptWeb.js` 同签名的
  `askGpt(prompt, config) -> Promise<string>`，内部调用
  `extensionServer.js`，把协议错误码映射成 `src/bridge/errors.js` 既有的
  错误类（映射表见下方“错误映射”）。
- `src/bridge/transport.js` — 导出 `resolveAskGpt(config)`：
  `config.browserMode === 'extension'` 返回 `chatgptExtension.askGpt`，否则
  返回 `chatgptWeb.askGpt`。
- `extension/manifest.json` — Manifest V3。
- `extension/background.js` — service worker（`"type": "module"`），WS
  client + tab 查找 + 转发 content script。
- `extension/content.js` — 注入 `https://chatgpt.com/*` 的 classic content
  script；不含 DOM 交互逻辑本体，只负责 `chrome.runtime.onMessage` 接线，
  用 `chrome.runtime.getURL('domActions.js')` 动态 `import()` 拿到纯逻辑函数
  后调用（见“content script 与测试共享逻辑”一节）。
- `extension/domActions.js` — ES module，`export` 出
  `findComposer`/`sendPrompt`/`waitForReply` 三个纯函数（接受注入的
  `document`/`sleep`，不引用任何 `chrome.*` 全局），列进
  `manifest.json` 的 `web_accessible_resources`；这是 Node 测试
  `import` 的同一份文件，不重复维护第二份。
- `extension/README.md` — 安装扩展、启动本地 bridge、跑一次 review 的步骤。
- `tests/extensionProtocol.test.js` — 协议 envelope 构建/校验 + server
  握手/单连接/pending-request 超时清理的测试。
- `tests/extensionDomActions.test.js` — `extension/domActions.js` 三个函数
  的 mock-DOM 测试（假 `document`，不启动真实浏览器）。
- `tests/extensionBridge.test.js` — 用真实 `ws` 客户端连一个随机端口的
  `extensionServer`，驱动 `chatgptExtension.askGpt` 走完整成功路径 + 错误
  映射路径 + 无连接超时路径。

不动：`src/bridge/chatgptWeb.js` / `chromeRuntime.js` / `chromeProfile.js` /
`diagnostics.js` / `visibility.js`、`src/orchestrator/**`（除上面那一处
`askGptFn` 默认值改动）、`src/orchestratorCli.js`、`src/mcp/server.js`、
`bin/**`、`docs/workflow/ADAPTER_INTERFACE.md`（接口契约本身未变，无需改）。

## 通信协议（决定版，不留开放项）

### 拓扑

gpt-loop（Node）在 `config.extensionHost:config.extensionPort`（默认
`127.0.0.1:8877`）启动 WebSocket server，惰性启动、进程内单例。Chrome
extension 的 background service worker 主动连接该地址。同一时刻只接受一个
active connection：新连接握手成功后，server 主动关闭旧连接（`code: 4000,
reason: 'replaced by newer connection'`）。

**安全边界**：即使只监听 loopback，任意本机网页都能用 `new
WebSocket('ws://127.0.0.1:8877')` 发起连接（WebSocket 不受同源策略/CORS
限制）。Server 在 WS upgrade 阶段校验 `Origin` header 必须等于
`chrome-extension://<EXTENSION_ID>`；`EXTENSION_ID` 通过
`GPT_LOOP_EXTENSION_ID` 环境变量配置（扩展在 `chrome://extensions` 里的固定
ID，装完扩展后 Jack 需要复制一次填进本地环境变量，`extension/README.md`
写清楚这一步）。`Origin` 不匹配的连接直接拒绝 upgrade（HTTP 403），不建立
WS 连接。不做 token pairing（Origin 校验对本地单机场景已经足够，token
交换机制需要额外的配对 UI，超出 Phase 1 范围）。

### 消息 envelope

```json
{
  "protocol": "gpt-loop-extension/v1",
  "type": "hello | hello_ack | request | response | error",
  "requestId": "string",
  "payload": {},
  "error": { "code": "string", "message": "string" }
}
```

- `hello`（extension → server，连接建立后立即发）：
  `payload: { extensionVersion, capabilities: ["chatgpt-dom-v1"] }`，
  `requestId` 为该连接的随机 id。
- `hello_ack`（server → extension）：`payload: { serverVersion: "1" }`。
  握手完成前 server 不认为该连接是 active connection（不会转发请求给它）。
- `request`（server → extension）：
  `payload: { prompt: string, chatgptUrl: string, responseTimeoutMs:
  number }`。`chatgptUrl` 取自 `config.chatgptUrl`（与 Playwright 路径同一个
  配置项），extension 只允许操作匹配该 origin 的 tab，不导航到任意页面。
- `response`（extension → server，成功）：`payload: { text: string }`。
- `error`（extension → server，失败）：`error: { code, message }`。

错误码集合（extension 侧只允许产出这些码，多余码 server 视为
`INTERNAL_ERROR`）：`NO_CHATGPT_TAB`、`LOGIN_REQUIRED`、
`COMPOSER_NOT_FOUND`、`SEND_BUTTON_NOT_FOUND`、`RESPONSE_TIMEOUT`、
`RESPONSE_EMPTY`、`INTERNAL_ERROR`。

### 超时与并发

- `extensionConnectTimeoutMs`（默认 15000）：`askGpt` 调用时若没有已握手的
  active connection，等待这么久，超时后抛 `ChromeUnavailableError`。
- `responseTimeoutMs`（复用现有配置字段，默认 120000）：随 `request`
  一起传给 extension；extension 侧的 `waitForReply` 用同一个值做 deadline。
- `requestTimeoutMs`（复用现有配置字段，默认 450000）：`chatgptExtension.js`
  用现成的 `chromeRuntime.js` 里的 `withTimeout` helper 包住整个
  `askGpt` 调用，语义与 Playwright 路径完全一致。
- **并发策略（决定版）**：server 内部维护一个 FIFO 队列，同一时刻只向
  extension 发出一个 in-flight `request`；后续 `askGpt` 调用若已有请求在
  处理中，排队等待，受各自的 `requestTimeoutMs` 限制（排队超时即该次调用的
  `RequestTimeoutError`，不影响队列里其它请求）。不引入新的 `BUSY`
  协议错误码——排队本身对调用方透明，只是延迟增加。
- WS 连接断开：所有 pending request（包括排队中的）立即结算为
  `ChromeUnavailableError`；不复用旧连接对象，等待下一次握手成功的新连接。

### 错误映射（`chatgptExtension.js` 唯一负责这一层）

| 协议错误码 / 本地情况 | 映射到的 `src/bridge/errors.js` 类 |
|---|---|
| 无 active connection（`extensionConnectTimeoutMs` 超时）、`NO_CHATGPT_TAB`、连接断开、`INTERNAL_ERROR` | `ChromeUnavailableError` |
| `LOGIN_REQUIRED` | `LoginRequiredError` |
| `COMPOSER_NOT_FOUND`、`SEND_BUTTON_NOT_FOUND` | `SelectorMismatchError` |
| `RESPONSE_TIMEOUT` | `ResponseTimeoutError` |
| `RESPONSE_EMPTY` | `ResponseExtractionError` |
| `askGpt` 整体 `requestTimeoutMs` 到期（`withTimeout` 触发） | `RequestTimeoutError` |

`gptReviewerAdapter.js` 现有的 catch 逻辑（`ResponseTimeoutError` /
`RequestTimeoutError` → `REVIEWER_TIMEOUT`；其余 `TransportError` →
`REVIEWER_UNAVAILABLE`）不需要改一行代码——这正是选择复用既有错误类而不是
发明新类型的原因。

## Chrome Extension 内部结构

**Manifest V3 权限**：`permissions: ["tabs", "scripting"]`，
`host_permissions: ["https://chatgpt.com/*"]`，不申请 `<all_urls>`。
`background.service_worker` 用 `"type": "module"`（MV3 service worker 支持
ESM，可以 `import` `extension/protocol.js`）。`content_scripts` 匹配
`https://chatgpt.com/*`，`js: ["content.js"]`，`run_at: document_idle`。

**background.js**：

1. 连 `ws://<extensionHost>:<extensionPort>`（硬编码默认值与
   `config.js` 一致，`extension/README.md` 注明改端口需要两侧同步改）；
   `onopen` 发 `hello`；`onclose`/`onerror` 2000ms 后重连（固定间隔，不做
   指数退避——本地场景足够，Phase 1 不做更复杂的重连策略）。
2. 收到 `request` → `chrome.tabs.query({ url: 'https://chatgpt.com/*' })`
   找 tab，优先取最近激活的一个（`lastAccessed` 最大）；找不到 → 回
   `NO_CHATGPT_TAB`。
3. `chrome.tabs.sendMessage(tabId, { type: 'perform', requestId, prompt,
   responseTimeoutMs })`；若 `sendMessage` 抛出（content script 未注入/无
   响应端，2 秒内判定）→ 回 `NO_CHATGPT_TAB`（不新增独立错误码，未注入
   content script 等价于"这个 tab 用不了"）。
4. 把 content script 的响应原样转成 `response`/`error` envelope 发回
   server。
5. 同一时间只处理一个 in-flight tab 交互（server 的 FIFO 队列已经保证不会
   并发发多个 `request`，background 不需要自己再加锁）。

**content.js**（classic script，不含核心逻辑，只做接线）：

```js
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type !== 'perform') return false;
  import(chrome.runtime.getURL('domActions.js')).then(async (mod) => {
    try {
      const composer = await mod.findComposer(document, COMPOSER_SELECTORS, { timeoutMs: 5000 });
      if (!composer) return sendResponse({ ok: false, code: 'LOGIN_REQUIRED' });
      await mod.sendPrompt(document, composer, msg.prompt, SEND_BUTTON_SELECTORS);
      const text = await mod.waitForReply(document, { responseTimeoutMs: msg.responseTimeoutMs }, baselineCount, {...});
      sendResponse({ ok: true, text });
    } catch (err) {
      sendResponse({ ok: false, code: err.code ?? 'INTERNAL_ERROR', message: err.message });
    }
  });
  return true; // keep the message channel open for the async response
});
```

（示意代码，非最终实现；实现时选择器常量、baseline 计数逻辑按
`extension/domActions.js` 的实际签名对齐。）

**`extension/domActions.js`（选择器与算法，与 `chatgptWeb.js` 现有值对齐）**：

- composer selectors：`['#prompt-textarea', 'div[contenteditable="true"].ProseMirror']`
- send button selectors：`['[data-testid="send-button"]', 'button#composer-submit-button']`
- stop button selectors：现有三个（`chatgptWeb.js:16-20`）
- assistant message selector：`'[data-message-author-role="assistant"]'`
- `findComposer(doc, selectors, opts)`：5 秒内轮询 `doc.querySelector`，找不到
  返回 `null`（content.js 把 `null` 映射成 `LOGIN_REQUIRED`——Phase 1
  简化：composer 缺席即视为登录墙，不做更精细区分，`extension/README.md`
  写明这一限制）。
- `sendPrompt(doc, composer, prompt, sendSelectors)`：`composer.focus()` +
  `document.execCommand('insertText', false, prompt)` 触发原生 `input`
  事件；找到发送按钮就点击，找不到就 dispatch `Enter` keydown。
- `waitForReply(doc, { responseTimeoutMs }, baselineCount, opts)`：移植
  `chatgptWeb.js` 现有的"assistant count 超过 baseline + stop 按钮消失 +
  文本连续 1200ms 不变"算法，`page.locator(...).count()` 换成
  `doc.querySelectorAll(...).length`，`page.waitForTimeout` 换成注入的
  `sleep` 函数（供测试用假计时器）。deadline 到期时：有文本 → 抛
  `{code:'RESPONSE_TIMEOUT'}`；无文本 → 抛 `{code:'RESPONSE_EMPTY'}`
  （与 Playwright 路径的 `ResponseTimeoutError`/`ResponseExtractionError`
  区分逻辑保持一致）。

**日志**：background/content 的 `console.log` 只记录阶段名（找 tab、找
composer、发送、等待、完成/失败 code），不记录 prompt 内容或回复全文，避免
把审查任务内容写进 Chrome 的扩展日志。

## 测试方案

- `tests/extensionProtocol.test.js`：`extensionProtocol.js` 的
  envelope 构建/校验纯函数用例（合法/非法字段、未知 `type`、`protocol`
  版本不匹配）；`extensionServer.js` 的握手、单 active connection 替换旧
  连接、pending request 超时清理，用真实 `ws` 库在随机端口起 server +
  连假客户端来测（不需要 mock，`ws` 本身够轻）。
- `tests/extensionDomActions.test.js`：仿 `tests/waitForReply.test.js` 的
  `createFakePage` 手法，对 `extension/domActions.js` 的
  `findComposer`/`sendPrompt`/`waitForReply` 各写 2-3 例（找到/找不到
  composer、发送成功、回复超时有文本/无文本两种 code）。
- `tests/extensionBridge.test.js`：起真实 `extensionServer`（随机端口）+
  真实 `ws` 客户端模拟 extension，跑 `chatgptExtension.askGpt` 的成功路径 +
  每类错误码的映射路径（表驱动，覆盖“通信协议”一节的错误映射表全部 6 行）+
  无连接超时路径（`extensionConnectTimeoutMs` 调小到几十毫秒）。
- `tests/gptReviewerAdapter.test.js` 追加：`browserMode: 'extension'`
  时 `resolveAskGpt` 解析出的函数被使用（通过给
  `createGptReviewerAdapter` 传一个能替换 `transport.js` 解析结果的手段，
  或直接验证不传 `askGptFn` + `browserMode: 'extension'` 时调用的是
  `chatgptExtension.askGpt` 而非 `chatgptWeb.askGpt`——用现有文件里
  `mock.method`/依赖注入风格实现，具体手法照抄本文件里其它用例的写法）。

验收：`npm test` 全绿，含以上 4 个新增/追加测试文件，且 `browserMode:
'launch' | 'cdp'` 两条既有路径的现有测试断言不变（回归为零）。

## 执行步骤

1. `package.json` 加 `ws` 依赖，`npm install` 更新 lockfile。
2. `src/config.js`：加 `'extension'` 枚举值 + 3 个新字段 + env 解析。
3. `src/bridge/extensionProtocol.js`：协议常量 + 校验函数（Node 侧）。
4. `src/bridge/extensionServer.js`：server 生命周期 + 队列 + 超时清理。
5. `src/bridge/chatgptExtension.js`：`askGpt` 入口 + 错误映射。
6. `src/bridge/transport.js`：`resolveAskGpt`。
7. `src/orchestrator/adapters/gptReviewerAdapter.js`：接入
   `resolveAskGpt`（1 处改动）。
8. `extension/domActions.js`：纯 DOM 逻辑（先写这个，因为 Node 测试和
   content.js 都依赖它）。
9. `extension/manifest.json` / `background.js` / `content.js` /
   `README.md`。
10. 四个测试文件（`extensionProtocol` / `extensionDomActions` /
    `extensionBridge` / `gptReviewerAdapter` 追加例）。
11. `npm test` 全绿。

## Commit 拆分

单笔 commit：`feat: add a Chrome extension transport for the GPT browser
bridge`，包含上述“执行步骤”1-11 全部文件。

**为什么不拆多笔**：`extensionDomActions.test.js` 依赖
`extension/domActions.js` 存在，`extensionBridge.test.js` 依赖
`extensionServer.js` + `chatgptExtension.js` 都存在，`gptReviewerAdapter`
追加例依赖 `transport.js` 存在——这条改动链任何一处中间态都无法独立跑通
`npm test`，拆多笔只会制造挂红的中间 commit，不满足"每笔可独立验收"的
工程原因。整个改动面（约 10 个新文件 + 3 处小改）也没有大到必须拆分复审。

## 执行分工表

| 任务 | 负责 AI | 依赖 | 可否并行 | 备注 |
|---|---|---|---|---|
| Commit 1: 全部改动（config/protocol/server/adapter 接线/extension 目录/4 个测试文件） | Claude | — | 否（单笔完整实现） | 见下方 Claude Editable Snapshots |

本次改动面小、耦合紧（协议 envelope 形状被 server/adapter/测试三处同时
依赖，拆给两个 AI 并行反而增加协议漂移风险），**不派 Codex 做实现**，
Codex 的角色在这份 handoff 里已经通过设计对抗（`tmp/codex-plan-extension-
bridge.md`）完成。执行完成后的 §4.c 代码评审仍必须派 Codex（见下方验收
checklist）。

## 验收 checklist

- [ ] `npm test` 全部通过（现有测试文件 0 断言变化 + 4 个新增/追加测试）。
- [ ] `GPT_BROWSER_MODE=launch`（默认，不设置该变量）行为与改动前逐字节
      相同——跑一次现有 `tests/gptReviewerAdapter.test.js` 里非 extension
      的用例确认。
- [ ] `extension/` 目录能在 Chrome「加载已解压的扩展程序」直接加载，无需
      任何构建步骤。
- [ ] `extension/README.md` 覆盖：装扩展 → 复制 Extension ID 设进
      `GPT_LOOP_EXTENSION_ID` → 跑一次 `GPT_BROWSER_MODE=extension npm run
      ask -- "..."` 触发 server 启动 → 扩展重连成功 → 请求跑完并返回文本。
- [ ] Codex 完成一轮 §4.c 代码评审（实现者不审自己的工作），findings 收敛
      到无新问题。

## 启动指令

```text
消费 handoff docs/handoff/2026-08-25-chrome-extension-bridge.md：按其“执行步骤”实现 Chrome extension browser bridge，完成后跑 npm test 并交叉评审。
```

## Execution Context

### Claude Editable Snapshots

- `src/config.js`（现状见本 handoff 上方"通信协议"引用的字段；改动点：
  `BROWSER_MODES` 集合加 `'extension'`，`DEFAULTS` 加
  `extensionHost/extensionPort/extensionConnectTimeoutMs` 三个字段，
  `loadConfig` 加对应三行 env 解析，规划侧 `git commit hash`:
  `a4507891c4638d348bc654e41cb914b2806b20b4`）。当前文件全文已在本次设计
  会话中读取，见上方"现状"引用；改动是纯增量（加枚举值 + 加字段），不删除
  任何现有字段/行为。
- `src/orchestrator/adapters/gptReviewerAdapter.js`（规划侧 hash：
  `a4507891c4638d348bc654e41cb914b2806b20b4`）。待改声明：
  `createGptReviewerAdapter` 函数体第一行
  `const askGptImpl = askGptFn ?? resolveAskGpt(effectiveConfig);`，并把函数体内
  `await askGptFn(prompt, effectiveConfig)` 改成 `await askGptImpl(prompt,
  effectiveConfig)`。相邻的 import 需加一行
  `import { resolveAskGpt } from '../../bridge/transport.js';`；原有
  `import { askGpt } from '../../bridge/chatgptWeb.js';` 这一行删除
  （不再作为默认参数值使用，`askGptFn` 参数不再有默认值）。
- `src/bridge/errors.js`、`src/bridge/chatgptWeb.js`（`waitForReply` 算法、
  selector 常量）：不修改，仅作为 `extension/domActions.js` 和
  `chatgptExtension.js` 的行为参考，全文已在本 handoff 上方内联/引用。

### Codex Dispatch Briefs

N/A — 本轮不派 Codex 做实现（见"执行分工表"说明：协议耦合紧，单笔由
Claude 完成更安全）。执行完成后仍需派 Codex 做一轮 §4.c 代码评审，但
评审 brief 按 `dispatch.md §2` 在评审发起时现写（review brief 只给"改了
哪些文件 + 意图"，不能在方案阶段预先写死，因为要引用届时的实际 diff）。

### Pre-flight Token Estimate

N/A（无 Codex 实现 brief）。届时的 §4.c 评审派发需在评审会话里现走一遍
`dispatch.md §3` 的 pre-flight 表（review brief 的 token 估算依赖实际 diff
行数，规划阶段无法预估）。
