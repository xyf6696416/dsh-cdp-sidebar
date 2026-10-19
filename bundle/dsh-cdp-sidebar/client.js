(() => {
  try {
    window.__ModuleLoader__.load({
      id: 'dsh-cdp-sidebar',
      factory(require) {
        const React = require('react');
        const h = React.createElement;
        const { useState, useEffect, useRef, useCallback, useMemo } = React;

        const PLUGIN_ID = 'dsh-cdp-sidebar';
        const NS = 'dshCdpSidebar';
        const inject = ['slots', 'locale', 'sidebarRight', 'sidebarRightTabs'];

        const zh = {
          'type.label': 'Chrome（CDP）',
          'guide.title': 'Chrome 镜像',
          'guide.description': '把 9222 上的 Chrome 画面镜像进来；它不接管浏览器 tab，会话链接仍走浏览器',
          'phase.discovering': '正在发现 Chrome 调试端点…',
          'phase.live': '已镜像',
          'phase.offline': '连不上调试端点',
          'phase.ws-blocked': 'WebSocket 被 Chrome 拒绝',
          'phase.no-target': '该端口上没有 page 目标',
          'phase.detached': '目标已分离',
          'phase.polling': '轮询画面（HTTP）',
          'phase.host-unreachable': 'DSH 侧 /dsh-cdp 路由不可用',
          'hint.origins': '桥和轮询都失败了。桥不需要 Chrome 的 Origin 白名单；若桥不可用又直连被拒，给 Chrome 快捷方式补上 --remote-allow-origins=http://127.0.0.1:19387',
          'hint.polling': '画面走宿主侧 Page.captureScreenshot 轮询（约 1 帧/秒），点击与键盘仍会回传到那个 Chrome。',
          'hint.offline': '先用带 --remote-debugging-port=9222 的独立 profile 启动 Chrome。',
          'empty': '侧栏自动跟随 9222 上那个 Chrome 里最近被导航的页面；用 chrome-devtools MCP 打开或导航页面，这里会自己切过去。',
        };
        const en = {
          'type.label': 'Chrome (CDP)',
          'guide.title': 'Chrome mirror',
          'guide.description': 'Mirrors the Chrome on 9222; it does not take over browser tabs, session links still open in the browser',
          'phase.discovering': 'Discovering the Chrome debug endpoint…',
          'phase.live': 'Mirrored',
          'phase.offline': 'Debug endpoint unreachable',
          'phase.ws-blocked': 'Chrome rejected the WebSocket',
          'phase.no-target': 'No page target on that port',
          'phase.detached': 'Target detached',
          'phase.polling': 'Polling frames (HTTP)',
          'phase.host-unreachable': 'DSH route /dsh-cdp unavailable',
          'hint.origins': 'Both the bridge and polling failed. The bridge needs no Chrome Origin allowlist; if only the direct connection is rejected, add --remote-allow-origins=http://127.0.0.1:19387 to the Chrome shortcut',
          'hint.polling': 'Frames come from host-side Page.captureScreenshot polling (~1 fps); clicks and keys still reach that Chrome.',
          'hint.offline': 'Start Chrome on an isolated profile with --remote-debugging-port=9222 first.',
          'empty': 'This pane auto-follows whichever page on the 9222 Chrome was navigated last; open or navigate pages with the chrome-devtools MCP and it switches over by itself.',
        };

        /* ───────── CDP 会话 ───────── */

        const BUTTON_FLAGS = { none: 0, left: 1, right: 2, middle: 4 };

        class CdpMirror {
          constructor({ onFrame, onState }) {
            this.onFrame = onFrame;
            this.onState = onState;
            this.ws = null;
            this.sessionId = null;
            this.targetId = null;
            this.viewport = null;
            this.pending = new Map();
            this.seq = 0;
            this.bytes = 0;
            this.closed = false;
            this.screencast = false;
            this.info = null;
            this.pollTarget = null;
            this.pollTimer = null;
            this.pollErrors = 0;
            this.pollBusy = false;
            this.suppressClose = false;
            this.bridgeRetryTimer = null;
            this.bridgeRetryAttempt = 0;
            this.bridgeRetryDone = false;
            /* 自动跟随：Chrome 里哪个 page 最近被导航，就镜像哪个 */
            this.targets = new Map(); /* targetId -> {targetId,url,title,updatedAt} */
            this.discovering = false;
            this.followTimer = null;
            this.attaching = false;
            this.seedAt = 0;
            this.discoveryGraceUntil = 0;
            /* 粘住主代理的页面：宿主那边 owner=main 的租约指向哪个 target，就镜像哪个。
               子代理各自的 tab 不会因为「刚导航过」就把画面抢走。 */
            this.primaryTargetId = null;
            this.primaryTimer = null;
          }
          emit(patch) {
            if (!this.closed) this.onState(patch);
          }
          async start() {
            this.startSeq = (CdpMirror.__startSeq = (CdpMirror.__startSeq || 0) + 1);
            console.info('[dsh-cdp-sidebar] start #' + this.startSeq);
            this.emit({ phase: 'discovering', pageOrigin: location.origin, pageHost: location.host, via: null, detail: '', diag: '' });
            const page = {
              protocol: location.protocol,
              host: location.host,
              origin: location.origin,
              href: String(location.href || '').slice(0, 120),
            };
            this.page = page;
            console.info('[dsh-cdp-sidebar] 页面环境', page);
            let info;
            try {
              const res = await fetch('/dsh-cdp/status', { credentials: 'same-origin' });
              info = await res.json();
            } catch (error) {
              this.emit({ phase: 'host-unreachable', detail: 'fetch /dsh-cdp/status 失败：' + String((error && error.message) || error) + ' @ ' + page.origin });
              return false;
            }
            if (!info || !info.ok) {
              this.emit({ phase: 'offline', detail: (info && (info.detail || info.hint)) || null, base: info && info.base });
              return false;
            }
            this.info = info;
            this.primaryTargetId = (info.tabState && info.tabState.primary) || null;
            const targets = (info.targets || []).map((row) => ({ targetId: row.id || row.targetId, url: row.url, title: row.title }));
            this.seedTargets(targets);
            try {
              await this.openPreferred(info);
            } catch (error) {
              const wsError = String((error && error.message) || error);
              console.warn('[dsh-cdp-sidebar] WebSocket 通道失败，尝试 HTTP 轮询兜底', wsError);
              this.report({
                phase: 'ws-blocked',
                via: this.via || 'none',
                bridge: this.bridgeLabel() || null,
                error: wsError,
                note: 'WebSocket 握手失败，准备切 HTTP 轮询',
              });
              const fallback = targets[0];
              if (fallback) {
                try {
                  await this.startPolling(fallback.targetId);
                  this.emit({
                    base: info.base,
                    browser: info.browser,
                    targets,
                    detail: '实时通道不可用（' + wsError + '），已切到 HTTP 轮询。用 chrome-devtools MCP 操作 Chrome，这里照样同步。',
                    diag: 'page=' + page.origin + ' bridge=' + (this.bridgeLabel() || '无'),
                  });
                  return true;
                } catch (pollError) {
                  this.emit({
                    phase: 'ws-blocked',
                    base: info.base,
                    targets,
                    detail: wsError + '；HTTP 轮询也失败：' + String((pollError && pollError.message) || pollError),
                    diag: 'page=' + page.origin + ' bridge=' + (this.bridgeLabel() || '无') + ' 直连=' + (info.webSocketDebuggerUrl || '无'),
                  });
                  return false;
                }
              }
              this.emit({
                phase: 'ws-blocked',
                base: info.base,
                targets,
                detail: 'WebSocket 连接失败：' + wsError,
                diag: 'page=' + page.origin + ' bridge=' + (this.bridgeLabel() || '无') + ' 直连=' + (info.webSocketDebuggerUrl || '无'),
              });
              return false;
            }
            this.emit({ phase: 'live', base: info.base, browser: info.browser, targets });
            if (!targets.length) {
              this.emit({ phase: 'no-target' });
              return false;
            }
            /* 先订阅 Chrome 的目标事件：之后 MCP 导航到哪个页面，侧栏就跟到哪个页面 */
            await this.enableDiscovery();
            this.startPrimaryPoll();
            const preferred = this.pickActive() || targets[0];
            await this.attach(preferred.targetId).catch((error) => this.emit({ phase: 'detached', detail: 'attach 失败：' + String((error && error.message) || error) }));
            return true;
          }
          bridgeUrl(info) {
            if (!info || !info.bridge) return null;
            /* 自定义协议壳（Electron 桌面版的 dsh-app:）里 location.host 不是真 host:port，
               拼出来是 ws://app/dsh-cdp/ws，握手必然失败。这种壳下只用宿主报上来的候选地址。 */
            const proto = location.protocol;
            if (proto !== 'http:' && proto !== 'https:') return null;
            const scheme = proto === 'https:' ? 'wss' : 'ws';
            return scheme + '://' + location.host + info.bridge;
          }
          /* 诊断里显示的桥地址：同源 + 宿主报上来的候选，全部列出 */
          bridgeLabel() {
            const list = (this.bridgeCandidates && this.bridgeCandidates.length)
              ? this.bridgeCandidates
              : [this.bridgeTarget].filter(Boolean);
            return list.join(' | ');
          }
          /* 把客户端这侧的失败原因送回宿主，之后用 GET /dsh-cdp/diag 就能读到 */
          report(payload) {
            try {
              fetch('/dsh-cdp/report', {
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                  ...payload,
                  page: location.origin + ' ' + String(location.href || '').slice(0, 90),
                  protocol: location.protocol,
                }),
              }).catch(() => { /* 上报失败不影响主流程 */ });
            } catch { /* 忽略 */ }
          }
          /* HTTP 轮询兜底：宿主用 Page.captureScreenshot 出帧，输入走 POST /dsh-cdp/exec。
             完全不依赖 ws://，任何屏蔽 WebSocket 的宿主环境都能出画面。 */
          async startPolling(targetId, allowBridgeRetry = true) {
            this.stopPolling();
            this.pollTarget = targetId || null;
            if (!this.pollTarget) throw new Error('没有可轮询的目标');
            this.targetId = this.pollTarget;
            this.via = 'poll';
            this.pollErrors = 0;
            this.emit({ phase: 'polling', via: 'poll', targetId: this.pollTarget, detail: '', diag: '' });
            const tick = async () => {
              /* 上一帧还没回来就跳过这一拍，别把请求堆起来 */
              if (this.closed || !this.pollTarget || this.pollBusy) return;
              const target = this.pollTarget;
              this.pollBusy = true;
              try {
                const res = await fetch('/dsh-cdp/shot?target=' + encodeURIComponent(target) + '&quality=62', { credentials: 'same-origin' });
                const info = await res.json();
                /* 出发时还在轮询，回来时可能已经升回桥了：别再翻回 polling 状态 */
                if (this.pollTarget !== target || this.closed) return;
                if (info && info.ok && info.data) {
                  this.onFrame(info.data, {});
                  this.pollErrors = 0;
                  this.emit({ phase: 'polling', url: info.url || '', title: info.title || '', targetId: target, targets: this.targetList() });
                } else {
                  this.pollErrors += 1;
                  this.emit({ detail: '轮询失败：' + ((info && (info.detail || info.hint)) || 'HTTP ' + res.status) });
                  if (this.pollErrors >= 2) await this.repointPoll();
                }
              } catch (error) {
                if (this.pollTarget !== target || this.closed) return;
                this.pollErrors += 1;
                this.emit({ detail: '轮询失败：' + String((error && error.message) || error) });
              } finally {
                this.pollBusy = false;
              }
            };
            await tick();
            if (this.pollErrors > 2) throw new Error('轮询连续失败');
            this.pollTimer = setInterval(tick, 900);
            if (allowBridgeRetry) this.scheduleBridgeRetry();
          }
          stopPolling() {
            if (this.pollTimer) clearInterval(this.pollTimer);
            this.pollTimer = null;
            this.pollTarget = null;
            if (this.bridgeRetryTimer) { clearTimeout(this.bridgeRetryTimer); this.bridgeRetryTimer = null; }
          }
          /* 轮询期间仍周期性回头试桥：桥一旦通了就自动升回实时通道。
             最多 3 次（15s / 40s / 90s），不通就安静下来，别刷屏。 */
          scheduleBridgeRetry() {
            if (this.bridgeRetryTimer || this.bridgeRetryDone) return;
            const delays = [15000, 40000, 90000];
            const step = async () => {
              this.bridgeRetryTimer = null;
              if (this.closed || !this.pollTarget) return;
              if (this.bridgeRetryAttempt >= delays.length) {
                this.bridgeRetryDone = true;
                this.report({
                  phase: 'bridge-retry-gave-up',
                  via: 'poll',
                  bridge: this.bridgeLabel(),
                  error: '桥重试 ' + delays.length + ' 次均未连通',
                  note: '保持 HTTP 轮询通道',
                });
                return;
              }
              const targetId = this.pollTarget;
              const attempt = this.bridgeRetryAttempt + 1;
              this.bridgeRetryAttempt = attempt;
              this.suppressClose = true;
              try {
                const res = await fetch('/dsh-cdp/status', { credentials: 'same-origin' });
                const info = await res.json();
                if (!info || !info.ok) throw new Error((info && (info.detail || info.hint)) || 'HTTP ' + res.status);
                this.info = info;
                this.primaryTargetId = (info.tabState && info.tabState.primary) || this.primaryTargetId;
                await this.openPreferred(info);
                this.suppressClose = false;
                this.stopPolling();
                this.report({
                  phase: 'bridge-retry-ok',
                  via: this.via,
                  bridge: this.bridgeLabel(),
                  error: '',
                  note: '第 ' + attempt + ' 次重试连通，已升回实时通道',
                });
                this.emit({ phase: 'live', base: info.base, browser: info.browser, detail: '桥已连通（第 ' + attempt + ' 次重试）' });
                this.seedTargets((info.targets || []).map((row) => ({ targetId: row.id || row.targetId, url: row.url, title: row.title })));
                await this.enableDiscovery();
                this.startPrimaryPoll();
                const follow = this.pickActive();
                await this.attach(follow ? follow.targetId : targetId).catch((error) => this.emit({ phase: 'detached', detail: 'attach 失败：' + String((error && error.message) || error) }));
              } catch (error) {
                this.suppressClose = false;
                const message = String((error && error.message) || error);
                console.warn('[dsh-cdp-sidebar] 桥重试 ' + attempt + ' 失败', message);
                this.report({
                  phase: 'bridge-retry-failed',
                  via: 'poll',
                  bridge: this.bridgeLabel(),
                  error: message,
                  note: '第 ' + attempt + '/' + delays.length + ' 次重试',
                });
                this.bridgeRetryTimer = setTimeout(step, delays[this.bridgeRetryAttempt] || 90000);
              }
            };
            this.bridgeRetryTimer = setTimeout(step, delays[0]);
          }
          /* 手动切到轮询模式（丢掉 WebSocket 通道） */
          async forcePoll() {
            if (this.pollTarget) return;
            let info = this.info;
            if (!info) {
              const res = await fetch('/dsh-cdp/status', { credentials: 'same-origin' });
              info = await res.json();
            }
            const first = (info.targets || [])[0];
            const targetId = first ? (first.id || first.targetId) : this.targetId;
            if (this.ws) {
              this.suppressClose = true;
              try { this.ws.close(); } catch { /* 已关闭 */ }
              this.ws = null;
            }
            this.sessionId = null;
            /* 手动切的轮询：不再自动回头试桥 */
            this.bridgeRetryDone = true;
            if (this.bridgeRetryTimer) { clearTimeout(this.bridgeRetryTimer); this.bridgeRetryTimer = null; }
            await this.startPolling(targetId, false);
          }
          execViaHttp(method, params) {
            return fetch('/dsh-cdp/exec', {
              method: 'POST',
              credentials: 'same-origin',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ target: this.pollTarget, method, params: params || {} }),
            })
              .then(async (res) => {
                const body = await res.json().catch(() => ({}));
                if (!res.ok || !body.ok) throw new Error((body && body.detail) || 'HTTP ' + res.status);
                return body.result;
              });
          }
          /* 优先走宿主桥（同源，不受 Chrome 的 Origin 白名单影响）；
             同源桥不通时，再试宿主自己报上来的候选地址；都不通才退回直连 9222 */
          async openPreferred(info) {
            const candidates = [];
            const add = (url) => { if (url && !candidates.includes(url)) candidates.push(url); };
            add(this.bridgeUrl(info));
            for (const url of (info.bridgeCandidates || [])) add(url);
            this.bridgeTarget = candidates[0] || null;
            this.bridgeCandidates = candidates.slice();
            this.emit({ bridgeUrl: candidates.join(' | ') || null, statusBase: info.base || '' });
            let lastError = '';
            for (let i = 0; i < candidates.length; i += 1) {
              const bridge = candidates[i];
              try {
                await this.open(bridge, 'bridge');
                console.info('[dsh-cdp-sidebar] 桥已连通', bridge, '候选 ' + (i + 1) + '/' + candidates.length);
                return;
              } catch (error) {
                lastError = String((error && error.message) || error);
                console.warn('[dsh-cdp-sidebar] 桥候选 ' + (i + 1) + '/' + candidates.length + ' 失败', bridge, lastError);
                this.emit({ detail: '桥不可用（' + bridge + '）：' + lastError });
                this.report({
                  phase: 'bridge-attempt-failed',
                  via: 'bridge',
                  bridge,
                  error: lastError,
                  note: '候选 ' + (i + 1) + '/' + candidates.length + '，页面 protocol=' + location.protocol,
                });
              }
            }
            if (candidates.length) {
              this.emit({ detail: '桥全部不可用（' + candidates.length + ' 个候选）：' + lastError });
            }
            await this.open(info.webSocketDebuggerUrl, 'direct');
          }
          open(url, via) {
            return new Promise((resolve, reject) => {
              if (!url) return reject(new Error('没有可用的 WebSocket 地址（via=' + via + '）'));
              let ws;
              try {
                ws = new WebSocket(url);
              } catch (error) {
                return reject(new Error('WebSocket 地址非法 ' + url + '：' + String((error && error.message) || error)));
              }
              const timer = setTimeout(() => reject(new Error('WebSocket 握手超时（6s） ' + url)), 6000);
              ws.onopen = () => {
                clearTimeout(timer);
                this.ws = ws;
                this.via = via;
                this.emit({ via, connectedUrl: url });
                resolve();
              };
              ws.onerror = () => {
                clearTimeout(timer);
                reject(new Error('WebSocket 握手失败 ' + url));
              };
              ws.onclose = (event) => {
                if (this.suppressClose) return;
                /* 失败的候选连接（没成为当前通道）关闭时不改状态，
                   否则兜底轮询会被它的迟到 close 翻成「目标已分离」 */
                if (this.ws !== ws) return;
                this.ws = null;
                if (!this.closed) {
                  this.emit({
                    phase: 'detached',
                    detail: 'WebSocket 已关闭（via=' + this.via + ' code=' + (event && event.code) + '）',
                  });
                }
              };
              ws.onmessage = (event) => this.handle(event);
            });
          }
          handle(event) {
            let m;
            try {
              m = JSON.parse(event.data);
            } catch {
              return;
            }
            if (m.dshBridge === 'connected') {
              if (m.browser) this.emit({ browser: m.browser });
              return;
            }
            if (m.dshBridge === 'failed') {
              this.emit({ detail: '宿主桥失败：' + m.error });
              return;
            }
            if (m.dshBridge === 'retrying') {
              this.emit({ detail: '宿主桥重试上游（第 ' + m.attempt + ' 次：' + m.error + '）' });
              return;
            }
            if (m.id && this.pending.has(m.id)) {
              const entry = this.pending.get(m.id);
              this.pending.delete(m.id);
              clearTimeout(entry.timer);
              entry.settle(m.error ? { reject: new Error(JSON.stringify(m.error)) } : { resolve: m.result });
              return;
            }
            if (m.method === 'Page.screencastFrame') {
              this.seq += 1;
              this.bytes += (m.params.data || '').length;
              const meta = m.params.metadata || {};
              if (typeof meta.scrollOffsetX === 'number' && this.viewport) {
                this.viewport = { ...this.viewport, offsetX: meta.scrollOffsetX, offsetY: meta.scrollOffsetY };
              }
              this.onFrame(m.params.data, meta);
              this.command('Page.screencastFrameAck', { sessionId: m.params.sessionId }).catch(() => {});
              return;
            }
            if (m.method === 'Target.targetCreated' || m.method === 'Target.targetInfoChanged') {
              const info = m.params && m.params.targetInfo;
              if (!info || info.type !== 'page') return;
              const active = this.markTarget(info, m.method);
              if (this.pollTarget) return;
              if (info.targetId === this.targetId) this.emit({ phase: 'live', targetId: info.targetId, url: info.url, title: info.title });
              if (active) this.scheduleFollow();
              else this.emit({ targets: this.targetList() });
              return;
            }
            if (m.method === 'Target.targetDestroyed') {
              const gone = m.params && m.params.targetId;
              if (!gone) return;
              this.targets.delete(gone);
              if (gone === this.targetId) {
                this.sessionId = null;
                this.targetId = null;
                this.emit({ phase: 'detached', detail: '目标页面被关闭了（Target.targetDestroyed）' });
              }
              this.scheduleFollow();
              return;
            }
            if (m.method === 'Target.detachedFromTarget') {
              if (m.params && m.params.sessionId === this.sessionId) {
                this.sessionId = null;
                this.targetId = null;
                this.emit({ phase: 'detached', detail: 'Chrome 把会话分离了（Target.detachedFromTarget）' });
                this.scheduleFollow();
              }
              return;
            }
            if (m.method === 'Target.attachedToTarget') {
              const info = m.params && m.params.targetInfo;
              console.info('[dsh-cdp-sidebar] Chrome attach', info && info.url);
            }
            if (m.error) {
              console.warn('[dsh-cdp-sidebar] CDP 错误', JSON.stringify(m.error));
            }
          }
          command(method, params, sessionId) {
            if (this.pollTarget && (!this.ws || this.ws.readyState !== 1)) return this.execViaHttp(method, params);
            const ws = this.ws;
            if (!ws || ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
            const id = this.pending.size + 1 + Math.floor(Math.random() * 1e6);
            const payload = sessionId || this.sessionId ? { id, sessionId: sessionId || this.sessionId, method, params } : { id, method, params };
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                if (this.pending.has(id)) {
                  this.pending.delete(id);
                  reject(new Error('CDP 超时 ' + method));
                }
              }, 8000);
              this.pending.set(id, { settle: ({ resolve: r, reject: j }) => (r ? resolve(r) : j ? reject(j) : undefined), timer });
              ws.send(JSON.stringify(payload));
            });
          }
          /* 浏览器级命令（Target.*）必须不带 sessionId，否则 Chrome 会把它路由到 page 会话而报错 */
          browserCommand(method, params) {
            const saved = this.sessionId;
            this.sessionId = null;
            const run = this.command(method, params);
            return run.finally(() => { this.sessionId = saved; });
          }
          async attach(targetId) {
            if (this.pollTarget) { await this.startPolling(targetId); return; }
            if (this.sessionId) {
              try {
                await this.command('Target.detachFromTarget', { sessionId: this.sessionId });
              } catch {
                /* 已分离 */
              }
              this.sessionId = null;
            }
            const { sessionId } = await this.command('Target.attachToTarget', { targetId, flatten: true });
            this.sessionId = sessionId;
            this.targetId = targetId;
            const mark = this.manualTargetId === targetId ? { manualUntil: this.manualUntil } : {};
            this.emit({ targetId, ...mark });
            await this.command('Page.enable', {}, sessionId);
            try {
              const metrics = await this.command('Page.getLayoutMetrics', {}, sessionId);
              this.viewport = metrics.cssVisualViewport || metrics.visualViewport || null;
            } catch {
              this.viewport = null;
            }
            const info = await this.browserCommand('Target.getTargetInfo', { targetId }).catch(() => null);
            if (info && info.targetInfo) this.markTarget(info.targetInfo, 'Target.getTargetInfo');
            const known = this.targets.get(targetId) || {};
            this.emit({
              phase: 'live',
              targetId,
              url: known.url || (info && info.targetInfo && info.targetInfo.url) || '',
              title: known.title || (info && info.targetInfo && info.targetInfo.title) || '',
              targets: this.targetList(),
            });
            if (this.screencast) await this.command('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 }, sessionId);
          }
          /* ───────── 自动跟随：镜像「MCP 正在操作的那个页面」 ───────── */
          /* 手动切换：用户在 URL 下拉里点了别的标签页，就镜像那一页。
             记下 manualTargetId，自动跟随不再把它抢回去 */
          switchTo(targetId) {
            if (!targetId || this.closed) return Promise.resolve(false);
            if (targetId === this.targetId && this.sessionId) return Promise.resolve(true);
            this.manualTargetId = targetId;
            this.manualUntil = Date.now() + 10 * 60 * 1000;
            return this.attach(targetId)
              .then(() => {
                /* 切过去之后补一次画面，别等用户去动页面才出帧 */
                if (!this.pollTarget) this.setScreencast(true).catch(() => {});
                this.emit({ targets: this.targetList() });
                return true;
              })
              .catch((error) => {
                this.emit({ detail: '切换标签页失败：' + String((error && error.message) || error) });
                return false;
              });
          }
          /* 手动选择还在有效期内，且那一页还活着 */
          manualPicker() {
            if (!this.manualTargetId) return null;
            if (Date.now() > this.manualUntil) { this.manualTargetId = null; return null; }
            if (!this.targets.has(this.manualTargetId)) { this.manualTargetId = null; return null; }
            return this.targets.get(this.manualTargetId);
          }
          seedTargets(list) {
            const stamp = (this.seedAt = Date.now());
            for (const row of list || []) {
              if (!row || !row.targetId) continue;
              this.targets.set(row.targetId, { targetId: row.targetId, url: row.url || '', title: row.title || '', updatedAt: stamp });
            }
          }
          /* 订阅 Chrome 的目标事件。这是浏览器级命令，不能带 sessionId */
          async enableDiscovery() {
            if (this.pollTarget || !this.ws || this.ws.readyState !== 1) return false;
            /* 实测补发在 1.2s 内到齐，留 2.5s 余量 */
            this.discoveryGraceUntil = Date.now() + 2500;
            try {
              await this.browserCommand('Target.setDiscoverTargets', { discover: true });
              this.discovering = true;
              return true;
            } catch (error) {
              const message = String((error && error.message) || error);
              console.warn('[dsh-cdp-sidebar] Target.setDiscoverTargets 失败', message);
              this.emit({ detail: '目标订阅失败，自动跟随不可用：' + message });
              this.report({ phase: 'discover-failed', via: this.via, bridge: this.bridgeLabel(), error: message, note: '退化为固定目标镜像' });
              return false;
            }
          }
          /* 记下一个 page 目标，返回它是否算「刚被操作过」
             实测：
               订阅后 Chrome 把已存在的目标全补发一遍 targetCreated
               attach 只发 attachedToTarget，不发 targetInfoChanged
               导航发 targetInfoChanged（url 变）
               关 tab 发 targetInfoChanged → detachedFromTarget → targetDestroyed（params 直接带 targetId） */
          markTarget(info, method) {
            const id = info && info.targetId;
            if (!id) return false;
            const prev = this.targets.get(id);
            const url = (info && info.url) || (prev && prev.url) || '';
            const title = (info && info.title) || (prev && prev.title) || '';
            const moved = !!prev && (prev.url !== url || prev.title !== title);
            const isNew = !prev;
            const now = Date.now();
            const grace = now < this.discoveryGraceUntil;
            /* 补发的那批不是新活动：时间戳压平到 seedAt，否则侧栏会乱跳到某个旧标签页 */
            const stamp = isNew ? (grace ? this.seedAt || now : now) : (moved && !grace ? now : prev.updatedAt);
            this.targets.set(id, { targetId: id, url, title, updatedAt: stamp });
            if (grace) return false;
            /* 活动 = 已存在的目标换了页面，或订阅稳定之后新出现的 tab（补发的一定已在 seedAt 名单里） */
            return moved || (isNew && method === 'Target.targetCreated');
          }
          pickActive() {
            /* 用户在 URL 下拉里手动选过，就先听用户的，别被自动跟随抢回去 */
            const manual = this.manualPicker();
            if (manual) return manual;
            /* 有主代理的租约就跟着它，子代理的 tab 再活跃也不抢画面 */
            if (this.primaryTargetId) {
              const primary = this.targets.get(this.primaryTargetId);
              if (primary) return primary;
            }
            let best = null;
            for (const row of this.targets.values()) if (!best || row.updatedAt > best.updatedAt) best = row;
            return best;
          }
          /* 从宿主读「主代理现在用的是哪个 target」；每 3 秒一次，认领/释放都能及时跟上 */
          async refreshPrimary() {
            if (this.closed) return null;
            try {
              const res = await fetch('/dsh-cdp/tabs', { credentials: 'same-origin' });
              if (!res.ok) return null;
              const data = await res.json();
              const next = (data && data.primary) || null;
              if (next !== this.primaryTargetId) {
                this.primaryTargetId = next;
                if (next) this.scheduleFollow();
              }
              return data;
            } catch { return null; }
          }
          startPrimaryPoll() {
            if (this.primaryTimer) return;
            this.primaryTimer = setInterval(() => { this.refreshPrimary().catch(() => {}); }, 3000);
            if (typeof this.primaryTimer.unref === 'function') this.primaryTimer.unref();
          }
          targetList() {
            return Array.from(this.targets.values()).map((row) => ({ targetId: row.targetId, url: row.url, title: row.title }));
          }
          scheduleFollow() {
            if (this.closed || this.pollTarget) return;
            if (this.followTimer) clearTimeout(this.followTimer);
            /* 一次导航会连着发好几条 targetInfoChanged（url 变、title 变），合并成一次切换 */
            this.followTimer = setTimeout(() => {
              this.followTimer = null;
              this.followActive().catch(() => {});
            }, 420);
          }
          async followActive() {
            if (this.closed || this.pollTarget || !this.ws || this.ws.readyState !== 1) return;
            const best = this.pickActive();
            if (!best) {
              this.sessionId = null;
              this.targetId = null;
              this.emit({ phase: 'no-target', targets: [], url: '', title: '' });
              return;
            }
            this.emit({ targets: this.targetList() });
            if (best.targetId === this.targetId && this.sessionId) return;
            if (this.attaching) return;
            this.attaching = true;
            try {
              await this.attach(best.targetId);
              console.info('[dsh-cdp-sidebar] 自动跟随 →', best.url || best.targetId);
            } catch (error) {
              this.emit({ phase: 'detached', detail: '自动跟随失败：' + String((error && error.message) || error) });
            } finally {
              this.attaching = false;
            }
          }
          /* 轮询通道下原目标消失了：换到列表里最后一个 page */
          async repointPoll() {
            const res = await fetch('/dsh-cdp/targets', { credentials: 'same-origin' }).catch(() => null);
            if (!res) return false;
            const info = await res.json().catch(() => ({}));
            const pages = (info.targets || []).map((t) => ({ targetId: t.id || t.targetId, url: t.url, title: t.title }));
            if (!pages.length) return false;
            this.emit({ targets: pages });
            if (pages.some((p) => p.targetId === this.pollTarget)) return false;
            const next = (this.primaryTargetId && pages.find((p) => p.targetId === this.primaryTargetId)) || pages[pages.length - 1];
            this.pollTarget = next.targetId;
            this.targetId = next.targetId;
            this.pollErrors = 0;
            this.manualTargetId = null;
            this.emit({ phase: 'polling', targetId: next.targetId, detail: '原目标已消失，自动切到 ' + (next.url || next.targetId) });
            return true;
          }
          setScreencast(on) {
            if (on === this.screencast) return Promise.resolve();
            this.screencast = on;
            if (!this.sessionId) return Promise.resolve();
            if (on) return this.command('Page.startScreencast', { format: 'jpeg', quality: 70, everyNthFrame: 1 }).catch(() => {});
            return this.command('Page.stopScreencast', {}).catch(() => {});
          }
          async refreshTargets() {
            if (this.pollTarget) {
              const res = await fetch('/dsh-cdp/targets', { credentials: 'same-origin' }).catch(() => null);
              const info = res ? await res.json().catch(() => ({})) : {};
              const pages = (info.targets || []).map((t) => ({ targetId: t.id || t.targetId, url: t.url, title: t.title }));
              this.emit({ targets: pages });
              return pages;
            }
            if (!this.ws) return [];
            const { targetInfos } = await this.browserCommand('Target.getTargets').catch(() => ({ targetInfos: [] }));
            const pages = (targetInfos || []).filter((t) => t.type === 'page').map((t) => ({ targetId: t.targetId, url: t.url, title: t.title }));
            /* 只补 url/title，不动 updatedAt：手动刷新不该改变「谁最近被操作」 */
            for (const t of targetInfos || []) {
              if (!t || t.type !== 'page' || !t.targetId) continue;
              const prev = this.targets.get(t.targetId);
              this.targets.set(t.targetId, {
                targetId: t.targetId,
                url: t.url || (prev && prev.url) || '',
                title: t.title || (prev && prev.title) || '',
                updatedAt: prev ? prev.updatedAt : this.seedAt || Date.now(),
              });
            }
            this.emit({ targets: pages });
            return pages;
          }
          navigate(url) {
            return this.command('Page.navigate', { url });
          }
          reload() {
            return this.command('Page.reload', {});
          }
          history() {
            return this.command('Page.getNavigationHistory', {});
          }
          goHistory(entryId) {
            return this.command('Page.navigateToHistoryEntry', { entryId });
          }
          activate() {
            return this.command('Target.activateTarget', { targetId: this.targetId });
          }
          async createTarget(url) {
            const { targetId } = await this.command('Target.createTarget', { url });
            await this.attach(targetId);
            await this.refreshTargets().catch(() => {});
            return targetId;
          }
          /* 输入回传：坐标已是页面 CSS 像素 */
          pointer(type, x, y, extra) {
            if (!this.sessionId && !this.pollTarget) return;
            this.command('Input.dispatchMouseEvent', { type, x: Math.round(x), y: Math.round(y), pointerType: 'mouse', ...extra }).catch(() => {});
          }
          move(x, y, buttons) {
            this.pointer('mouseMoved', x, y, { buttons: buttons || 0, button: 'none' });
          }
          press(x, y, button, clickCount) {
            this.pointer('mousePressed', x, y, { button: button || 'left', buttons: BUTTON_FLAGS[button] || 1, clickCount: clickCount || 1 });
          }
          release(x, y, button, clickCount) {
            this.pointer('mouseReleased', x, y, { button: button || 'left', buttons: 0, clickCount: clickCount || 1 });
          }
          wheel(x, y, deltaX, deltaY) {
            this.pointer('mouseWheel', x, y, { deltaX, deltaY });
          }
          key(type, init) {
            if (!this.sessionId && !this.pollTarget) return;
            this.command('Input.dispatchKeyEvent', { type, ...init }).catch(() => {});
          }
          insertText(text) {
            if (!this.sessionId && !this.pollTarget) return Promise.resolve();
            return this.command('Input.insertText', { text }).catch(() => {});
          }
          close() {
            this.closed = true;
            this.stopPolling();
            if (this.followTimer) { clearTimeout(this.followTimer); this.followTimer = null; }
            if (this.primaryTimer) { clearInterval(this.primaryTimer); this.primaryTimer = null; }
            for (const { timer } of this.pending.values()) clearTimeout(timer);
            this.pending.clear();
            if (this.ws) {
              try {
                if (this.sessionId && this.ws.readyState === 1) this.ws.send(JSON.stringify({ id: 999999, method: 'Page.stopScreencast', params: {} }));
                this.ws.close();
              } catch {
                /* 已关闭 */
              }
              this.ws = null;
            }
            this.sessionId = null;
            this.targetId = null;
          }
        }

        /* ───────── 样式（只用主题 token，带回退值） ───────── */

        const token = (name, fallback) => `var(${name}, ${fallback})`;
        const S = {
          shell: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, background: token('--dsw-alias-surface-primary', '#ffffff'), color: token('--dsw-alias-text-primary', '#111827'), font: '13px/1.5 var(--dsw-font-sans, system-ui)' },
          bar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '8px 10px', borderBottom: '1px solid ' + token('--dsw-alias-border-primary', '#e5e7eb') },
          group: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 },
          grow: { flex: '1 1 220px', minWidth: 120 },
          status: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: token('--dsw-alias-text-secondary', '#6b7280'), minWidth: 0 },
          dot: { width: 8, height: 8, borderRadius: 99, flex: '0 0 auto' },
          input: { flex: '1 1 160px', minWidth: 90, padding: '6px 9px', borderRadius: 8, border: '1px solid ' + token('--dsw-alias-border-primary', '#d1d5db'), background: token('--dsw-alias-surface-primary', '#fff'), color: 'inherit', font: 'inherit' },
          select: { padding: '6px 8px', borderRadius: 8, border: '1px solid ' + token('--dsw-alias-border-primary', '#d1d5db'), background: token('--dsw-alias-surface-primary', '#fff'), color: 'inherit', font: 'inherit', maxWidth: 190 },
          button: { padding: '6px 10px', borderRadius: 8, border: '1px solid ' + token('--dsw-alias-border-primary', '#d1d5db'), background: token('--dsw-alias-surface-secondary', '#f3f4f6'), color: 'inherit', font: 'inherit', cursor: 'pointer' },
          primary: { background: token('--dsw-alias-action-primary-primary', '#247bbf'), color: '#fff', border: '1px solid transparent' },
          stage: { flex: '1 1 auto', minHeight: 0, position: 'relative', background: '#0b0b0c', display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden' },
          canvas: { display: 'block', cursor: 'crosshair', background: '#0b0b0c' },
          hint: { position: 'absolute', inset: 0, display: 'flex', flexDirection: 'column', gap: 8, alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', color: token('--dsw-alias-text-secondary', '#6b7280'), pointerEvents: 'none' },
          ripple: { position: 'absolute', width: 18, height: 18, marginLeft: -9, marginTop: -9, borderRadius: 99, border: '2px solid #38bdf8', pointerEvents: 'none', opacity: 0, transition: 'opacity .25s' },
          small: { fontSize: 11, color: token('--dsw-alias-text-tertiary', '#9ca3af') },
          url: { fontSize: 12, color: token('--dsw-alias-text-secondary', '#6b7280'), overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          /* URL 下拉切换器 */
          picker: { display: 'flex', alignItems: 'center', gap: 6, padding: '4px 8px', borderRadius: 8, border: '1px solid transparent', background: 'transparent', color: token('--dsw-alias-text-secondary', '#6b7280'), font: 'inherit', fontSize: 12, cursor: 'pointer', textAlign: 'left', minWidth: 0 },
          pickerOpen: { border: '1px solid ' + token('--dsw-alias-border-primary', '#d1d5db'), background: token('--dsw-alias-surface-secondary', '#f3f4f6'), color: token('--dsw-alias-text-primary', '#111827') },
          pickerText: { flex: '1 1 auto', minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
          caret: { flex: '0 0 auto', fontSize: 9, opacity: 0.7 },
          manualBadge: { flex: '0 0 auto', padding: '0 5px', borderRadius: 5, background: token('--dsw-alias-action-primary-primary', '#247bbf'), color: '#fff', fontSize: 10, lineHeight: '16px' },
          pickerPanel: { borderBottom: '1px solid ' + token('--dsw-alias-border-primary', '#e5e7eb'), background: token('--dsw-alias-surface-primary', '#fff'), flex: '0 0 auto', maxHeight: 220, display: 'flex', flexDirection: 'column', overflow: 'hidden' },
          pickerHead: { padding: '6px 10px', fontSize: 11, color: token('--dsw-alias-text-tertiary', '#9ca3af'), borderBottom: '1px solid ' + token('--dsw-alias-border-primary', '#f1f5f9') },
          pickerList: { overflowY: 'auto', flex: '1 1 auto', minHeight: 0 },
          pickerItem: { display: 'flex', alignItems: 'flex-start', gap: 6, width: '100%', padding: '5px 10px', border: 'none', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 12, textAlign: 'left', cursor: 'pointer' },
          pickerItemActive: { background: token('--dsw-alias-surface-secondary', '#eef4fb') },
          pickerDot: { flex: '0 0 auto', width: 10, fontSize: 9, color: token('--dsw-alias-action-primary-primary', '#247bbf'), lineHeight: '18px' },
          pickerItemBody: { display: 'flex', flexDirection: 'column', minWidth: 0, flex: '1 1 auto' },
          pickerItemTitle: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: token('--dsw-alias-text-primary', '#111827') },
          pickerItemUrl: { fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: token('--dsw-alias-text-tertiary', '#9ca3af') },
          pickerReset: { borderTop: '1px solid ' + token('--dsw-alias-border-primary', '#f1f5f9'), color: token('--dsw-alias-action-primary-primary', '#247bbf'), flex: '0 0 auto' },
          diag: {
            padding: '6px 10px',
            borderBottom: '1px solid ' + token('--dsw-alias-border-primary', '#e5e7eb'),
            background: token('--dsw-alias-surface-secondary', '#f8fafc'),
            color: token('--dsw-alias-text-secondary', '#6b7280'),
            font: '11px/1.6 ui-monospace, Consolas, monospace',
            wordBreak: 'break-all',
            whiteSpace: 'pre-wrap',
            maxHeight: 92,
            overflow: 'auto',
            flex: '0 0 auto',
          },
        };

        const PHASE_COLOR = { live: '#10b981', discovering: '#f59e0b', offline: '#ef4444', 'ws-blocked': '#ef4444', 'no-target': '#ef4444', detached: '#f59e0b', 'host-unreachable': '#ef4444', polling: '#38bdf8', idle: '#9ca3af' };

        /* ───────── 正文 ───────── */

        function CdpBody(props) {
          const { useTabInfo } = props;
          const t = typeof props.t === 'function' ? props.t : (key) => zh[key] || key;
          if (typeof useTabInfo !== 'function') {
            return h('div', {
              style: { padding: 14, color: '#b91c1c', background: '#fef2f2', font: '13px/1.6 system-ui' },
            }, '座位未注入 useTabInfo：dsh-cdp-sidebar 需要 DSH 右侧栏的 sidebar.right.pane.tab 座位。');
          }
          const { tab } = useTabInfo();
          const mirrorRef = useRef(null);
          const canvasRef = useRef(null);
          const stageRef = useRef(null);
          const rippleRef = useRef(null);
          const statsRef = useRef({ frames: 0, bytes: 0 });
          const clickCountRef = useRef(0);
          const [ui, setUi] = useState({
            phase: 'idle', url: '', title: '', targets: [], base: '', browser: '', detail: '',
            diag: '', via: '', bridgeUrl: '', pageOrigin: '', pageHost: '', targetId: '',
            manualUntil: 0,
          });
          const [tick, setTick] = useState(0);
          const [showDebug, setShowDebug] = useState(false);
          const [pickerOpen, setPickerOpen] = useState(false);

          const onState = useCallback((patch) => setUi((prev) => ({ ...prev, ...patch })), []);

          const drawFrame = useCallback((data, meta) => {
            const canvas = canvasRef.current;
            if (!canvas || !data) return;
            const img = new Image();
            img.onload = () => {
              const c = canvas;
              const vw = img.naturalWidth || 1280;
              const vh = img.naturalHeight || 720;
              if (c.width !== vw || c.height !== vh) { c.width = vw; c.height = vh; }
              /* 画面独占：按面板尺寸 contain 缩放，黑边只剩 stage 的底色，canvas 矩形就是画面矩形 */
              const stage = stageRef.current;
              if (stage) {
                const box = stage.getBoundingClientRect();
                if (box.width > 4 && box.height > 4) {
                  const k = Math.min(box.width / vw, box.height / vh, 4);
                  c.style.width = Math.round(vw * k) + 'px';
                  c.style.height = Math.round(vh * k) + 'px';
                }
              }
              const ctx = c.getContext('2d');
              if (ctx) ctx.drawImage(img, 0, 0, vw, vh);
              statsRef.current.frames += 1;
              statsRef.current.bytes += data.length;
            };
            img.src = 'data:image/jpeg;base64,' + data;
          }, []);

          /* 会话生命周期：一个 tab occurrence 一条 CDP 连接 */
          useEffect(() => {
            const mirror = new CdpMirror({ onFrame: drawFrame, onState });
            mirrorRef.current = mirror;
            let cancelled = false;
            mirror.start().then((ok) => {
              if (cancelled) return;
              if (ok) mirror.setScreencast(tab.visible !== false);
            });
            return () => {
              cancelled = true;
              mirror.close();
              mirrorRef.current = null;
            };
            // eslint-disable-next-line react-hooks/exhaustive-deps
          }, [tab.signal]);

          /* 可见性驱动 screencast 开合 */
          useEffect(() => {
            const mirror = mirrorRef.current;
            if (!mirror) return;
            mirror.setScreencast(tab.visible !== false);
          }, [tab.visible, ui.phase]);

          /* 帧计数低频刷新，避免每帧重渲染 */
          useEffect(() => {
            const timer = setInterval(() => setTick((n) => n + 1), 1000);
            return () => clearInterval(timer);
          }, []);

          /* 面板尺寸变化时按最后一帧重排画面（不重抓帧） */
          useEffect(() => {
            const resize = () => {
              const canvas = canvasRef.current;
              const stage = stageRef.current;
              if (!canvas || !stage || !canvas.width) return;
              const box = stage.getBoundingClientRect();
              if (box.width <= 4 || box.height <= 4) return;
              const k = Math.min(box.width / canvas.width, box.height / canvas.height, 4);
              canvas.style.width = Math.round(canvas.width * k) + 'px';
              canvas.style.height = Math.round(canvas.height * k) + 'px';
            };
            window.addEventListener('resize', resize);
            return () => window.removeEventListener('resize', resize);
          }, []);

          /* canvas CSS 坐标 → 页面可视视口 CSS 坐标
             screencast 帧就是「当前可见区域」，Input.dispatchMouseEvent 的 x/y 也是相对可视视口原点，
             所以这里只做缩放，绝不加 scrollOffset（加了会在滚动后整体偏移）。
             drawFrame 会把 canvas 的 CSS 尺寸设成 contain 后的画面矩形，所以这里纯缩放即可。 */
          const toPage = useCallback((event) => {
            const canvas = canvasRef.current;
            const mirror = mirrorRef.current;
            if (!canvas || !mirror) return null;
            const rect = canvas.getBoundingClientRect();
            const vp = mirror.viewport;
            const pageW = (vp && vp.clientWidth) || canvas.width || 1;
            const pageH = (vp && vp.clientHeight) || canvas.height || 1;
            const x = (event.clientX - rect.left) * (pageW / rect.width);
            const y = (event.clientY - rect.top) * (pageH / rect.height);
            return { x, y };
          }, []);

          const ripple = useCallback((event) => {
            const stage = stageRef.current;
            const node = rippleRef.current;
            if (!stage || !node) return;
            const rect = stage.getBoundingClientRect();
            node.style.left = event.clientX - rect.left + 'px';
            node.style.top = event.clientY - rect.top + 'px';
            node.style.opacity = '1';
            setTimeout(() => {
              if (rippleRef.current) rippleRef.current.style.opacity = '0';
            }, 260);
          }, []);

          const handlers = useMemo(() => {
            let held = null;
            const throttled = { x: 0, y: 0, at: 0 };
            return {
              onMouseMove(event) {
                const mirror = mirrorRef.current;
                const p = toPage(event);
                if (!mirror || !p) return;
                const now = Date.now();
                if (now - throttled.at < 33) return;
                throttled.at = now;
                throttled.x = p.x;
                throttled.y = p.y;
                mirror.move(p.x, p.y, held ? (held.buttons || 1) : 0);
              },
              onMouseDown(event) {
                event.preventDefault();
                const mirror = mirrorRef.current;
                const p = toPage(event);
                if (!mirror || !p) return;
                const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
                clickCountRef.current += 1;
                held = { button, clickCount: clickCountRef.current };
                mirror.press(p.x, p.y, button, clickCountRef.current);
                ripple(event);
              },
              onMouseUp(event) {
                const mirror = mirrorRef.current;
                const p = toPage(event);
                if (!mirror || !p) return;
                const button = held ? held.button : event.button === 2 ? 'right' : 'left';
                mirror.release(p.x, p.y, button, clickCountRef.current);
                clickCountRef.current = 0;
                held = null;
              },
              onWheel(event) {
                event.preventDefault();
                const mirror = mirrorRef.current;
                const p = toPage(event);
                if (!mirror || !p) return;
                mirror.wheel(p.x, p.y, Math.round(event.deltaX), Math.round(event.deltaY));
              },
              onContextMenu(event) {
                event.preventDefault();
              },
              onKeyDown(event) {
                const mirror = mirrorRef.current;
                if (!mirror) return;
                if (event.key === 'Tab') event.preventDefault();
                const init = {
                  key: event.key,
                  code: event.code,
                  windowsVirtualKeyCode: event.keyCode,
                  nativeVirtualKeyCode: event.keyCode,
                  modifiers: (event.altKey ? 1 : 0) | (event.ctrlKey ? 2 : 0) | (event.metaKey ? 4 : 0) | (event.shiftKey ? 8 : 0),
                };
                if (event.key.length === 1) init.text = event.key;
                mirror.key('keyDown', init);
                if (event.repeat) return;
                mirror.key('keyUp', { ...init, text: undefined });
              },
              onPaste(event) {
                const mirror = mirrorRef.current;
                const value = event.clipboardData && event.clipboardData.getData('text');
                if (mirror && value) {
                  event.preventDefault();
                  mirror.insertText(value);
                }
              },
            };
          }, [toPage, ripple]);

          const phaseLabel = t('phase.' + ui.phase);
          const hint = ui.phase === 'ws-blocked' ? t('hint.origins') : ui.phase === 'polling' ? t('hint.polling') : ui.phase === 'offline' || ui.phase === 'host-unreachable' ? t('hint.offline') : ui.phase === 'no-target' ? t('phase.no-target') : null;
          const stats = statsRef.current;
          void tick;
          /* 调试信息平时收起来：出错自动冒出来，也可以点 ⚙ 手动开 */
          const autoDebug = ui.phase !== 'live' && ui.phase !== 'polling';
          const debugOpen = showDebug || autoDebug;

          /* ── 标签页下拉：把顶部那行 URL 做成可以切换镜像目标的控件 ── */
          const targets = Array.isArray(ui.targets) ? ui.targets : [];
          const currentId = ui.targetId || '';
          const isManual = !!(ui.manualUntil && Date.now() < ui.manualUntil);
          const shortName = (row) => {
            const raw = (row && (row.title || row.url)) || '';
            if (!raw) return '（无标题）';
            try {
              const u = new URL(raw);
              return (row.title && row.title.trim()) || u.host + (u.pathname === '/' ? '' : u.pathname);
            } catch { return raw; }
          };
          const choose = (targetId) => {
            setPickerOpen(false);
            const mirror = mirrorRef.current;
            if (mirror && typeof mirror.switchTo === 'function') mirror.switchTo(targetId);
          };

          return h('div', { className: 'dsh-cdp-shell', style: S.shell, 'data-dsh-cdp-phase': ui.phase }, [
            h('div', { style: S.bar, key: 'bar' }, [
              h('span', { style: S.status, title: ui.detail || '' }, [
                h('span', { style: { ...S.dot, background: PHASE_COLOR[ui.phase] || PHASE_COLOR.idle } }),
                h('span', null, phaseLabel),
              ]),
              /* 当前 URL：点一下展开标签页列表，选哪页就镜像哪页 */
              h('button', {
                type: 'button',
                key: 'picker',
                'data-dsh-cdp-picker': '1',
                style: { ...S.picker, ...(pickerOpen ? S.pickerOpen : null), flex: '1 1 220px', minWidth: 0 },
                title: (ui.title ? ui.title + '\n' : '') + (ui.url || '') + (targets.length ? '\n共 ' + targets.length + ' 个标签页，点击切换' : ''),
                onClick: () => setPickerOpen((v) => !v),
              }, [
                h('span', { style: S.pickerText }, ui.url || t('empty')),
                isManual ? h('span', { style: S.manualBadge, title: '已手动选择，自动跟随暂停 10 分钟' }, '手动') : null,
                h('span', { style: S.caret, 'aria-hidden': true }, pickerOpen ? '▲' : '▼'),
              ]),
              h('button', {
                style: { ...S.button, opacity: debugOpen ? 1 : 0.55 },
                onClick: () => setShowDebug((v) => !v),
                title: '诊断信息（出问题时自动展开）',
              }, '⚙'),
            ]),
            pickerOpen ? h('div', { style: S.pickerPanel, key: 'picker-panel', 'data-dsh-cdp-picker-panel': '1' }, [
              h('div', { style: S.pickerHead }, 'Chrome 标签页 · ' + targets.length + ' 个' + (isManual ? '（手动模式）' : '')),
              targets.length
                ? h('div', { style: S.pickerList }, targets.map((row) => {
                  const active = row.targetId === currentId;
                  return h('button', {
                    type: 'button',
                    key: row.targetId,
                    style: { ...S.pickerItem, ...(active ? S.pickerItemActive : null) },
                    title: (row.title ? row.title + '\n' : '') + (row.url || ''),
                    onClick: () => choose(row.targetId),
                  }, [
                    h('span', { style: S.pickerDot, 'aria-hidden': true }, active ? '●' : ''),
                    h('span', { style: S.pickerItemBody }, [
                      h('span', { style: S.pickerItemTitle }, shortName(row)),
                      h('span', { style: S.pickerItemUrl }, row.url || ''),
                    ]),
                  ]);
                }))
                : h('div', { style: { ...S.small, padding: '6px 10px' } }, '没有可切换的标签页'),
              isManual ? h('button', {
                type: 'button',
                style: { ...S.pickerItem, ...S.pickerReset },
                onClick: () => {
                  setPickerOpen(false);
                  const mirror = mirrorRef.current;
                  if (mirror) {
                    mirror.manualTargetId = null;
                    mirror.manualUntil = 0;
                    setUi((prev) => ({ ...prev, manualUntil: 0 }));
                    mirror.scheduleFollow();
                  }
                },
              }, '↻ 恢复自动跟随') : null,
            ]) : null,
            debugOpen ? h('div', {
              style: S.diag,
              key: 'diag',
              'data-dsh-cdp-diag': '1',
            }, [
              h('div', null, '状态 ' + phaseLabel + ' · 通道 ' + (ui.via || '未连接') + ' · 帧 ' + stats.frames),
              h('div', null, '页面 ' + (ui.pageOrigin || location.origin) + ' → 桥 ' + (ui.bridgeUrl || '无')),
              ui.detail ? h('div', { style: { color: '#b91c1c' } }, '原因 ' + ui.detail) : null,
              ui.diag ? h('div', null, ui.diag) : null,
            ]) : null,
            h('div', { style: S.stage, ref: stageRef, key: 'stage' }, [
              h('canvas', {
                ref: canvasRef,
                style: S.canvas,
                tabIndex: 0,
                onMouseMove: handlers.onMouseMove,
                onMouseDown: handlers.onMouseDown,
                onMouseUp: handlers.onMouseUp,
                onWheel: handlers.onWheel,
                onContextMenu: handlers.onContextMenu,
                onKeyDown: handlers.onKeyDown,
                onKeyUp: (e) => e.preventDefault(),
                onPaste: handlers.onPaste,
              }),
              h('span', { ref: rippleRef, style: S.ripple }),
              /* 已经有画面就不再压字：这段提示之前盖在 canvas 上，看起来像水印 */
              hint && stats.frames === 0 ? h('div', { style: S.hint }, [h('strong', null, t('phase.' + ui.phase)), h('span', null, hint)]) : null,
            ]),
          ]);
        }

        function CdpTitle(props) {
          const t = typeof props.t === 'function' ? props.t : (key) => zh[key] || key;
          return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } }, [
            h('svg', { width: 14, height: 14, viewBox: '0 0 16 16', 'aria-hidden': true, fill: 'none' }, [
              h('circle', { cx: 8, cy: 8, r: 6.4, stroke: 'currentColor', strokeWidth: 1.4 }),
              h('path', { d: 'M8 1.6a6.4 6.4 0 0 1 5.5 3.2H8', stroke: 'currentColor', strokeWidth: 1.4 }),
              h('circle', { cx: 8, cy: 8, r: 2.4, fill: 'currentColor' }),
            ]),
            h('span', null, t('type.label')),
          ]);
        }

        /* ───────── 注册 ───────── */

        /* 自己独占一个 kind。
           sidebarRightTabs 的 band 规则：extension 可以注册 builtin 已持有的 kind 并「接管」它。
           官方 @deepseek-ai/dsh-client-ui-sidebar-browser 用的是 kind:'browser' / priority:'builtin'，
           如果这里也注册 kind:'browser'，本插件会接管整个 browser kind，会话里的链接就都被
           解析到镜像 tab 上，原来的沙箱浏览器被挤掉。所以用一个不冲突的 kind。 */
        const KIND = 'cdp';

        function apply(ctx) {
          const t = ctx.locale.bind(NS);
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-cdp-sidebar.copy');
          ctx.effect(() => ctx.sidebarRightTabs.register({
            id: PLUGIN_ID,
            kind: KIND,
            multiple: true,
            priority: 'builtin',
            keepMounted: true,
            title: () => t('type.label'),
            guide: [{
              id: 'cdp-mirror',
              order: 25,
              title: () => t('guide.title'),
              description: () => t('guide.description'),
            }],
          }), 'dsh-cdp-sidebar.type');
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab',
            key: PLUGIN_ID,
            locale: NS,
          }, CdpBody)), 'dsh-cdp-sidebar.body');
          ctx.effect(() => ctx.slots.inject('sidebar.right.pane.tab.title', () => ctx.slots.register({
            name: 'sidebar.right.pane.tab.title',
            key: PLUGIN_ID,
            locale: NS,
          }, CdpTitle)), 'dsh-cdp-sidebar.title');
        }

        return { inject, apply };
      },
    });
  } catch (error) {
    console.warn('[dsh-cdp-sidebar] client 注册失败:', error);
  }
})();
