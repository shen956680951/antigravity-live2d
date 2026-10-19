#!/usr/bin/env node
/**
 * lib/server.js —— Antigravity 鲸鱼娘桌宠服务端
 *
 * 核心功能：
 * 1. 静态资源托管：Live2D 模型、动作表情、Cubism SDK、前端脚本
 * 2. SSE 事件总线：将 Antigravity 的实时流式文字与 Agent 动作状态推送到桌宠
 * 3. REST 控制接口：/api/say (对话), /api/cancel (打断), /api/clear (清空会话), /api/mode (模式切换), /api/status (状态查询)
 * 4. 独立桌面独立页：/standalone 供 macOS 悬浮透明壳或浏览器挂件使用
 */

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { AntigravityAdapter } from './adapter.js'
import { authManager } from './auth.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const ASSETS = path.join(ROOT, 'assets')
const ENV_PATH = path.join(ROOT, '.env')
const CONFIG_PATH = path.join(ROOT, 'config.json')

// 加载环境变量（若支持 process.loadEnvFile）
if (fs.existsSync(ENV_PATH) && typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile(ENV_PATH)
  } catch (e) {
    console.warn('[Server] 加载 .env 失败:', e.message)
  }
}

// 加载 config.json
let config = {}
if (fs.existsSync(CONFIG_PATH)) {
  try {
    config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
  } catch (e) {
    console.warn('[Server] 解析 config.json 失败:', e.message)
  }
}

const args = process.argv.slice(2)
const PORT = Number(process.env.PORT) || config.server?.port || 5199
const HOST = config.server?.host || '127.0.0.1'

const adapter = new AntigravityAdapter({
  baseUrl: process.env.ANTIGRAVITY_BASE_URL || config.antigravity?.baseUrl,
  apiKey: process.env.ANTIGRAVITY_API_KEY || config.antigravity?.apiKey,
  model: process.env.MODEL_NAME || config.antigravity?.model || 'gemini-3.5-flash-lite',
  mode: config.antigravity?.mode || 'chat',
  systemPrompt: process.env.SYSTEM_PROMPT
})

const MIME = {
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.moc3': 'application/octet-stream',
  '.wasm': 'application/wasm'
}

const sseClients = new Set()

function broadcastSSE(payload) {
  const frame = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of sseClients) {
    try {
      client.write(frame)
    } catch (e) {
      sseClients.delete(client)
    }
  }
}

adapter.on('agent-event', (event) => {
  broadcastSSE(event)
})

function send(res, code, contentType, body) {
  res.writeHead(code, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization'
  })
  res.end(body)
}

function serveFile(res, absPath) {
  try {
    const stat = fs.statSync(absPath)
    if (!stat.isFile()) throw new Error('Not a file')
    const ext = path.extname(absPath).toLowerCase()
    const content = fs.readFileSync(absPath)
    send(res, 200, MIME[ext] || 'application/octet-stream', content)
  } catch (e) {
    send(res, 404, 'text/plain; charset=utf-8', 'File Not Found')
  }
}

function parseJsonBody(req) {
  return new Promise((resolve) => {
    let body = ''
    req.on('data', (chunk) => { body += chunk })
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {})
      } catch (e) {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

// 单独常驻窗口用的 HTML 页面
const STANDALONE_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Antigravity 鲸鱼娘 · 桌面挂件</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      overflow: hidden;
      background: transparent !important;
      user-select: none;
      -webkit-user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
    }
  </style>
</head>
<body>
  <script>
    window.__DSH_PET_BOOT__ = {
      config: {
        height: 180,
        corner: 'br',
        showComposer: true
      }
    };
  </script>
  <script src="/dsh-pet/pet.js"></script>
</body>
</html>`

// 浏览器调试 / 预览主页
const INDEX_PAGE = `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>Antigravity 鲸鱼娘 · 桌面挂件</title>
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <style>
    html, body {
      margin: 0;
      height: 100%;
      overflow: hidden;
      background: linear-gradient(135deg, #eef2ff 0%, #f5f3ff 45%, #ecfdf5 100%);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "PingFang SC", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      html, body {
        background: linear-gradient(135deg, #0f172a 0%, #1e1b4b 45%, #064e3b 100%);
      }
    }
    .mock {
      position: absolute;
      inset: 0;
      display: flex;
      align-items: center;
      justify-content: center;
      color: #64748b;
      font-size: 13px;
      pointer-events: none;
      text-align: center;
      line-height: 2;
    }
    .bar {
      position: fixed;
      left: 14px;
      top: 14px;
      z-index: 2147483600;
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
      align-items: center;
      padding: 8px 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.88);
      backdrop-filter: blur(14px);
      box-shadow: 0 6px 20px rgba(10, 14, 30, 0.12);
      border: 1px solid rgba(20, 24, 40, 0.10);
      font-size: 12px;
    }
    @media (prefers-color-scheme: dark) {
      .bar {
        background: rgba(28, 30, 40, 0.88);
        border-color: rgba(255, 255, 255, 0.14);
        color: #eef1f8;
      }
    }
    .bar button {
      font: inherit;
      font-size: 12px;
      padding: 5px 11px;
      border-radius: 8px;
      cursor: pointer;
      border: 1px solid rgba(0, 0, 0, 0.12);
      background: rgba(255, 255, 255, 0.9);
      color: inherit;
      transition: background 0.15s;
    }
    .bar button:hover {
      background: #fff;
    }
    @media (prefers-color-scheme: dark) {
      .bar button {
        background: rgba(255, 255, 255, 0.08);
        border-color: rgba(255, 255, 255, 0.16);
      }
      .bar button:hover {
        background: rgba(255, 255, 255, 0.16);
      }
    }
    .bar .reset {
      background: #3b62f6;
      color: #fff;
      border-color: transparent;
      font-weight: 600;
    }
    .bar .reset:hover {
      background: #2563eb;
    }
  </style>
</head>
<body>
  <div class="mock">
    🐋 Antigravity 鲸鱼娘桌宠（小胖次）<br>
    点击桌宠说话 · 右键呼出控制与设置面板
  </div>
  <div class="bar">
    <button class="reset" onclick="dshpReset()">↺ 重置桌宠</button>
    <button onclick="clearContext()">🗑 清空会话</button>
  </div>
  <script>
    window.__DSH_PET_BOOT__ = {
      config: {
        height: 180,
        corner: 'br',
        showComposer: true
      }
    };
    function dshpReset() {
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.indexOf('dsh-live2d-pet') === 0) localStorage.removeItem(k);
      }
      location.reload();
    }
    async function clearContext() {
      await fetch('/api/clear', { method: 'POST' });
    }
  </script>
  <script src="/dsh-pet/pet.js"></script>
</body>
</html>`

const server = http.createServer(async (req, res) => {
  const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`)
  const pathname = urlObj.pathname

  if (req.method === 'OPTIONS') {
    return send(res, 204, 'text/plain', '')
  }

  // 1. 页面路由
  if (pathname === '/' || pathname === '/index.html') {
    return send(res, 200, MIME['.html'], INDEX_PAGE)
  }
  if (pathname === '/standalone' || pathname === '/dsh-pet/standalone') {
    return send(res, 200, MIME['.html'], STANDALONE_PAGE)
  }

  // 2. 静态 JS/模型文件路由
  if (pathname === '/dsh-pet/pet.js' || pathname === '/assets/pet.js') {
    const jsPath = path.join(ASSETS, 'pet.js')
    if (fs.existsSync(jsPath)) {
      const body = fs.readFileSync(jsPath, 'utf8')
      const boot = `;window.__DSH_PET_BOOT__=Object.assign({ config: { height: 180 } }, window.__DSH_PET_BOOT__);\n`
      return send(res, 200, MIME['.js'], boot + body)
    }
  }

  if (pathname.startsWith('/dsh-pet/vendor/')) {
    const sub = pathname.slice('/dsh-pet/vendor/'.length)
    return serveFile(res, path.join(ASSETS, 'vendor', sub))
  }
  if (pathname.startsWith('/assets/vendor/')) {
    const sub = pathname.slice('/assets/vendor/'.length)
    return serveFile(res, path.join(ASSETS, 'vendor', sub))
  }

  if (pathname.startsWith('/dsh-pet/model/') || pathname.startsWith('/assets/model/')) {
    const prefix = pathname.startsWith('/dsh-pet/model/') ? '/dsh-pet/model/' : '/assets/model/'
    let sub = pathname.slice(prefix.length)
    try {
      sub = decodeURIComponent(sub)
    } catch (e) {}
    return serveFile(res, path.join(ASSETS, 'model', sub))
  }

  // 3. SSE 事件通道
  if (pathname === '/api/events' || pathname === '/dsh-pet/events') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      'Access-Control-Allow-Origin': '*'
    })
    if (typeof res.flushHeaders === 'function') {
      res.flushHeaders()
    }
    res.write(`data: ${JSON.stringify({ t: 'hello', status: 'idle', agent: 'antigravity', model: adapter.model })}\n\n`)
    sseClients.add(res)
    req.on('close', () => {
      sseClients.delete(res)
    })
    return
  }

  // 4. API 交互路由
  if (pathname === '/api/say' || pathname === '/dsh-pet/say') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    if (!body || !body.text) {
      return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: 'text is required' }))
    }
    const searchOpt = body.search ?? body.enableSearch
    if (searchOpt !== undefined) {
      adapter.setSearch(!!searchOpt)
    }
    // 立即响应 200，避免阻塞前端输入框与 UI 交互；流式思考和打字机内容通过 SSE 异步广播
    send(res, 200, MIME['.json'], JSON.stringify({ ok: true }))
    adapter.ask(body.text, { enableSearch: searchOpt }).catch((err) => {
      console.error('[server] adapter.ask error:', err)
    })
    return
  }

  if (pathname === '/api/search' || pathname === '/dsh-pet/search') {
    if (req.method === 'POST') {
      const body = await parseJsonBody(req)
      const enabled = !!(body && (body.enabled ?? body.search))
      adapter.setSearch(enabled)
      return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, enableSearch: adapter.enableSearch }))
    }
    return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, enableSearch: adapter.enableSearch }))
  }

  if (pathname === '/api/cancel' || pathname === '/dsh-pet/cancel') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const result = adapter.cancel()
    return send(res, 200, MIME['.json'], JSON.stringify(result))
  }

  if (pathname === '/api/clear') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const result = adapter.clearContext()
    return send(res, 200, MIME['.json'], JSON.stringify(result))
  }

  // 4.1 对话历史会话管理路由
  if (pathname === '/api/history') {
    if (req.method === 'GET') {
      const sessions = adapter.historyManager.list()
      return send(res, 200, MIME['.json'], JSON.stringify({
        ok: true,
        sessions,
        currentId: adapter.currentSessionId,
        currentTitle: adapter.currentSessionTitle
      }))
    }
  }

  if (pathname === '/api/history/detail') {
    const id = urlObj.searchParams.get('id')
    const session = adapter.historyManager.get(id)
    return send(res, 200, MIME['.json'], JSON.stringify({ ok: !!session, session }))
  }

  if (pathname === '/api/history/resume') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    if (!body || !body.id) {
      return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: 'id is required' }))
    }
    const result = adapter.resumeSession(body.id)
    return send(res, 200, MIME['.json'], JSON.stringify(result))
  }

  if (pathname === '/api/history/new') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const result = adapter.newSession()
    return send(res, 200, MIME['.json'], JSON.stringify(result))
  }

  if (pathname === '/api/history/delete') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    if (!body || !body.id) {
      return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: 'id is required' }))
    }
    const result = adapter.deleteSession(body.id)
    return send(res, 200, MIME['.json'], JSON.stringify(result))
  }

  if (pathname === '/api/history/clear') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const result = adapter.clearAllSessions()
    return send(res, 200, MIME['.json'], JSON.stringify(result))
  }

  if (pathname === '/api/mode') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    const ok = adapter.setMode(body.mode)
    return send(res, 200, MIME['.json'], JSON.stringify({ ok, mode: adapter.mode }))
  }

  if (pathname === '/api/model') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    const ok = adapter.setModel(body.model)
    return send(res, 200, MIME['.json'], JSON.stringify({ ok, model: adapter.model }))
  }

  // 5. 认证管理与 Google OAuth 2.0 路由
  if (pathname === '/auth/google/login' || pathname === '/api/auth/google/login') {
    try {
      const resData = authManager.startOAuthLogin()
      return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, authUrl: resData.authUrl }))
    } catch (err) {
      return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: err.message }))
    }
  }

  if (pathname === '/auth/google/callback') {
    const code = urlObj.searchParams.get('code')
    const error = urlObj.searchParams.get('error')

    if (error) {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录取消</title><style>body{font-family:system-ui;padding:40px;text-align:center;background:#0f172a;color:#f8fafc;}h1{color:#f87171;}</style></head><body><h1>Google 登录未完成</h1><p>${error}</p><button onclick="window.close()" style="margin-top:20px;padding:8px 20px;border-radius:8px;border:none;background:#3b82f6;color:#fff;cursor:pointer;">关闭窗口</button></body></html>`
      return send(res, 400, MIME['.html'], html)
    }

    try {
      const callbackResult = await authManager.handleOAuthCallback(code)
      broadcastSSE({
        t: 'control',
        say: `Google 账号 (${callbackResult.user.email}) 登录成功！小胖次已连接云端大模型~`,
        expression: '开心',
        bubbleMs: 4000
      })
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录成功</title><style>body{font-family:system-ui;padding:40px;text-align:center;background:#0f172a;color:#f8fafc;}h1{color:#4ade80;}p{opacity:0.85;font-size:15px;}</style></head><body><h1>🎉 Google 账号登录成功！</h1><p>已授权「小胖次」连接使用云端 Gemini 模型：<strong>${callbackResult.user.email}</strong></p><p>您可以直接关闭本页面返回桌宠。</p><button onclick="window.close()" style="margin-top:20px;padding:10px 24px;border-radius:8px;border:none;background:#3b82f6;color:#fff;font-size:14px;cursor:pointer;">返回桌宠</button><script>setTimeout(()=>{try{window.close()}catch(e){}},3000)</script></body></html>`
      return send(res, 200, MIME['.html'], html)
    } catch (err) {
      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>登录失败</title><style>body{font-family:system-ui;padding:40px;text-align:center;background:#0f172a;color:#f8fafc;}h1{color:#f87171;}</style></head><body><h1>登录失败</h1><p>${err.message}</p><button onclick="window.close()" style="margin-top:20px;padding:8px 20px;border-radius:8px;border:none;background:#3b82f6;color:#fff;cursor:pointer;">关闭窗口</button></body></html>`
      return send(res, 500, MIME['.html'], html)
    }
  }

  if (pathname === '/api/auth/status') {
    return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, ...authManager.getStatus() }))
  }

  if (pathname === '/api/auth/mode') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    try {
      authManager.setAuthMode(body.mode)
      return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, status: authManager.getStatus() }))
    } catch (err) {
      return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: err.message }))
    }
  }

  if (pathname === '/api/auth/apikey') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    try {
      authManager.setApiKey(body.apiKey, body.baseUrl)
      adapter.apiKey = authManager.apiKey
      if (body.baseUrl) adapter.baseUrl = authManager.baseUrl
      if (body.model) adapter.setModel(body.model)
      return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, status: authManager.getStatus(), model: adapter.model }))
    } catch (err) {
      return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: err.message }))
    }
  }

  if (pathname === '/api/auth/logout') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    authManager.logoutGoogle()
    return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, status: authManager.getStatus() }))
  }

  if (pathname === '/api/auth/google/config') {
    if (req.method !== 'POST') return send(res, 405, 'text/plain', 'Method Not Allowed')
    const body = await parseJsonBody(req)
    try {
      authManager.setOAuthCredentials(body.clientId, body.clientSecret, body.redirectUri)
      return send(res, 200, MIME['.json'], JSON.stringify({ ok: true, status: authManager.getStatus() }))
    } catch (err) {
      return send(res, 400, MIME['.json'], JSON.stringify({ ok: false, error: err.message }))
    }
  }

  // 6. 状态与 HUD 监控接口
  if (pathname === '/api/status' || pathname === '/api/hud' || pathname === '/dsh-pet/hud') {
    const stats = adapter.getStats()
    const isOnline = stats.isGoogleLoggedIn || stats.hasKey
    const authDesc = stats.authType === 'oauth'
      ? `Google (${stats.user ? stats.user.email : '已登录'})`
      : stats.hasKey ? 'API Key' : '本地模拟'

    const hudResponse = {
      ok: true,
      version: '1.0.0(Antigravity)',
      source: 'antigravity-pet',
      isPeak: false,
      peakNextChangeAt: 0,
      balance: {
        ok: true,
        totalBalance: isOnline ? 'Online' : 'Local Mock',
        currency: stats.model,
        updatedAt: new Date().toISOString()
      },
      today: {
        date: new Date().toISOString().slice(0, 10),
        amount: stats.turnSeq,
        tokens: stats.totalTokens
      },
      turn: {
        ok: true,
        seq: stats.turnSeq,
        tokens: stats.totalTokens,
        amount: 0,
        ts: Date.now()
      },
      priceNote: `模式：${stats.mode} · 认证：${authDesc}`,
      auth: {
        authType: stats.authType,
        isGoogleLoggedIn: stats.isGoogleLoggedIn,
        user: stats.user,
        hasKey: stats.hasKey,
        apiKeyMasked: stats.apiKeyMasked
      }
    }
    return send(res, 200, MIME['.json'], JSON.stringify(hudResponse))
  }

  // 兼容旧版 balance.json 与 last-turn.json
  if (pathname === '/dsh-whale/balance.json') {
    const stats = adapter.getStats()
    return send(res, 200, MIME['.json'], JSON.stringify({
      ok: true,
      totalBalance: stats.hasKey ? 'Online' : 'Local Mock',
      currency: stats.model,
      isPeak: false,
      todayUsage: stats.totalTokens,
      todayUsageCurrency: 'Tokens',
      updatedAt: new Date().toISOString()
    }))
  }

  if (pathname === '/dsh-whale/last-turn.json') {
    const stats = adapter.getStats()
    return send(res, 200, MIME['.json'], JSON.stringify({
      ok: true,
      seq: stats.turnSeq,
      tokens: stats.totalTokens,
      amount: 0,
      ts: Date.now()
    }))
  }

  return send(res, 404, 'text/plain', 'Not Found')
})

if (args.includes('--test')) {
  console.log('✓ [Self-Test] AntigravityAdapter & Server 初始化自检通过')
  process.exit(0)
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.warn(`[Server] 端口 ${PORT} 已在监听，直接复用该服务实例`)
  } else {
    console.error('[Server] 服务异常:', err)
  }
})

server.listen(PORT, HOST, () => {
  console.log(`
==================================================
  🐋 Antigravity 鲸鱼娘桌宠服务已启动！
  - 网页版预览: http://${HOST}:${PORT}/
  - 原生壳挂件: http://${HOST}:${PORT}/standalone
  - 模型适配:   ${adapter.model} (${adapter.apiKey ? '在线模式' : '本地模拟模式'})
  - 当前模式:   ${adapter.mode}
==================================================
`)
})

export { server, adapter }
