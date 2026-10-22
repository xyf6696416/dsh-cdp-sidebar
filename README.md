# dsh-cdp-sidebar — 把 9222 上的 Chrome 镜像进 DSH 右侧栏

用 `chrome-devtools` MCP（CDP）操作的那个 Chrome，在 DSH 右侧栏里实时显示画面，
并把侧栏里的鼠标 / 键盘操作回传给同一个 Chrome 页面。
**侧栏自动跟随 MCP 正在操作的那个页面**：MCP 开新 tab 或导航，侧栏自己切过去，没有任何导航按钮。

```
chrome-devtools MCP ──CDP──▶ Chrome @127.0.0.1:9222
                                 ▲
                    screencast 帧 │ │ 输入事件
                                 ▼
DSH 右侧栏 browser tab ── 宿主桥 /dsh-cdp/ws ── DSH Web 宿主
```

侧栏不截图、不抓 DOM：它订阅 `Page.startScreencast`，把 JPEG 帧画到 `<canvas>`，
再把 canvas 上的坐标换算成页面可视视口坐标，用 `Input.dispatchMouseEvent` /
`Input.dispatchKeyEvent` / `Input.insertText` 送回页面。MCP 那边导航、点击，
侧栏画面同步跟着变。

---

## 安装 / 运行 / 校验

```powershell
# 1. 包复制到 <DSH_HOME>\plugins\
Copy-Item .\bundle\dsh-cdp-sidebar "$env:USERPROFILE\.dsh\plugins\" -Recurse

# 2. profile 的 node_modules 里建 junction（Windows 上必须用绝对路径）
New-Item -ItemType Junction `
  -Path "$env:USERPROFILE\.dsh\profiles\desktop\node_modules\dsh-cdp-sidebar" `
  -Target "$env:USERPROFILE\.dsh\plugins\dsh-cdp-sidebar"
```

再在 `<DSH_HOME>\profiles\<profile>\package.json` 里加两处：

```jsonc
{
  "dependencies": { "dsh-cdp-sidebar": "file:../../plugins/dsh-cdp-sidebar" },
  "dsh": { "profile": { "bundles": ["...", "dsh-cdp-sidebar"] } }
}
```

**运行**：让 Chrome 带 `--remote-debugging-port=9222` 和独立 `--user-data-dir` 起来 →
重启 DSH → 右侧栏新建 tab 选「Chrome（CDP）」。侧栏自己镜像当前页，不用按任何按钮。
它是一个独立 tab 类型，**不会顶替浏览器**：会话里点链接仍然打开沙箱浏览器。

**校验**，四条全绿即装好：

| # | 命令 | 期望 |
| --- | --- | --- |
| ① | `curl.exe -s http://127.0.0.1:19387/dsh-cdp/status` | `"ok":true`、`targets` 非空、`bridge:"/dsh-cdp/ws"` |
| ② | `curl.exe -s "http://127.0.0.1:19387/dsh-cdp/shot?quality=62"` | `"ok":true` + 几十 KB JPEG（轮询通道通） |
| ③ | `curl.exe -s http://127.0.0.1:19387/dsh-cdp/diag` | `handshake:101`、`result:已连上 Chrome`、`closeReason:null`、`pollSessions:0`（桥通） |
| ④ | 肉眼看侧栏 | 状态灯 `已镜像`、URL 正确、点 canvas 有反应、中文能输入 |

① 返回 `ok:false` → Chrome 没带调试端口；① 返回 404 → 插件没装载，查 junction 与 `bundles` 并确认真重启过。
出问题先看 `diag.reports`，那是客户端上报的失败原文。

---

## 1. 组成

| 文件 | 半侧 | 作用 |
| --- | --- | --- |
| `index.js` | Host（Node） | `GET /dsh-cdp/status` 探测 CDP；`upgrade /dsh-cdp/ws` 同源 WebSocket 桥；`GET /dsh-cdp/shot` + `POST /dsh-cdp/exec` HTTP 兜底；`POST /dsh-cdp/report` 客户端上报；`GET /dsh-cdp/diag` 诊断；`TabKeeper` 标签页归属与回收（`/tabs`、`/tab/claim`、`/tab/touch`、`/tab/release`、`/tab/reap`，见 §4.1） |
| `client.js` | Web（浏览器） | 注册自己的 `cdp` tab 类型 + 正文/标题座位 + 状态行 + canvas + 自动跟随 |
| `cordis.patch.yml` | Host | 一行 insert，让 `index.js` 进入组合 |
| `package.json` | — | `dsh.bundle.patch` + `dsh.client {platform:'web', immediately:true, inject:[]}`（依赖由 `client.js` 的 `inject` 声明服务名） |
| `locale/{zh,en}.json` | — | 插件卡片文案 |

### tab 类型为什么是 `cdp` 而不是 `browser`

`sidebarRightTabs` 的 band 规则是：`extension` 可以注册一个 `builtin` 已持有的 kind，并**接管**它
（`coexists()` 允许两者共存，`RANKS = { extension: 3, builtin: 2, fallback: 1 }` 让 extension 胜出）。

官方 `@deepseek-ai/dsh-client-ui-sidebar-browser` 用的是 `kind: 'browser'` / `priority: 'builtin'`。
如果本插件也注册 `kind: 'browser'` 并给 `priority: 'extension'`，整个 `browser` kind 会被接管，
**会话里点链接打开的就不再是沙箱浏览器，而是镜像 tab**。所以这里用自己的 `kind: 'cdp'`，
`priority: 'builtin'`（独占自己不冲突的 kind），官方浏览器行为原样保留。

### 两条画面通道

| 通道 | 路径 | 帧来源 | 输入回传 |
| --- | --- | --- | --- |
| 实时（首选） | `ws → /dsh-cdp/ws` 桥 | `Page.startScreencast` | 同一条 WS 上的 `Input.*` |
| 轮询（兜底） | `GET /dsh-cdp/shot`、`POST /dsh-cdp/exec` | `Page.captureScreenshot`，约 1 帧/秒 | `POST /dsh-cdp/exec` |

轮询通道只用普通 HTTP，**完全不依赖 `ws://`**：宿主环境屏蔽 WebSocket、
或桥握手失败时自动切过去（侧栏没有手动切换按钮，切过去是自动的）。
`/exec` 有方法白名单，只放行 `Page.*` / `Input.*` / `Runtime.evaluate` / `Target.activateTarget`。

### 轮询通道的宿主侧连接池（`PollSessions`）

轮询最初每次 `/shot` 都**新开一条到 Chrome 的上游 WS**：`Target.attachToTarget` 刚建好，
连接就随请求结束被拆掉，下一帧又要重来一遍，实测连续 16 次 `502 shot CDP 超时 Page.captureScreenshot`，
而同一时刻直连 `Page.captureScreenshot` 只要 73–251 ms。现在改成：

- 每个 target 一条**常驻**上游 WS + 一次 `Target.attachToTarget{flatten:true}`，会话 id 复用；
- 同一 target 的调用挂在 `entry.chain` 上**串行**，不并发抢同一条连接；
- 连接死了（`rpc.alive()` 为假）才重建；调用出错重试一次；
- `/shot` 用 `shotInFlight` 去重：同一 target 并发请求共享同一次抓取；
- 客户端侧 `pollBusy` 闸门：上一帧没回来就不发下一帧。

实测（独立 harness）：20 次串行 `/shot` 全 200，
延迟 min/median/max = **86 / 100 / 133 ms**，每帧 `jpeg=48076B`；
5 个并发 `/shot` 在 **129 ms** 内一起返回；3 个并发 `POST /exec Input.dispatchMouseEvent` 全 `200 ok=true`；
`diag.pollSessions = 1`。


## 2. 前置：让 Chrome 带调试端口起来

需要让 Chrome 带着下面这组参数起来：

```
--remote-debugging-port=9222
--user-data-dir="<你的独立目录，例如 %LOCALAPPDATA%\cdp-profile>"
--no-first-run --no-default-browser-check
```

`--remote-allow-origins` 不是必需的：桥默认不发 Origin 头（见下表）。只有走到「浏览器直连 9222」
这条退路时才需要它，值要写成 DSH 的实际 origin。

要点（实测，Chrome 155.0.8059.79）：

- DevTools 的 WS 端点对 Origin 的判定：
  | 上游 Origin 头 | 结果 |
  | --- | --- |
  | **不发 Origin 头** | `101 接受` |
  | `http://127.0.0.1:19387` / `http://localhost:19387`（白名单内） | `101 接受` |
  | `http://127.0.0.1:8791`、`http://127.0.0.1:9222`、`http://evil.example` | `HTTP 403` |
  | `Origin: null` | 连接被挂断 |
- **桥默认不发 Origin 头**，所以桥能不能连上 Chrome，与 GUI 的 host/port、
  与快捷方式里的白名单彻底无关。这是之前「侧栏没画面」的根因修复点。
- `--remote-allow-origins` 仍然保留：它只影响「浏览器直连 9222」这条退路（桥不可用时才走）。
- `--remote-allow-origins` **只能出现一次**，多个 origin 用逗号分隔在一个 flag 里。
  写成两个 flag 时两个 origin 都会被拒。
- 没有这个 flag 时，任何带 Origin 的 WS 升级都被拒（403），MCP 也连不上。
- `--user-data-dir` 必须是独立目录：同一个 profile 已经在跑时，新启动会移交给它，
  调试端口永远不会开。要用这个链路，先退掉那个 profile 的 Chrome。


## 3. 安装 / 卸载

三件事，做完重启 DSH：

1. 包目录放进 `<DSH_HOME>\plugins\dsh-cdp-sidebar`
2. `<DSH_HOME>\profiles\<profile>\node_modules\dsh-cdp-sidebar` 建 junction（Windows）
   或 symlink 指向它
3. `<DSH_HOME>\profiles\<profile>\package.json`：
   - `dependencies."dsh-cdp-sidebar" = "file:../../plugins/dsh-cdp-sidebar"`
   - `dsh.profile.bundles` 追加 `"dsh-cdp-sidebar"`

卸载：删掉那个 junction 与 package.json 里的这两处条目，重启。

`profiles\desktop\node_modules` 是 pnpm 装出来的真实目录（桌面壳也一样），
所以 junction 这条路两边都成立。宿主侧 `index.js` 只在组合时装载，改完必须重启。
可选环境变量（DSH 进程）：

| 变量 | 默认 | 作用 |
| --- | --- | --- |
| `DSH_CDP_URL` | `http://127.0.0.1:9222` | CDP 地址，只允许 `127.0.0.1` / `localhost` / `::1` 的 http |
| `DSH_CDP_WS_ORIGIN` | **不设（不发 Origin 头）** | 显式设置后，宿主连 Chrome 时才带这个 Origin；必须落在 Chrome 的 allow-origins 里 |

## 3.1 排障：不用 GUI 也能读到的诊断口

```
GET  http://127.0.0.1:19387/dsh-cdp/diag
POST http://127.0.0.1:19387/dsh-cdp/report   {"phase":"...","via":"...","bridge":"...","error":"...","note":"..."}
```

| 字段 | 内容 |
| --- | --- |
| `base` / `canBridge` / `wsPath` / `envOrigin` | 宿主看到的 CDP 地址、是否注册了 upgrade 路由、桥路径、`DSH_CDP_WS_ORIGIN` |
| `webServerApi` | 宿主 `webServer` 对象上实际存在的字段（确认 `registerUpgrade` 这条路真的挂上了） |
| `requests`（最近 25 条） | 每条 `/dsh-cdp/*` 的 `method / path / host / origin / upgrade / secWebSocketVersion / hasWsKey / referer` 与响应结果 |
| `sessions`（最近 15 次） | 桥会话：握手结果、Chrome 是否可达、上游 Origin 用法、关闭原因、转发帧数；`framesToClient`（Chrome→侧栏，>400B 的文本帧计数）、`framesToUpstream`（侧栏→Chrome 的帧计数）、`discoverSent`（侧栏是否发过 `Target.setDiscoverTargets{discover:true}`）、`attached`（侧栏请求 `Target.attachToTarget` 的 targetId 序列，最近 12 条） |
| `reports`（最近 15 条） | 侧栏客户端自己上报的失败原因（页面 origin、桥地址、`WebSocket` 报错原文） |
| `pollSessions` | 当前常驻的轮询上游连接数 |

侧栏正文里也有一行诊断：状态、通道（bridge / direct / poll）、页面 origin、桥地址、失败原因。

已排除的方向：宿主 upgrade 路由本身没问题 —— 6 种握手变体（最小头、完整浏览器头带
`permessage-deflate`、带 cookie、`Connection: keep-alive, Upgrade`、带白名单 Origin、不发 Origin）
打 `ws://127.0.0.1:19387/dsh-cdp/ws` **全部 101**，而同一时刻 `diag.sessions` 是空的，
说明 GUI 渲染进程发出的那条 `new WebSocket(...)` 没有到达宿主路由；
`POST /dsh-cdp/report` 就是为把客户端那一侧的报错原文捞出来而加的。

### 桥地址候选与自动升级

`/status`、`/targets`、`/diag` 都会返回 `bridgeCandidates`：同源一个（`ws(s)://<请求 Host>/dsh-cdp/ws`），
加上宿主自己 `listenedPort` 上的 `127.0.0.1:<port>` 与 `localhost:<port>`。
客户端按顺序试，每个失败都上报一条 `bridge-attempt-failed`；全失败才退回直连 9222。

轮询通道运行期间，客户端仍会在 **15 s / 40 s / 90 s** 回头试桥（最多 3 次）：
一旦连通就停掉轮询、升回实时通道，并上报 `bridge-retry-ok`；3 次都不通上报 `bridge-retry-gave-up` 后安静下来。
升回实时通道时会重新 `seedTargets` + `enableDiscovery`，自动跟随在兜底期间同样会恢复。

harness 里可用 `HARNESS_BLOCK_UPGRADE=1` 模拟「ws 被掐」：

```
HARNESS_BLOCK_UPGRADE=1 启动 harness              # 桥全失败 → 自动切轮询，画面照常
# 页面不动，重启成不屏蔽模式 → 下一次重试自动连通，状态升回「已镜像」
```

实测序列（`/dsh-cdp/report` 原文）：
`bridge-attempt-failed ×2` → `ws-blocked` → `bridge-retry-failed 第 1/3 次`（+15 s）
→ `第 2/3 次`（+40 s）→ 解除屏蔽后 `bridge-retry-ok`，通道从 `poll` 变 `bridge`。


## 4. 侧栏里有什么

默认只做一件事：**显示 MCP 正在操作的那个页面**。没有地址框、没有前进后退。

| 元素 | 内容 |
| --- | --- |
| 状态灯 + 文案 | `已镜像` / `连不上调试端点` / `轮询画面（HTTP）` 等，只有状态本身 |
| URL 下拉 | 当前被镜像页面的 URL；**点一下展开标签页列表，选哪页就镜像哪页** |
| `⚙` | 诊断行开关（非 live 时自动展开）：状态、通道（bridge / direct / poll）、页面 origin、桥地址、帧计数、失败原因原文 |
| canvas | 目标页面的 screencast 画面；上面可直接点 / 滚 / 打字（含中文，走 `Input.insertText`） |

### 输入透传：点 + 键盘（2026-10-20 修）

以前只有鼠标能用、键盘完全没反应。改完后两条通道（桥 / HTTP 轮询）都走同一套分发规则。

| 输入 | 走的 CDP 命令 | 为什么 |
| --- | --- | --- |
| 可打印字符（含 Shift 后的符号） | `Input.insertText` | 与输入法提交同一条路径，中文 / emoji / 任意字符通吃，不会触发宿主的 IME 分支 |
| Enter / Tab / Backspace / 方向键 / F 键 | `Input.dispatchKeyEvent`，非文本键用 `rawKeyDown` | 这些键要的是**默认行为**（换行、换焦、删字、移光标），必须带 `windowsVirtualKeyCode` + `code` |
| Ctrl / Alt / Meta 组合 | 只送真实按键，不造字符 | 让目标页自己处理快捷键；不额外插入文本 |
| 输入法组字阶段（`isComposing` / keyCode 229） | 不镜像 | 组合过程在宿主窗口的输入法里，镜像不了；落定结果由 `keypress` / `compositionend` 补 |
| 粘贴 | `Input.insertText` | 直接送整段文本，不逐字符重放 |

配套三处修正：

1. **点 canvas 先 `focus()`**：鼠标事件不需要焦点，键盘事件需要。「点得动、打不了字」这条路径就是这里漏了聚焦。
2. **`/exec` 白名单**：原来靠一条正则，`Input.*` 是碰巧被前缀命中的，错误提示里也看不出放行范围。
   现在 `Input.*` 整体放行（鼠标 / 键盘 / `insertText` / `imeSetComposition`），其余走 `EXEC_WHITELIST` 清单。
3. **`/diag` 新增 `input` 段**：桥上一个 `Input.*` 帧都没收到，说明事件根本没离开侧栏；
   收到了但页面没反应，才是分发或目标页的问题。这一项把「侧栏没发」和「发了没到」分开：

```json
"input": { "bridgeSessionsWithInput": 1, "bridgeInputTotal": 27, "execInputs": 0, "lastExecInput": null }
```

桥会话明细里还能看到 `inputSeen`（收到过哪几种 `Input.*`）与 `lastInput`（最后一帧的 key / vk / modifiers / text）。

实测（探针页 + 真 9222 Chrome，从 `client.js` 原样切出键盘分发喂真实事件对象，16/16）：

| 用例 | 结果 |
| --- | --- |
| 英文 `hello` | `value="hello"`，5 次 `input` 事件 |
| 中文 `中文测试` | `value="中文测试"` |
| Shift 字符 `!@A` | `value="!@A"` |
| 数字与连字符 `2024-10` | `value="2024-10"` |
| Backspace | `"abc"` → `"ab"`，页面收到 `keydown` |
| Enter | 页面收到 `keydown` → `keypress` → `beforeinput` → `input` |
| 方向键 | 左移两格后 `aZbc` |
| Ctrl+A | 不插入字符，页面收到 `ctrl` 组合的 `keydown` |
| 组字阶段 `isComposing` | 不落字（等 `compositionend`） |
| Tab | 目标页真换焦（`activeElement` 变到下一个输入框） |
| 命令形状 | 字符只发 `Input.insertText`；Enter 发 `keyDown/vk13` + `keyUp/vk13`；没有「keyDown 带可打印 text」 |

HTTP 通道（真 `index.js` 路由 + 真 9222，8/8）：
`Input.insertText` / `Input.dispatchKeyEvent` 走 `/exec` 均 200 且页面落字；`Target.createTarget` 仍被拒；
`/diag.input` 有记账；`/status` 未受影响。

### 标签页下拉切换

顶栏那行 URL 是一个下拉控件，展开后列出 Chrome 里所有 `page` 目标，每项显示标题 + URL，
当前镜像的那条带 `●` 标记。

| 行为 | 说明 |
| --- | --- |
| 点某一项 | `CdpMirror.switchTo(targetId)`：`detach` 旧会话 → `attach` 新的 → `Page.enable` → 重启 screencast，立刻出画面 |
| 手动优先级 | 选中后 `manualTargetId` 生效 **10 分钟**，期间自动跟随不会把它抢回去（连 `primary` 租约也不压它） |
| 徽标 | 手动态在 URL 旁显示 `手动` 小标签；面板里多一条 `↻ 恢复自动跟随` |
| 自动失效 | 手动目标被关闭 / 到期 / 切换失败 → 标记自动清除，回到「最近被导航」的自动跟随 |
| 默认 | 不点就一直保持原来的自动跟随，行为与之前完全一致 |

已删除的控件：地址框 + 前往、后退、前进、刷新、`在 Chrome 中置前`、`重连`、`轮询画面`、底部文本框 + 送入。
输入由 canvas 直接接管。

### 自动跟随（`Target.setDiscoverTargets`）

桥连通后客户端立刻订阅目标事件，维护 `targetId -> {url,title,updatedAt}`，
按「最近被导航」选目标并 `Target.attachToTarget`，去抖 420 ms：

| 事件 | 判定 |
| --- | --- |
| `Target.targetCreated`（宽限期后） | 新 tab → 跟过去 |
| `Target.targetInfoChanged` 且 url/title 变 | 该页被导航 → 跟过去 |
| `Target.targetInfoChanged` 但 url/title 没变 | 只是 attach 状态变化 → 不动 |
| `Target.targetDestroyed` / `Target.detachedFromTarget` | 当前目标没了 → 退回最近活动的另一个 |
| `type` 不是 `page`（`service_worker` / `browser_ui` / `iframe`） | 不参与 |

**宽限期 2.5 s 是必需的**：实测订阅后 Chrome 会把已存在的全部目标补发成 `targetCreated`
（本机 5 条，其中 page 2 条）。补发的那批时间戳压平到 `seedAt`，不算活动，否则侧栏会乱跳到某个旧标签页。

证据（开发期探针，全部走真实宿主桥 `ws://127.0.0.1:19387/dsh-cdp/ws`）：

| 探针 | 结果 |
| --- | --- |
| `discover-follow-check.mjs` | 8 条断言全过：桥接受 `setDiscoverTargets`；补发 5 条（page 2 条）；新建 tab 出 `targetCreated`；导航出 `targetInfoChanged` 且 url 变；attach 只出 `attachedToTarget`；关 tab 出 `targetDestroyed`（`targetId` 在 `params` 顶层，没有 `targetInfo`）+ `detachedFromTarget` |
| `target-events-dump.mjs` | 逐条打印 create / attach / navigate / close 四个阶段的事件原文 |
| `sessionid-ab-check.mjs` | 带 / 不带 `sessionId` 发 `Target.getTargets`，两种都有完整的 `targetDestroyed` —— Chrome 155 对 `Target.*` 的 sessionId 路由是宽容的，`browserCommand()` 属于加固而非修 bug |
| `follow-logic-unit.mjs` | 把已安装 `client.js` 里的 `CdpMirror` 类原样抽出（691 行），喂入上面实测到的事件序列，15 条断言全过；`attach` 序列 `A → B → C → B`，命令面 `Target.*` 不带 sessionId、`Page.*` 带 sessionId |

轮询兜底通道拿不到目标事件，改为：连续 2 次 `/shot` 失败后查 `GET /dsh-cdp/targets`，
若当前轮询目标已不在列表里就自动切到列表最后一个 page。



## 4.1 标签页生命周期：用完即弃 + 子代理各占一页

一句话：**谁开的、谁在用、用完就关**，三件事分开记账。侧栏只粘住主代理那一页，子代理的页面不抢镜像。

### 归属模型（宿主 `TabKeeper`，`index.js`）

| 类别 | 怎么判定 | 会不会被自动关 |
| --- | --- | --- |
| **受保护（protected）** | 装载时 `GET /json/list` 里已存在的 page 目标；装载时快照失败或 Chrome 重启时把当前页面**重新认领**进来 | 永不 |
| **自动化开的（orphan）** | 只有被显式登记过的才可弃：`POST /dsh-cdp/tab/created`、`POST /tab/claim`，或 `/json/list` 里带 `attached:true` 的新页面；其余拿不准的一律按用户自己的处理 | 闲置超过 `orphanMs`（默认 120 s）且已过观测期才弃 |
| **有人在用（lease）** | `POST /dsh-cdp/tab/claim` 登记 `owner`；每次导航 / `touch` 自动续租 | 租约内不关；超过 `leaseMs`（默认 15 min）没续也没 release → 兜底弃，原因 `租约到期未释放` |
| **永不碰的 url** | `chrome://` / `chrome-untrusted://` / `devtools://` / `view-source:` / `chrome-extension://` | 永不 |
| **侧栏正在镜像的那一页** | 当前 diag 里最新一条 `attached` 的 targetId | 永不（避免把自己正在看的那页关掉） |

三条硬保险（任何一条成立就本轮不关）：

1. 新页面得先被观测到 `confirmMs`（默认 20 s）才具备被弃资格；
2. 一轮最多关 `maxPerTick`（默认 3）个，且关完至少还要剩 1 个页面；
3. 窗口里只剩 1 个页面时一个都不许关——关空最后一个页面，同 profile 的 Chrome 会整个退出。

> 背景（2026-10-20 事故）：桌面快捷方式把用户日常 Chrome 也起在 `9222` + `~/.dsh/chrome-cdp-profile` 上。
> 当时 `seed()` 只在装载那一刻拍快照，一次都没成功 → `protectedCount:0`、`seeded:false`，
> 之后用户手动打开的每个页面都被当成 orphan 关掉，窗口清空后浏览器自杀。
> 现在拿不准的页面一律按「用户自己的」处理：宁可漏关，不可错杀。

### 一个 tab 的完整生命周期

```
主代理 new_page / MCP 开页
        ↓  下一轮 sweep 观察到（track：记 firstSeen / lastChange）
   orphan（可弃，闲置计时开始）
        ↓  POST /dsh-cdp/tab/claim {url|targetId, owner:"sub-1"}
   leased（有人用，闲置计时被租约压住；页面每次导航自动续租）
        ↓  子代理干完，主代理 POST /dsh-cdp/tab/release {owner:"sub-1"}
   关掉（GET /json/close/{targetId}）→ 登记表与 seen 一起清掉 → 审计留一条 {t, targetId, reason, owner, url, chrome}
```

没人 release 也不会漏：租约到期 → 兜底弃；从没 claim 过 → 闲置 120 s 弃。

### 路由（宿主同源 `http://127.0.0.1:19387/dsh-cdp/...`）

| 路由 | 方法 | 作用 |
| --- | --- | --- |
| `/tabs` | GET | 快照：`enabled / cfg / protectedCount / mirrored / primary / tabs[] / reaps[]` |
| `/tab/claim` | POST | `{targetId \| url, owner, purpose, ttlMs}` → 登记租约；`owner:"main"` 即宣布「侧栏粘住这页」；url 可反查 targetId（刚开出来、还没被 sweep 照到也算） |
| `/tab/touch` | POST | `{targetId \| url, ttlMs}` 续租 |
| `/tab/release` | POST | `{owner \| targetId \| all:true}` 释放；**默认只注销租约、页面留着**，要关页必须显式 `close:true` |
| `/tab/created` | POST | `{targetId}` 登记「这一页是侧栏 / 自动化自己开的」——只有登记过的 targetId 才允许被回收；`client.js` 的 `createTarget()` 会自动调用 |
| `/tab/reap` | POST | 立刻跑一轮扫描（不等 tick） |
| `/status` `/targets` | GET | 顺带带 `tabState`；每个 target 行带 `owner / primary / protected / mirrored` |

命令行等价物（`DSH_CDP_BASE` 覆盖宿主地址）：`list | claim | touch | release [--keep] | reap`。

### 开关与阈值（环境变量，宿主装载时读）

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `DSH_CDP_REAP` | 开 | 设 `0` = 完全不回收（只记账不关页） |
| `DSH_CDP_REAP_TICK_MS` | 10000 | 扫描间隔 |
| `DSH_CDP_REAP_ORPHAN_MS` | 120000 | 自动化开的、没人认领，闲置多久即弃 |
| `DSH_CDP_REAP_LEASE_MS` | 900000 | 租约有效期 / 兜底弃时限 |
| `DSH_CDP_REAP_MAX` | 3 | 一轮最多关几个 |
| `DSH_CDP_REAP_CONFIRM_MS` | 20000 | 新页面观测期：在这之前一律不弃（设 `0` 关掉这个缓冲） |

### 侧栏粘住主代理那一页（`client.js`）

- `pickActive()` 先看 `primaryTargetId`：有主代理租约就**只跟它**，别的 tab 导航、新建都不抢镜像。
- `primaryTargetId` 来自 `/status` 的 `tabState.primary`（`start()` 读一次，之后 3 s 一次 `refreshPrimary()` 轮询；桥重连时也重读）。
- 没有 `owner:"main"` 租约时退回原来的「最近被导航」自动跟随，行为跟改动前一致。
- 轮询兜底通道的 `repointPoll()` 同样优先留在 primary 那一页。

### 子代理并发约定（互不打扰）

1. 主代理给每个子代理各开一页，并 `claim` 上 `owner:"sub-N"`；把固定 `pageId` 写进子代理的任务描述里。
2. 子代理只用传给它的那个 `pageId` 干活，**不调 `select_page`、不调 `new_page`**——它没有资格决定侧栏镜像谁。
3. 主代理自己那一页 `claim` 成 `owner:"main"`，侧栏就一直粘住它；子代理页面在导航也不会把画面抢走。
4. 子代理回报完成后，主代理 `release --owner sub-N`（顺手关页）。忘了 release 也有 15 min 兜底。
5. 用户自己窗口里的标签页全程在 protected 名单里，任何一条路径都不会关它。

### 实测证据

| 探针 | 结果 |
| --- | --- |
| 标签页生命周期探针 | 8/8：`Target.getTargets` 每条 page 都带 `browserContextId`；`createBrowserContext` / `disposeBrowserContext` / `createTarget` 可用；`Target.closeTarget` 回 `{"success":true}`（不是 `ok`）；`targetDestroyed` 只在 `setDiscoverTargets{discover:true}` 之后才推 |
| TabKeeper 单元测试 | 22/22：把已安装 `index.js` 里 `const NEVER_REAP_URL … function readJsonBody` 那段原样抽出，配假时钟 + 假 Chrome（只实现 `/json/list` 与 `/json/close/{id}`，close 回纯文本 `Target is closing`）。覆盖：受保护永不关、装载后出现的 `chrome://` 也永不关、闲置过阈值弃、镜像中那个不关、租约内不关 / 到期兜底弃、导航自动续租不被误关、`maxPerTick` 限流、claim 按 url 反查、陌生 url 不乱认领、`orphanMs=0` 完全不回收、审计字段完整 |
| 真实 Chrome 端到端 | 14/14：真 9222 Chrome + 独立 harness（8791，`orphanMs=15s / tick=4s`）。A 认领后闲置 24 s 不关、B 不认领被自动弃且审计里能看到原因、装载时就有的 3 页一个没少、`release --owner` 真的把 A 从 Chrome 里关掉、`owner:"main"` 成为 `primary`、`/status` 带 `tabState`、`/targets` 每行带 `owner/primary/protected`、`release close:false` 只注销租约不关页 |

### 为什么必须显式 claim，不能靠猜

- `Target.getTargets` 里的 `attached` 字段表示「MCP 正握着这页」，活干完了它仍然是 `true` → 当闲置信号会永远不关。
- MCP 的 `select_page` / 快照在桥上**不产生任何 `Target.*` 事件**（实测），所以「跟 MCP 当前附着的那页」这条路走不通；跟随只能由导航 / 新建 / 销毁驱动。
- 结论：谁在用必须说出来（claim），用完必须说（release）；闲置阈值和租约 TTL 只是漏说时的兜底。

### 两个 Chrome 回执的坑（已踩）

- `Target.closeTarget` 回 `{"success":true}`，不是 `ok`。
- `GET /json/close/{id}` 回的是**纯文本** `Target is closing`，不是 JSON；`cdpJson()` 现在解析失败就原样返回文本，审计里那一条记进 `chrome` 字段。

## 5. 已验证的事实（独立 harness）

harness 用真实 `client.js` + 真实 `index.js` 路由，配一个最小 React 替身，
在 `http://127.0.0.1:8791/` 里跑通整条链路：

| 检查 | 结果 |
| --- | --- |
| **根因（旧版）** | 桥的上游 Origin 取请求 `Host` 头 → 页面在 `8791` 时上游 Origin `http://127.0.0.1:8791` 不在白名单 → Chrome `HTTP 403` → 桥回 `dshBridge:failed` 并关闭 → 侧栏显示 `目标已分离`、`0 帧 · 0 KB` |
| **修复** | 上游不发 Origin 头 → 桥 `101` + `已连上 Chrome`，与页面 host 无关 |
| 桥握手（修复后） | `hs=101 chrome=True result=已连上 Chrome upstream=（不发 Origin 头）`，单次会话转发 130+ 帧 |
| 直连被拒 | 页面直连 `ws://127.0.0.1:9222/...` 时 `1006`（Origin 不在白名单） |
| screencast | `phase=live`，canvas 1264×577，帧持续到达并 ack |
| 轮询兜底 | `phase=polling`，`GET /shot` 每 900 ms 一帧（quality 62 约 48 KB），canvas 尺寸不变 |
| 轮询压测 | 20 次串行 `/shot` 全 200，延迟 86 / 100 / 133 ms（min/median/max）；5 个并发 `/shot` 129 ms 内一起返回；3 个并发 `POST /exec` 全 `200 ok=true`；`diag.pollSessions = 1` |
| **轮询超时根因（旧版）** | 每次 `/shot` 新开一条上游 WS，连接随请求结束被拆 → 连续 16 次 `502 shot CDP 超时 Page.captureScreenshot`；同一时刻直连抓取只要 73–251 ms |
| **轮询修复** | `PollSessions` 常驻连接 + `entry.chain` 串行 + `/shot` 去重 + 客户端 `pollBusy` 闸门 |
| **画面上的「水印」** | 不是水印：`S.hint` 提示层 `position:absolute; inset:0` 盖在 canvas 上，把「轮询画面（HTTP）」那段说明压进画面里。现在只在 `stats.frames === 0` 时才画提示层，有画面就不再压字 |
| 轮询下 phase 被翻回 live | `Target.targetInfoChanged` 抢在 `startPolling` 的 emit 之后 → `pollTarget` 存在时跳过该 handler |
| 手动切轮询后的残留提示 | `forcePoll()` 里先 `suppressClose = true` 再 `ws.close()`，不再留下「WebSocket 已关闭（via=poll code=1000）」 |
| ws 被掐的模拟 | `HARNESS_BLOCK_UPGRADE=1` 起 harness：两个桥候选 + 直连 9222（403）全失败 → 自动切轮询，画面照常出帧、目标下拉正常、输入照常回传 |
| 轮询自动升回实时 | 页面不动、把 harness 重启成不屏蔽模式 → 下一次桥重试 `bridge-retry-ok`，状态从 `轮询画面（HTTP）` 变 `已镜像 · Chrome/155.0.8059.79`，通道 `poll` → `bridge` |
| **升级时的状态竞态** | 在途的 `/shot` 那一拍回来时会把 phase 翻回 `polling`（通道已是 bridge、帧在涨，标签却写着轮询）。现在 `tick` 出发时记下 target，回来先比对 `this.pollTarget !== target` 就直接丢弃这一拍 |
| 失败的桥候选不再干扰状态 | `open()` 的 `onclose` 加了 `this.ws !== ws` 守卫：没成为当前通道的连接关闭时不改状态（之前会把兜底轮询翻成「目标已分离」） |
| 轮询下的输入回传 | canvas 点击 → `POST /exec Input.dispatchMouseEvent` → 页面 `mousedown/click` 落在 `139,85`（目标 `140,85`） |
| `/exec` 白名单 | `Target.createTarget` 被拒：`502 不允许的 CDP 方法` |
| 坐标映射 | canvas `(369,499)` → 页面收到 `365,290`；canvas `(173,499)` → `160,290` |
| 滚动后映射 | 滚到 `scrollY=380` 后 canvas 点击仍送 `(395,300)`，`elementFromPoint(395,300)` = `row 9` |
| 键盘 | `a` `b` `中` 全部落到页面输入框（`keyDown` 带 `text`） |
| insertText | 侧栏「送入」→ 输入框追加 `侧栏文本ABC` |
| 导航 | 前往 `http://127.0.0.1:8770/` 生效；后退回到 `8772` |
| 目标下拉 | 修复前 `row.targetId` 取不到值（宿主返回的是 `id`）→ 下拉只剩占位「页面」；修复后可切换 |
| 离线提示 | `DSH_CDP_URL` 指向死端口时 `phase=offline` 并给出启动指引 |


## 6. 已知限制

- **跟随只由「导航 / 新建 / 关闭」驱动，不由 MCP 的选中状态驱动。** 实测：
  MCP 的 `select_page` 与快照类操作在桥上**不产生任何 `Target.*` 事件**，而且 `targetCreated` 补发里
  MCP 已知的所有 page 都是 `attached=true` —— 它对所有已知页面常驻附着，选中是 MCP 内部状态，Chrome 侧不可观测。
  所以 MCP 若只是切到一个早已打开的页面并在里面点击（不导航），侧栏不会切过去；
  让它导航一次（哪怕同一 URL）或重开该页就会跟过去。
  **这种情况现在有解**：用顶栏的标签页下拉手动选那一页即可（见 §4 标签页下拉切换）。
- screencast 是**重绘驱动**：页面静止不出帧（实测 30 秒空闲只出 7 帧），
  全幅 JPEG 每帧约 38–53 KB（quality 70）。
- 这是画面镜像，不是 DOM：侧栏里选不中文字、看不到页面文本层，
  需要文本时在 MCP 那边读 DOM；侧栏 canvas 上仍可直接打字（含中文走 `Input.insertText`）。
- 输入坐标相对**可视视口**，所以映射只做缩放、不加 scrollOffset。
- **输入法组字过程不镜像**：在侧栏里用中文输入法打字，组字候选框属于宿主窗口，
  页面在落定（`compositionend` / `keypress`）之前收不到任何东西。落定后整段 `insertText` 进去，
  所以页面的 `compositionstart` / `compositionupdate` 拿不到。要在页面上看到真实组字序列，
  只能在 Chrome 窗口里直接打。
- **可见性**：canvas 不聚焦就收不到键盘事件，所以 `onMouseDown` 第一步就 `focus()`；
- Chrome 的 `/json/*` 不提供 CORS 头，浏览器不能直接跨源 fetch 9222；
  状态探测因此必须走宿主路由 `/dsh-cdp/status`。
- **宿主半侧改动要重启才生效**：`index.js` 只在组合（compose）时装载，`TabKeeper` 与 `/dsh-cdp/tabs` 那套路由
  要重启一次桌面客户端才起来；`client.js` 是热加载的——写盘那一刻桥就断开重连，粘住 primary 这类客户端改动不用重启。
- **回收的作用域是「装载之后出现的 page 目标」**：装载前就在的（用户自己窗口里的）、`chrome://` 一类、
  以及侧栏正在镜像的那一页，任何路径都不会关。要整个关掉这套行为：`DSH_CDP_REAP=0`。
- 闲置计时从「第一次被 sweep 观察到」开始算，所以刚 `new_page` 出来的那一页要先被观察到一轮，计时才启动；
  `claim` 不依赖观察（url 能反查到就登记）。
