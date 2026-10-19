/* dsh-cdp-sidebar · Host 侧
   1) GET /dsh-cdp/status  → 探测 127.0.0.1:9222 上的 CDP，返回目标清单与桥地址
   2) upgrade /dsh-cdp/ws  → 同源 WebSocket 桥，宿主代浏览器连 Chrome
      （Chrome 的 --remote-allow-origins 只放行宿主 origin，浏览器永远不碰 9222） */

import http from 'node:http';
import crypto from 'node:crypto';

const ROUTE = '/dsh-cdp';
const WS_PATH = '/dsh-cdp/ws';
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const DEFAULT_BASE = 'http://127.0.0.1:9222';
const OFFLINE_HINT = '未找到 CDP。用带 --remote-debugging-port=9222 的 Chrome 快捷方式启动浏览器（桌面 Google Chrome 快捷方式已改好）。';

function safeBase(value) {
  const raw = (value && String(value).trim()) || DEFAULT_BASE;
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:') return null;
  const host = url.hostname;
  if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') return null;
  return url.origin;
}

async function cdpJson(base, path, timeoutMs = 2500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(base + path, { signal: controller.signal });
    if (!response.ok) throw new Error('HTTP ' + response.status);
    const text = await response.text();
    /* Chrome 的 /json/close/{id} 回的是纯文本 "Target is closing"，不是 JSON */
    try { return JSON.parse(text); } catch (error) { return text; }
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------- WebSocket 帧编解码（服务端 + 客户端各用一次） ---------------- */

function maskPayload(body, key) {
  const out = Buffer.from(body);
  for (let i = 0; i < out.length; i += 1) out[i] ^= key[i & 3];
  return out;
}

function encodeFrame(payload, opcode, mask) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8');
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x80 | opcode, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  if (!mask) return Buffer.concat([header, body]);
  /* 客户端方向（宿主 → Chrome）的帧必须掩码，否则 Chrome 直接关闭连接 */
  const key = crypto.randomBytes(4);
  header[1] |= 0x80;
  return Buffer.concat([header, key, maskPayload(body, key)]);
}

function createFrameParser(onFrame) {
  let buffer = Buffer.alloc(0);
  let fragments = [];
  let fragmentOpcode = 0;
  return function feed(chunk) {
    buffer = Buffer.concat([buffer, chunk]);
    for (;;) {
      if (buffer.length < 2) return;
      const first = buffer[0];
      const second = buffer[1];
      const fin = (first & 0x80) !== 0;
      const opcode = first & 0x0f;
      const masked = (second & 0x80) !== 0;
      let length = second & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (buffer.length < 4) return;
        length = buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (buffer.length < 10) return;
        length = Number(buffer.readBigUInt64BE(2));
        offset = 10;
      }
      let mask = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        mask = buffer.subarray(offset, offset + 4);
        offset += 4;
      }
      if (buffer.length < offset + length) return;
      let payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (mask) {
        for (let i = 0; i < length; i += 1) payload[i] ^= mask[i & 3];
      }
      buffer = buffer.subarray(offset + length);
      if (opcode === 0) {
        fragments.push(payload);
        if (!fin) continue;
        payload = Buffer.concat(fragments);
        fragments = [];
        onFrame(fragmentOpcode, payload);
        continue;
      }
      if (!fin) {
        fragments = [payload];
        fragmentOpcode = opcode;
        continue;
      }
      onFrame(opcode, payload);
    }
  };
}

function socketToStream(socket, head, onFrame, onClose, maskOutgoing) {
  const feed = createFrameParser(onFrame);
  if (head && head.length) feed(head);
  socket.on('data', feed);
  socket.on('close', onClose);
  socket.on('error', onClose);
  return {
    send(opcode, payload) {
      if (socket.destroyed || !socket.writable) return false;
      socket.write(encodeFrame(payload, opcode, maskOutgoing));
      return true;
    },
    close() {
      try { socket.write(encodeFrame(Buffer.from([0x03, 0xe8]), 8, maskOutgoing)); } catch {}
      socket.end();
    },
  };
}

/* 宿主 → Chrome 的上游连接。
   Chrome 155 实测：升级请求「不带 Origin 头」直接放行；带 Origin 时必须命中
   --remote-allow-origins 白名单，否则 403。所以默认不发 Origin 头，
   这样桥与 GUI 的 host/port、快捷方式里的白名单彻底解耦。
   偶发的 socket hang up 用一次重试兜住。 */
function connectUpstream(wsUrl, origin, handlers, maxAttempts) {
  const target = new URL(wsUrl);
  const attempts = Math.max(1, maxAttempts || 2);
  let attempt = 0;

  function tryOnce() {
    attempt += 1;
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const headers = {
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-key': key,
      'sec-websocket-version': '13',
    };
    /* 只有显式配置了 DSH_CDP_WS_ORIGIN 才发 Origin 头 */
    if (origin) headers.origin = origin;
    const request = http.request({
      host: target.hostname,
      port: target.port || 80,
      path: target.pathname + (target.search || ''),
      headers,
    });
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      if (attempt < attempts) {
        handlers.retry && handlers.retry(attempt, message);
        setTimeout(tryOnce, 300);
        return;
      }
      handlers.failed(message + (attempts > 1 ? '（共尝试 ' + attempt + ' 次）' : ''));
    };
    request.on('upgrade', (response, socket, head) => {
      settled = true;
      if (response.headers['sec-websocket-accept'] !== expected) {
        handlers.failed('上游 Sec-WebSocket-Accept 校验失败');
        socket.destroy();
        return;
      }
      handlers.opened(socketToStream(socket, head, handlers.frame, handlers.closed, true));
    });
    request.on('response', (response) => {
      const message = 'Chrome 拒绝升级：HTTP ' + response.statusCode;
      response.resume();
      fail(message);
    });
    request.on('error', (error) => fail(String((error && error.message) || error)));
    request.end();
  }

  tryOnce();
}

/* 一次性上游 RPC 通道：给 HTTP 轮询模式（/shot、/exec）用，不走 WebSocket 桥。
   浏览器 → DSH 侧只需要普通 HTTP，任何屏蔽 ws:// 的宿主环境都能出画面。 */
function openRpc(wsUrl) {
  return new Promise((resolve, reject) => {
    const target = new URL(wsUrl);
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
    const request = http.request({
      host: target.hostname,
      port: target.port || 80,
      path: target.pathname + (target.search || ''),
      headers: {
        connection: 'Upgrade',
        upgrade: 'websocket',
        'sec-websocket-key': key,
        'sec-websocket-version': '13',
      },
    });
    let settled = false;
    const fail = (message) => {
      if (settled) return;
      settled = true;
      reject(new Error(message));
    };
    request.on('upgrade', (response, socket, head) => {
      settled = true;
      if (response.headers['sec-websocket-accept'] !== expected) {
        socket.destroy();
        fail('上游 Sec-WebSocket-Accept 校验失败');
        return;
      }
      const pending = new Map();
      let seq = 0;
      let alive = true;
      const stream = socketToStream(
        socket,
        head,
        (opcode, payload) => {
          if (opcode !== 1) return;
          let m;
          try { m = JSON.parse(payload.toString('utf8')); } catch { return; }
          if (!m || !m.id || !pending.has(m.id)) return;
          const entry = pending.get(m.id);
          pending.delete(m.id);
          clearTimeout(entry.timer);
          if (m.error) entry.reject(new Error(JSON.stringify(m.error)));
          else entry.resolve(m.result);
        },
        () => {
          alive = false;
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            entry.reject(new Error('上游连接已关闭'));
          }
          pending.clear();
        },
        true,
      );
      resolve({
        call(method, params, sessionId, timeoutMs) {
          const id = ++seq;
          const payload = sessionId ? { id, sessionId, method, params } : { id, method, params };
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              if (pending.delete(id)) rej(new Error('CDP 超时 ' + method));
            }, timeoutMs || 6000);
            pending.set(id, { resolve: res, reject: rej, timer });
            if (!stream.send(1, JSON.stringify(payload))) {
              clearTimeout(timer);
              pending.delete(id);
              rej(new Error('上游不可写'));
            }
          });
        },
        alive() { return alive; },
        close() { alive = false; stream.close(); },
      });
    });
    request.on('response', (response) => {
      const message = 'Chrome 拒绝升级：HTTP ' + response.statusCode;
      response.resume();
      fail(message);
    });
    request.on('error', (error) => fail(String((error && error.message) || error)));
    request.end();
  });
}

/* 轮询 / exec 用的上游会话：一条长连接 + 一个 attach 会话，按目标复用并串行执行。
   之前每次 /shot 都重开一条上游连接，Chrome 侧排队 → Page.captureScreenshot 9 秒不返回。 */
class PollSessions {
  constructor(cdpBase) {
    this.base = cdpBase;
    this.entries = new Map();
  }
  async open(targetId) {
    const version = await cdpJson(this.base, '/json/version');
    const wsUrl = version && version.webSocketDebuggerUrl;
    if (!wsUrl) throw new Error('/json/version 没有 webSocketDebuggerUrl');
    const rpc = await openRpc(wsUrl);
    const attached = await rpc.call('Target.attachToTarget', { targetId, flatten: true }, null, 8000);
    const sessionId = attached && attached.sessionId;
    if (!sessionId) {
      rpc.close();
      throw new Error('Target.attachToTarget 没返回 sessionId');
    }
    return { rpc, sessionId };
  }
  closeEntry(targetId) {
    const entry = this.entries.get(targetId);
    if (!entry) return;
    this.entries.delete(targetId);
    if (entry.rpc) {
      try { entry.rpc.close(); } catch { /* 已关闭 */ }
    }
  }
  closeAll() {
    for (const targetId of [...this.entries.keys()]) this.closeEntry(targetId);
  }
  async run(targetId, fn) {
    let entry = this.entries.get(targetId);
    if (!entry) {
      /* 别攒着一堆死目标的会话：超过 4 个就关掉最早的那个 */
      if (this.entries.size > 4) {
        const oldest = this.entries.keys().next().value;
        this.closeEntry(oldest);
      }
      entry = { chain: Promise.resolve(), rpc: null, sessionId: null };
      this.entries.set(targetId, entry);
    }
    const task = entry.chain.then(async () => {
      if (!entry.rpc || !entry.rpc.alive() || !entry.sessionId) {
        if (entry.rpc) {
          try { entry.rpc.close(); } catch { /* 已关闭 */ }
        }
        const fresh = await this.open(targetId);
        entry.rpc = fresh.rpc;
        entry.sessionId = fresh.sessionId;
      }
      try {
        return await fn(entry.rpc, entry.sessionId);
      } catch (error) {
        /* 会话可能已被 Chrome 收回：重建一次再试一回 */
        try { if (entry.rpc) entry.rpc.close(); } catch { /* 已关闭 */ }
        const fresh = await this.open(targetId);
        entry.rpc = fresh.rpc;
        entry.sessionId = fresh.sessionId;
        return await fn(entry.rpc, entry.sessionId);
      }
    });
    entry.chain = task.then(() => undefined, () => undefined);
    return task;
  }
}

async function captureShot(sessions, targetId, quality) {
  return sessions.run(targetId, async (rpc, sessionId) => {
    const shot = await rpc.call('Page.captureScreenshot', { format: 'jpeg', quality: quality || 62 }, sessionId, 9000);
    const info = await rpc.call('Target.getTargetInfo', { targetId }).catch(() => null);
    const target = info && info.targetInfo;
    return {
      data: shot && shot.data,
      url: (target && target.url) || '',
      title: (target && target.title) || '',
    };
  });
}

/* ---------------- 标签页归属与回收（用完即弃） ----------------
   判据来自实测：
     · 插件装载时 /json/list 里已存在的 page 目标 = 用户自己窗口里的 → 永不自动关
     · 装载之后新出现的 page 目标 = 自动化开的 → 才是回收候选
     · chrome:// 一类永不关；侧栏正在镜像的那个永不关
   关一个 tab 只用 Chrome 的 HTTP 端点 GET /json/close/{targetId}，不需要 WebSocket。
   claim（认领）= 「有人正在用这个 tab」：租约没到期不关，用完 release 立刻关。 */

const NEVER_REAP_URL = /^(chrome|chrome-untrusted|devtools|view-source|chrome-extension):\/\//i;
const REAP_DEFAULTS = {
  tickMs: 10000,      /* 每 10 秒扫一遍 */
  orphanMs: 120000,   /* 自动化开的、没人认领：闲置 2 分钟即弃 */
  leaseMs: 900000,    /* 认领了但一直没续租也没 release：15 分钟兜底弃 */
  maxPerTick: 3,      /* 一次最多关 3 个，避免一轮清空 */
};

/* 有上限的追加：审计桶只留最近 limit 条 */
function push(bucket, entry, limit) {
  bucket.push(entry);
  if (bucket.length > limit) bucket.shift();
  return entry;
}

class TabKeeper {
  constructor(cdpBase, cfg) {
    this.base = cdpBase;
    this.cfg = { ...REAP_DEFAULTS, ...(cfg || {}) };
    this.enabled = this.cfg.orphanMs > 0;
    this.protected = new Set();   /* 装载时就存在的目标：用户自己的，永不关 */
    this.seen = new Map();        /* targetId -> {url,title,firstSeen,lastChange} */
    this.leases = new Map();      /* targetId -> {owner,purpose,claimedAt,lastTouch,leaseUntil,primary} */
    this.reaps = [];              /* 回收审计 */
    this.mirrored = null;         /* 侧栏当前镜像的那个，永不关 */
    this.seeded = false;
    this.sweeping = false;
    this.timer = null;
  }
  async pages() {
    const list = await cdpJson(this.base, '/json/list');
    return (Array.isArray(list) ? list : []).filter((item) => item && item.type === 'page');
  }
  /* 装载时先照一张相：这一批全是用户自己的标签页 */
  async seed() {
    const pages = await this.pages();
    const stamp = Date.now();
    for (const page of pages) {
      this.protected.add(page.id);
      this.seen.set(page.id, { targetId: page.id, url: page.url || '', title: page.title || '', firstSeen: stamp, lastChange: stamp });
    }
    this.seeded = true;
    return { protected: this.protected.size, pages: pages.length };
  }
  track(page) {
    const prev = this.seen.get(page.id);
    const now = Date.now();
    const moved = !!prev && (prev.url !== (page.url || '') || prev.title !== (page.title || ''));
    this.seen.set(page.id, {
      targetId: page.id,
      url: page.url || '',
      title: page.title || '',
      firstSeen: prev ? prev.firstSeen : now,
      lastChange: moved ? now : (prev ? prev.lastChange : now),
    });
    /* 新出现的、或换了页面的，都算「有人在动它」：租约跟着续一口，不然正在干活的 tab 会被到期误关 */
    if (!prev || moved) {
      const lease = this.leases.get(page.id);
      if (lease) {
        lease.lastTouch = now;
        lease.leaseUntil = now + this.cfg.leaseMs;
      }
    }
    return { isNew: !prev, moved };
  }
  forget(targetId) {
    this.seen.delete(targetId);
    this.leases.delete(targetId);
  }
  async resolveTargetId(body) {
    const explicit = String((body && (body.targetId || body.target)) || '');
    if (explicit) return explicit;
    const want = String((body && body.url) || '');
    if (!want) return null;
    for (const row of this.seen.values()) if (row.url === want) return row.targetId;
    for (const row of this.seen.values()) if (row.url && row.url.startsWith(want)) return row.targetId;
    /* 刚 new_page 出来的 target 可能还没被这一轮 sweep 照到：现查一次 Chrome */
    try {
      const pages = await this.pages();
      for (const page of pages) if ((page.url || '') === want) { this.track(page); return page.id; }
      for (const page of pages) if ((page.url || '').startsWith(want)) { this.track(page); return page.id; }
    } catch { /* Chrome 不可达时退回已知的 */ }
    return null;
  }
  async claim(body) {
    const targetId = await this.resolveTargetId(body);
    if (!targetId) return null;
    const now = Date.now();
    const owner = String((body && body.owner) || 'main').slice(0, 40);
    const ttl = Math.min(3600000, Math.max(30000, Number(body && body.ttlMs) || this.cfg.leaseMs));
    const prev = this.leases.get(targetId);
    const entry = {
      targetId,
      owner,
      purpose: String((body && body.purpose) || '').slice(0, 120),
      claimedAt: prev ? prev.claimedAt : now,
      lastTouch: now,
      leaseUntil: now + ttl,
      primary: owner === 'main' || (body && body.primary === true),
    };
    this.leases.set(targetId, entry);
    if (!this.protected.has(targetId)) this.seen.set(targetId, {
      targetId,
      url: (this.seen.get(targetId) || {}).url || String((body && body.url) || ''),
      title: (this.seen.get(targetId) || {}).title || '',
      firstSeen: (this.seen.get(targetId) || {}).firstSeen || now,
      lastChange: now,
    });
    return entry;
  }
  async touch(body) {
    const targetId = await this.resolveTargetId(body);
    if (!targetId) return null;
    const lease = this.leases.get(targetId);
    if (!lease) return null;
    lease.lastTouch = Date.now();
    lease.leaseUntil = lease.lastTouch + Math.min(3600000, Math.max(30000, Number(body && body.ttlMs) || this.cfg.leaseMs));
    return lease;
  }
  /* 侧栏粘住的就是它：owner=main 的租约里最近被碰的那个 */
  primaryLease() {
    let best = null;
    for (const lease of this.leases.values()) {
      if (!lease.primary) continue;
      if (!best || lease.lastTouch > best.lastTouch) best = lease;
    }
    return best;
  }
  ownersOf(body) {
    const out = [];
    const wantTarget = String((body && (body.targetId || body.target)) || '');
    const wantOwner = String((body && body.owner) || '');
    const all = body && body.all === true;
    for (const [targetId, lease] of this.leases) {
      if (all) { out.push(targetId); continue; }
      if (wantTarget && targetId === wantTarget) { out.push(targetId); continue; }
      if (wantOwner && lease.owner === wantOwner) out.push(targetId);
    }
    return out;
  }
  async close(targetId, reason, owner) {
    const row = this.seen.get(targetId) || {};
    const text = await cdpJson(this.base, '/json/close/' + encodeURIComponent(targetId));
    this.forget(targetId);
    if (this.mirrored === targetId) this.mirrored = null;
    const entry = push(this.reaps, {
      t: Date.now(),
      targetId,
      reason,
      owner: owner || null,
      url: String(row.url || '').slice(0, 160),
      chrome: String(typeof text === 'string' ? text : JSON.stringify(text) || '').slice(0, 60),
    }, 30);
    console.log('[dsh-cdp-sidebar] 弃标签页 ' + targetId.slice(0, 8) + ' 原因=' + reason + ' owner=' + (owner || '-') + ' url=' + entry.url);
    return entry;
  }
  /* 一个 page 目标该不该关，返回 null 表示不动 */
  candidate(page) {
    if (this.protected.has(page.id)) return null;
    if (NEVER_REAP_URL.test(page.url || '')) return null;
    if (this.mirrored && page.id === this.mirrored) return null;
    const now = Date.now();
    const lease = this.leases.get(page.id);
    const row = this.seen.get(page.id) || { firstSeen: now, lastChange: now };
    if (lease) {
      if (lease.leaseUntil > now) return null;
      return { reason: '租约到期未释放', owner: lease.owner, idleMs: now - lease.lastTouch };
    }
    const idleMs = now - Math.max(row.firstSeen, row.lastChange);
    if (idleMs < this.cfg.orphanMs) return null;
    return { reason: '自动化开的且闲置', owner: null, idleMs };
  }
  async sweep(mirroredTargetId) {
    if (!this.enabled || this.sweeping) return null;
    this.sweeping = true;
    try {
      if (mirroredTargetId) this.mirrored = mirroredTargetId;
      const pages = await this.pages();
      for (const page of pages) this.track(page);
      const alive = new Set(pages.map((page) => page.id));
      for (const targetId of [...this.seen.keys()]) if (!alive.has(targetId) && !this.protected.has(targetId)) this.forget(targetId);
      const closed = [];
      for (const page of pages) {
        if (closed.length >= this.cfg.maxPerTick) break;
        const verdict = this.candidate(page);
        if (!verdict) continue;
        try { await this.close(page.id, verdict.reason, verdict.owner); closed.push(page.id); }
        catch (error) { console.warn('[dsh-cdp-sidebar] 弃标签页失败 ' + page.id.slice(0, 8) + ' ' + String((error && error.message) || error)); }
      }
      return { scanned: pages.length, closed, protectedCount: this.protected.size, leases: this.leases.size };
    } finally {
      this.sweeping = false;
    }
  }
  start(getMirrored) {
    if (!this.enabled) return null;
    this.timer = setInterval(() => {
      this.sweep(typeof getMirrored === 'function' ? getMirrored() : null).catch(() => {});
    }, this.cfg.tickMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
    return this.timer;
  }
  stop() {
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }
  snapshot() {
    const now = Date.now();
    const rows = [];
    for (const [targetId, row] of this.seen) {
      const lease = this.leases.get(targetId);
      rows.push({
        targetId,
        url: row.url,
        title: row.title,
        owner: lease ? lease.owner : null,
        purpose: lease ? lease.purpose : '',
        primary: lease ? !!lease.primary : false,
        protected: this.protected.has(targetId),
        mirrored: this.mirrored === targetId,
        ageMs: now - row.firstSeen,
        idleMs: now - Math.max(row.firstSeen, row.lastChange),
        leaseUntil: lease ? lease.leaseUntil : null,
        reapable: !this.protected.has(targetId) && !NEVER_REAP_URL.test(row.url || '') && this.mirrored !== targetId
          && !(lease && lease.leaseUntil > now),
      });
    }
    rows.sort((a, b) => (b.primary ? 1 : 0) - (a.primary ? 1 : 0) || b.idleMs - a.idleMs);
    return {
      enabled: this.enabled,
      seeded: this.seeded,
      cfg: this.cfg,
      mirrored: this.mirrored,
      primary: (this.primaryLease() || {}).targetId || null,
      protectedCount: this.protected.size,
      tabs: rows,
      reaps: this.reaps.slice(-10),
    };
  }
}

function readJsonBody(req, limit) {
  const max = limit || 65536;
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > max) { reject(new Error('请求体过大')); req.destroy(); return; }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch (error) { reject(new Error('请求体不是合法 JSON：' + String((error && error.message) || error))); }
    });
    req.on('error', reject);
  });
}

function bridgeSocket(req, socket, head, base, upstreamOrigin, rec) {
  const key = req.headers['sec-websocket-key'];
  if (!key || String(req.headers.upgrade || '').toLowerCase() !== 'websocket') {
    if (rec) rec.result = '握手前拒绝：缺少 websocket 升级头';
    socket.write('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  if (rec) rec.handshake = '101';
  const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64');
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
    'upgrade: websocket\r\n' +
    'connection: Upgrade\r\n' +
    'sec-websocket-accept: ' + accept + '\r\n\r\n',
  );

  let upstream = null;
  let pending = [];
  let closed = false;
  let framesToClient = 0;
  let framesToUpstream = 0;
  const downstream = socketToStream(socket, head, (opcode, payload) => {
    if (opcode === 8) { finish('浏览器侧关闭'); return; }
    if (opcode === 9) { downstream.send(10, payload); return; }
    /* 只读观测：客户端这侧发了哪些 CDP 命令。
       有了它，不用盯 Electron 窗口也能远程确认「自动跟随」真的在跑。 */
    if (opcode === 1 && rec) {
      framesToUpstream += 1;
      rec.framesToUpstream = framesToUpstream;
      try {
        const msg = JSON.parse(payload.toString('utf8'));
        const method = msg && msg.method;
        if (method === 'Target.setDiscoverTargets') rec.discoverSent = !!(msg.params && msg.params.discover);
        if (method === 'Target.attachToTarget') {
          rec.attached = (rec.attached || []).concat([String((msg.params && msg.params.targetId) || '')]);
          if (rec.attached.length > 12) rec.attached.shift();
        }
      } catch { /* 非 JSON 帧（输入事件也是 JSON，这里只是防御畸形帧） */ }
    }
    if (upstream) upstream.send(opcode, payload);
    else pending.push([opcode, payload]);
  }, () => finish('浏览器侧 socket 断开'));

  function finish(reason) {
    if (closed) return;
    closed = true;
    if (rec) {
      rec.closedAt = Date.now();
      rec.closeReason = reason || 'unknown';
      rec.framesToClient = framesToClient;
      rec.framesToUpstream = framesToUpstream;
    }
    if (upstream) upstream.close();
    downstream.close();
  }

  cdpJson(base, '/json/version')
    .then((version) => {
      const wsUrl = version && version.webSocketDebuggerUrl;
      if (rec) {
        rec.chromeReachable = true;
        rec.browser = version && version.Browser;
        rec.upstreamUrl = wsUrl || null;
      }
      if (!wsUrl) {
        if (rec) rec.result = '失败：/json/version 没有 webSocketDebuggerUrl';
        downstream.send(1, JSON.stringify({ error: 'no webSocketDebuggerUrl' }));
        finish('无上游地址');
        return;
      }
      connectUpstream(wsUrl, upstreamOrigin, {
        opened(up) {
          if (closed) { up.close(); return; }
          upstream = up;
          if (rec) rec.result = '已连上 Chrome';
          downstream.send(1, JSON.stringify({ dshBridge: 'connected', browser: version.Browser }));
          for (const [opcode, payload] of pending) upstream.send(opcode, payload);
          pending = [];
        },
        frame(opcode, payload) {
          if (opcode === 8) { finish('Chrome 侧关闭'); return; }
          if (opcode === 9) { upstream.send(10, payload); return; }
          if (opcode === 1 && payload.length > 400) framesToClient += 1;
          if (rec) { rec.lastOpcode = opcode; rec.framesToClient = framesToClient; }
          downstream.send(opcode, payload);
        },
        closed() { finish('Chrome 侧 socket 断开'); },
        retry(attempt, message) {
          if (rec) rec.retryFrom = (rec.retryFrom || []) .concat([attempt + ':' + message]);
          downstream.send(1, JSON.stringify({ dshBridge: 'retrying', attempt, error: message }));
        },
        failed(message) {
          if (rec) rec.result = '上游失败：' + message;
          downstream.send(1, JSON.stringify({ dshBridge: 'failed', error: message }));
          finish('上游失败');
        },
      });
    })
    .catch((error) => {
      const message = String((error && error.message) || error);
      if (rec) {
        rec.chromeReachable = false;
        rec.result = 'Chrome 不可达：' + message;
      }
      downstream.send(1, JSON.stringify({ dshBridge: 'failed', error: message }));
      finish('Chrome 不可达');
    });
}

export function apply(ctx, config) {
  return ctx.inject(['webServer'], (scope) => {
    const webServer = scope.webServer;
    const base = safeBase(process.env.DSH_CDP_URL);
    const canBridge = typeof webServer.registerUpgrade === 'function';
    const disposers = [];

    /* 诊断环形缓冲：宿主侧不需要 GUI token 就能读到浏览器到底发了什么 */
    const diag = {
      startedAt: Date.now(),
      requests: [],
      sessions: [],
      reports: [],
      webServerApi: Object.keys(webServer || {}).map((key) => key + ':' + typeof webServer[key]),
      canBridge,
      wsPath: WS_PATH,
      envOrigin: process.env.DSH_CDP_WS_ORIGIN || null,
    };
    const requestRecord = (req) => push(diag.requests, {
      t: Date.now(),
      method: String(req.method || ''),
      path: String(req.url || ''),
      host: String(req.headers.host || ''),
      origin: req.headers.origin || null,
      upgrade: req.headers.upgrade || null,
      secWebSocketVersion: req.headers['sec-websocket-version'] || null,
      hasWsKey: Boolean(req.headers['sec-websocket-key']),
      referer: req.headers.referer || null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 80),
    }, 30);

    /* 桥地址候选：页面同源一个 + 宿主自己监听的地址。
       GUI 若跑在自定义 scheme / 反代后面，同源那个可能连不上，客户端就换候选。 */
    const bridgeCandidates = (req) => {
      const out = [];
      const add = (hostHeader, secure) => {
        if (!hostHeader) return;
        const wsUrl = (secure ? 'wss://' : 'ws://') + hostHeader + WS_PATH;
        if (!out.includes(wsUrl)) out.push(wsUrl);
      };
      add(String(req.headers.host || ''), String(req.headers['x-forwarded-proto'] || '') === 'https');
      const port = typeof webServer.listenedPort === 'number' ? webServer.listenedPort : null;
      if (port) {
        add('127.0.0.1:' + port, false);
        add('localhost:' + port, false);
      }
      return out;
    };

    /* 轮询模式的画面去重：同一目标并发请求共用一次截图 */
    const shotInFlight = new Map();
    const sessions = new PollSessions(base);
    const pickTargetId = async (cdpBase) => {
      const list = await cdpJson(cdpBase, '/json/list');
      const pages = (Array.isArray(list) ? list : []).filter((item) => item && item.type === 'page');
      const preferred = pages.find((item) => !/^chrome(-untrusted)?:\/\//.test(item.url || '')) || pages[0];
      return preferred ? preferred.id : null;
    };

    if (!base) {
      disposers.push(webServer.register({
        kind: 'prefix',
        path: ROUTE,
        handler(_req, res) {
          res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, hint: 'DSH_CDP_URL 只允许 127.0.0.1 / localhost 的 http 地址。' }));
        },
      }));
      return () => { for (const dispose of disposers) dispose(); };
    }

    /* ───────── 标签页归属与回收 ─────────
       装载时先照一张相：这一批 page 目标是用户自己窗口里的，永不自动关。
       之后新出现的才算「自动化开的」，才可能被弃。DSH_CDP_REAP=0 整体关掉这个行为。 */
    const reapCfg = {
      tickMs: Number(process.env.DSH_CDP_REAP_TICK_MS) || REAP_DEFAULTS.tickMs,
      orphanMs: process.env.DSH_CDP_REAP === '0' ? 0 : (Number(process.env.DSH_CDP_REAP_ORPHAN_MS) || REAP_DEFAULTS.orphanMs),
      leaseMs: Number(process.env.DSH_CDP_REAP_LEASE_MS) || REAP_DEFAULTS.leaseMs,
      maxPerTick: Number(process.env.DSH_CDP_REAP_MAX) || REAP_DEFAULTS.maxPerTick,
    };
    const tabs = new TabKeeper(base, reapCfg);
    tabs.seed()
      .then((info) => console.log('[dsh-cdp-sidebar] 标签页回收就位：受保护 ' + info.protected + ' 个（装载时就有的，永不自动关），回收=' + (tabs.enabled ? '开（闲置 ' + Math.round(tabs.cfg.orphanMs / 1000) + 's）' : '关（DSH_CDP_REAP=0）')))
      .catch((error) => console.warn('[dsh-cdp-sidebar] 标签页快照失败：' + String((error && error.message) || error)));
    /* 侧栏正在镜像哪个 target：从活的桥会话里读，那个永不自动关 */
    const mirroredTargetId = () => {
      for (let i = diag.sessions.length - 1; i >= 0; i -= 1) {
        const rec = diag.sessions[i];
        if (rec.closedAt) continue;
        if (Array.isArray(rec.attached) && rec.attached.length) return rec.attached[rec.attached.length - 1];
      }
      return null;
    };
    tabs.start(mirroredTargetId);
    disposers.push(() => tabs.stop());
    /* 给客户端的精简版：粘住哪个 target、当前镜像哪个、还有哪些租约 */
    const tabState = () => {
      const primary = tabs.primaryLease();
      return {
        enabled: tabs.enabled,
        primary: primary ? primary.targetId : null,
        mirrored: tabs.mirrored,
        protectedCount: tabs.protected.size,
        leases: [...tabs.leases.values()].map((lease) => ({ targetId: lease.targetId, owner: lease.owner, primary: !!lease.primary, leaseUntil: lease.leaseUntil })),
      };
    };

    const TAB_POSTS = new Set(['exec', 'report', 'tab/claim', 'tab/release', 'tab/touch', 'tab/reap']);

    disposers.push(webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        const record = requestRecord(req);
        const url = new URL(req.url || '/', 'http://127.0.0.1');
        const sub = url.pathname.slice(ROUTE.length).replace(/^\//, '');
        if (req.method !== 'GET' && !(TAB_POSTS.has(sub) && req.method === 'POST')) {
          record.result = '405';
          res.writeHead(405, { allow: 'GET, POST', 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, hint: 'GET /dsh-cdp/status | /targets | /tabs | /shot | /diag，POST /dsh-cdp/exec | /report | /tab/claim | /tab/release | /tab/touch | /tab/reap' }));
          return;
        }
        if (sub === 'diag') {
          record.result = '200 diag';
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({
            ok: true,
            base,
            canBridge: diag.canBridge,
            wsPath: diag.wsPath,
            envOrigin: diag.envOrigin,
            webServerApi: diag.webServerApi,
            listenedPort: typeof webServer.listenedPort === 'number' ? webServer.listenedPort : null,
            bridgeCandidates: bridgeCandidates(req),
            uptimeMs: Date.now() - diag.startedAt,
            requests: diag.requests.slice(-25),
            sessions: diag.sessions.slice(-15),
            reports: diag.reports.slice(-15),
            pollSessions: sessions.entries.size,
            tabs: tabs.snapshot(),
          }));
          return;
        }
        if (sub === 'shot') {
          const requested = url.searchParams.get('target') || '';
          const quality = Math.min(90, Math.max(20, Number(url.searchParams.get('quality')) || 62));
          try {
            const targetId = requested || await pickTargetId(base);
            if (!targetId) throw new Error('9222 上没有 page 目标');
            let inflight = shotInFlight.get(targetId);
            if (!inflight) {
              inflight = captureShot(sessions, targetId, quality).finally(() => shotInFlight.delete(targetId));
              shotInFlight.set(targetId, inflight);
            }
            const shot = await inflight;
            record.result = '200 shot ' + (shot && shot.data ? shot.data.length : 0) + 'B';
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, targetId, ...shot }));
          } catch (error) {
            const message = String((error && error.message) || error);
            record.result = '502 shot ' + message;
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: false, hint: OFFLINE_HINT, detail: message }));
          }
          return;
        }
        if (sub === 'exec') {
          try {
            const body = await readJsonBody(req);
            const method = String(body.method || '');
            if (!/^Page\.|^Input\.|^Runtime\.evaluate$|^Target\.activateTarget$|^Target\.getNavigationHistory$|^Page\.getNavigationHistory$/.test(method)) {
              throw new Error('不允许的 CDP 方法：' + method);
            }
            const targetId = String(body.target || '') || await pickTargetId(base);
            if (!targetId) throw new Error('9222 上没有 page 目标');
            const result = await sessions.run(targetId, (rpc, sessionId) => rpc.call(method, body.params || {}, sessionId, 8000));
            record.result = '200 exec ' + method;
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, targetId, result }));
          } catch (error) {
            const message = String((error && error.message) || error);
            record.result = '502 exec ' + message;
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: false, detail: message }));
          }
          return;
        }
        if (sub === 'report') {
          /* 客户端把自己那侧的失败原因送上来，宿主这边不用 GUI token 就能读到 */
          try {
            const body = await readJsonBody(req, 8192);
            const entry = push(diag.reports, {
              t: Date.now(),
              phase: String(body.phase || '').slice(0, 40),
              via: String(body.via || '').slice(0, 20),
              page: String(body.page || '').slice(0, 160),
              bridge: String(body.bridge || '').slice(0, 160),
              error: String(body.error || '').slice(0, 400),
              note: String(body.note || '').slice(0, 240),
              userAgent: String(req.headers['user-agent'] || '').slice(0, 80),
            }, 20);
            record.result = '200 report ' + entry.phase;
            console.log('[dsh-cdp-sidebar] 客户端上报 phase=' + entry.phase + ' via=' + entry.via + ' page=' + entry.page + ' error=' + entry.error);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true }));
          } catch (error) {
            record.result = '400 report ' + String((error && error.message) || error);
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, detail: String((error && error.message) || error) }));
          }
          return;
        }
        if (sub === 'tabs') {
          const snapshot = tabs.snapshot();
          record.result = '200 tabs ' + snapshot.tabs.length;
          res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({ ok: true, ...snapshot }));
          return;
        }
        if (sub === 'tab/claim' || sub === 'tab/touch') {
          try {
            const body = await readJsonBody(req, 8192);
            const entry = await (sub === 'tab/claim' ? tabs.claim(body) : tabs.touch(body));
            if (!entry) {
              record.result = '404 ' + sub;
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, hint: '没找到这个标签页：给 targetId（或 target）或已存在的 url', seen: [...tabs.seen.keys()].map((id) => id.slice(0, 8)) }));
              return;
            }
            record.result = '200 ' + sub + ' ' + entry.owner;
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, lease: entry, primary: (tabs.primaryLease() || {}).targetId || null }));
          } catch (error) {
            const message = String((error && error.message) || error);
            record.result = '400 ' + sub + ' ' + message;
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, detail: message }));
          }
          return;
        }
        if (sub === 'tab/release') {
          try {
            const body = await readJsonBody(req, 8192);
            const targets = tabs.ownersOf(body);
            if (!targets.length) {
              record.result = '404 tab/release';
              res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
              res.end(JSON.stringify({ ok: false, hint: '没有匹配的租约：给 targetId / owner / all:true' }));
              return;
            }
            /* 默认释放即关页；close:false 只注销租约、标签页留着 */
            const shouldClose = !(body && body.close === false);
            const closed = [];
            const dropped = [];
            const failed = [];
            for (const targetId of targets) {
              const lease = tabs.leases.get(targetId);
              if (!shouldClose) { tabs.leases.delete(targetId); dropped.push(targetId); continue; }
              try { await tabs.close(targetId, '显式释放', lease ? lease.owner : null); closed.push(targetId); }
              catch (error) { tabs.forget(targetId); failed.push({ targetId, detail: String((error && error.message) || error) }); }
            }
            record.result = '200 tab/release closed=' + closed.length + ' dropped=' + dropped.length;
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, closed: closed.map((id) => id.slice(0, 8)), dropped: dropped.map((id) => id.slice(0, 8)), failed }));
          } catch (error) {
            const message = String((error && error.message) || error);
            record.result = '400 tab/release ' + message;
            res.writeHead(400, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, detail: message }));
          }
          return;
        }
        if (sub === 'tab/reap') {
          try {
            const result = await tabs.sweep(mirroredTargetId());
            record.result = '200 tab/reap closed=' + (result ? result.closed.length : 0);
            res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
            res.end(JSON.stringify({ ok: true, result, tabs: tabs.snapshot() }));
          } catch (error) {
            const message = String((error && error.message) || error);
            record.result = '502 tab/reap ' + message;
            res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ ok: false, detail: message }));
          }
          return;
        }
        if (sub !== 'status' && sub !== 'targets') {
          record.result = '404 ' + sub;
          res.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, hint: '未知子路径 ' + sub }));
          return;
        }
        try {
          const version = await cdpJson(base, '/json/version');
          const list = await cdpJson(base, '/json/list');
          const targets = (Array.isArray(list) ? list : [])
            .filter((item) => item && item.type === 'page')
            .map((item) => {
              const lease = tabs.leases.get(item.id);
              return {
                id: item.id,
                url: item.url,
                title: item.title,
                webSocketDebuggerUrl: item.webSocketDebuggerUrl,
                owner: lease ? lease.owner : null,
                primary: lease ? !!lease.primary : false,
                protected: tabs.protected.has(item.id),
                mirrored: tabs.mirrored === item.id,
              };
            });
          res.writeHead(200, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          });
          record.result = '200 ' + sub + ' targets=' + targets.length;
          res.end(JSON.stringify({
            ok: true,
            base,
            browser: version.Browser,
            protocol: version.Protocol_Version,
            webSocketDebuggerUrl: version.webSocketDebuggerUrl,
            bridge: canBridge ? WS_PATH : null,
            bridgeCandidates: bridgeCandidates(req),
            targets,
            tabState: tabState(),
          }));
        } catch (error) {
          record.result = '502 ' + String((error && error.message) || error);
          res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
          res.end(JSON.stringify({
            ok: false,
            base,
            bridge: canBridge ? WS_PATH : null,
            hint: OFFLINE_HINT,
            detail: String((error && error.message) || error),
          }));
        }
      },
    }));

    if (typeof webServer.registerUpgrade === 'function') {
      disposers.push(webServer.registerUpgrade({
        path: WS_PATH,
        handler(req, socket, head) {
          const hostHeader = String(req.headers.host || '127.0.0.1:19387');
          /* 默认不发 Origin 头：Chrome 对无 Origin 的升级直接放行 */
          const origin = process.env.DSH_CDP_WS_ORIGIN || null;
          const rec = push(diag.sessions, {
            t: Date.now(),
            path: String(req.url || ''),
            host: hostHeader,
            originHeader: req.headers.origin || null,
            secWebSocketVersion: req.headers['sec-websocket-version'] || null,
            hasWsKey: Boolean(req.headers['sec-websocket-key']),
            userAgent: String(req.headers['user-agent'] || '').slice(0, 80),
            upstreamOriginUsed: origin || '（不发 Origin 头）',
            handshake: null,
            chromeReachable: null,
            upstreamUrl: null,
            browser: null,
            result: '已收到升级请求',
            closedAt: null,
            closeReason: null,
            framesToClient: 0,
            framesToUpstream: 0,
            discoverSent: false,
            attached: [],
          }, 20);
          console.log('[dsh-cdp-sidebar] upgrade 到达 path=' + rec.path + ' host=' + rec.host + ' origin=' + (rec.originHeader || '无'));
          bridgeSocket(req, socket, head, base, origin, rec);
        },
      }));
      console.log('[dsh-cdp-sidebar] 已注册 upgrade ' + WS_PATH + '，上游 Origin ' + (diag.envOrigin || '不发送（Chrome 直接放行）'));
    } else {
      /* 宿主不提供 upgrade 路由时，status 不带 bridge，客户端自动退回直连 */
      disposers.push(() => {});
    }

    return () => {
      sessions.closeAll();
      for (const dispose of disposers) dispose();
    };
  });
}
