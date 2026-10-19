// Antigravity 鲸鱼娘桌宠 · 桌面外壳 (Windows / 跨平台 Electron)
// ————————————————————————————————————————————————————————————
// 核心特性：
// 1. 透明、无边框、置顶窗口，运行 Live2D 鲸鱼娘
// 2. 自动启动内置 Antigravity Node.js 服务 (端口 5199)
// 3. 智能点击穿透：压在鲸鱼娘或面板上交互，透明处鼠标事件直接穿透至桌面
// 4. 全局视线追踪、贴边悬浮小球、系统托盘管理

const { app, BrowserWindow, Tray, Menu, screen, shell, session, ipcMain, nativeImage } = require('electron')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

// 优化 Windows 透明窗口渲染稳定性
app.commandLine.appendSwitch('disable-gpu-sandbox')

const CANDIDATE_BASES = [
  'http://127.0.0.1:5199',
  'http://127.0.0.1:3080',
  'http://127.0.0.1:19387'
]
let petBase = CANDIDATE_BASES[0]
let embeddedServer = null

const petURL = () => petBase + '/standalone'
const WIN_W = 560
const WIN_H = 900
const BALL = 62

let win = null
let ballWin = null
let tray = null
let pollTimer = null
let cursorFeed = null
let lastCursor = null
let dragTimer = null
let dragFrom = null
let ballDrag = null
let collapsed = false
let lowPower = false
let overPanel = false
let failCount = 0
let lastHit = 'none'

// ——————————————————————————————————————————————————————————————
// 启动 / 检测内置服务端
// ——————————————————————————————————————————————————————————————
async function waitForServer(port = 5199, timeoutMs = 8000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/standalone`, { signal: AbortSignal.timeout(400) })
      if (res.ok) return true
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 150))
  }
  return false
}

async function startEmbeddedServer() {
  try {
    const res = await fetch('http://127.0.0.1:5199/api/status', { signal: AbortSignal.timeout(600) })
    if (res.ok) {
      console.log('[Desktop] 检测到已在运行的 Antigravity 服务 (5199)')
      return true
    }
  } catch (e) {}

  const serverPath = fs.existsSync(path.join(__dirname, 'lib', 'server.js'))
    ? path.join(__dirname, 'lib', 'server.js')
    : path.resolve(__dirname, '../../lib/server.js')

  if (!fs.existsSync(serverPath)) {
    console.warn('[Desktop] 未找到内置 server.js 路径:', serverPath)
    return false
  }

  // 确保 lib/package.json 存在以支持 ES Module 语法
  const libDir = path.dirname(serverPath)
  const libPkgPath = path.join(libDir, 'package.json')
  if (!fs.existsSync(libPkgPath)) {
    try {
      fs.writeFileSync(libPkgPath, JSON.stringify({ type: 'module' }, null, 2))
    } catch (e) {
      console.warn('[Desktop] 写入 lib/package.json 提示:', e.message)
    }
  }

  console.log('[Desktop] 启动内置 Antigravity 桌宠服务:', serverPath)
  try {
    const url = require('node:url').pathToFileURL(serverPath).href
    const mod = await import(url)
    embeddedServer = mod.server
    console.log('[Desktop] 内置服务启动就绪！')
    return true
  } catch (err) {
    console.error('[Desktop] 启动内置服务异常:', err)
    return false
  }
}

// ——————————————————————————————————————————————————————————————
// 判断「鼠标下面是什么」：她本体 / 她的面板 / 空白
// ——————————————————————————————————————————————————————————————
const hitJS = (x, y) => `(function(){try{
  var el=document.elementFromPoint(${x},${y});
  var ui=!!(el&&el.closest&&el.closest('.dshp-panel,.dshp-menu,.dshp-hud,.dshp-bubble,.dshp-composer,.dshp-dock,.dshp-tab,.dshp-wrap'));
  if(ui) return 'panel';
  if(window.DSHPet&&DSHPet.hitTest&&DSHPet.hitTest(${x},${y})) return 'model';
  return 'none';
}catch(e){return 'none'}})()`

function setIgnore(on) {
  if (!win || win.isDestroyed()) return
  if (on) {
    win.setIgnoreMouseEvents(true, { forward: true })
  } else {
    // 关键：取消穿透时严禁带 { forward: true }，否则 Windows 上无法响应点击
    win.setIgnoreMouseEvents(false)
  }
}

async function poll() {
  if (!win || win.isDestroyed() || !win.isVisible()) return
  const p = screen.getCursorScreenPoint()
  const b = win.getBounds()
  if (p.x < b.x || p.x > b.x + b.width || p.y < b.y || p.y > b.y + b.height) {
    lastHit = 'none'
    setIgnore(true)
    return
  }
  if (dragTimer) return
  try {
    const kind = await win.webContents.executeJavaScript(hitJS(Math.round(p.x - b.x), Math.round(p.y - b.y)))
    lastHit = kind
    overPanel = kind === 'panel'
    setIgnore(kind === 'none')
  } catch (e) {
    setIgnore(true)
  }
}

// ——————————————————————————————————————————————————————————————
// 主窗口
// ——————————————————————————————————————————————————————————————
function createMain() {
  win = new BrowserWindow({
    width: WIN_W,
    height: WIN_H,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    title: 'Antigravity 鲸鱼娘桌宠',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false
    }
  })
  win.setAlwaysOnTop(true, 'screen-saver')
  win.setIgnoreMouseEvents(true, { forward: true })
  win.setMenuBarVisibility(false)

  const wa = screen.getPrimaryDisplay().workArea
  const saved = readPos()
  win.setPosition(saved ? saved[0] : wa.x + wa.width - WIN_W - 16, saved ? saved[1] : wa.y + wa.height - WIN_H - 16)

  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  // 转发渲染进程 console 日志，方便调试
  win.webContents.on('console-message', (_e, _level, msg) => {
    console.log('[WebConsole]', msg)
  })

  win.webContents.on('did-finish-load', () => {
    failCount = 0
    if (!win.isVisible()) {
      win.showInactive()
      win.setAlwaysOnTop(true, 'screen-saver')
    }
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})
    setTimeout(() => win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {}), 1000)
    setTimeout(() => win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {}), 2500)
  })

  win.webContents.on('did-fail-load', (_e, errorCode, errorDescription) => {
    console.warn('[Desktop] 页面加载失败:', errorCode, errorDescription)
    failCount++
    if (failCount >= 3) showHint()
    setTimeout(load, 3000)
  })

  win.on('moved', () => {
    if (!win || win.isDestroyed()) return
    const [x, y] = win.getPosition()
    const [cx, cy] = clampToDisplays(x, y)
    if (cx !== x || cy !== y) win.setPosition(cx, cy)
    const now = Date.now()
    if (now - (globalThis.__lastSaveAt || 0) > 400) {
      globalThis.__lastSaveAt = now
      savePos()
    }
  })

  win.on('closed', () => { win = null })

  // 拖动处理
  ipcMain.on('drag-start', async (_e, at) => {
    if (!win || win.isDestroyed() || !win.isVisible()) return
    try {
      const b = win.getBounds()
      const kind = await win.webContents.executeJavaScript(
        hitJS(Math.round(at.x - b.x), Math.round(at.y - b.y))
      )
      if (kind === 'panel') return
    } catch (e) {}
    dragFrom = { mouse: at, win: win.getPosition() }
    clearInterval(dragTimer)
    dragTimer = setInterval(() => {
      if (!dragFrom || !win) return
      const p = screen.getCursorScreenPoint()
      win.setPosition(dragFrom.win[0] + (p.x - dragFrom.mouse.x), dragFrom.win[1] + (p.y - dragFrom.mouse.y))
    }, 16)
    win.webContents.executeJavaScript("document.dispatchEvent(new PointerEvent('pointercancel',{bubbles:true}))").catch(() => {})
  })

  ipcMain.on('drag-end', () => {
    clearInterval(dragTimer)
    dragTimer = null
    dragFrom = null
    savePos()
  })

  ipcMain.on('shell-msg', (_e, msg) => {
    switch (msg) {
      case 'hidden':
      case 'collapse':
        if (!collapsed) collapse()
        break
      case 'shown':
      case 'expand':
        if (collapsed) expand()
        break
      case 'open-dsh':
        shell.openExternal(petBase + '/')
        break
      case 'quit':
        app.quit()
        break
    }
  })

  load()

  // 全屏视线追踪 (60Hz)
  cursorFeed = setInterval(() => {
    try {
      if (!win || win.isDestroyed() || !win.isVisible() || dragTimer) return
      const p = screen.getCursorScreenPoint()
      if (lastCursor && Math.abs(lastCursor.x - p.x) < 1 && Math.abs(lastCursor.y - p.y) < 1) return
      lastCursor = p
      const b = win.getBounds()
      const disp = screen.getDisplayNearestPoint(p).bounds
      const nx = (p.x - disp.x) / Math.max(1, disp.width)
      const ny = (p.y - disp.y) / Math.max(1, disp.height)
      win.webContents.sendInputEvent({
        type: 'mouseMove',
        x: Math.round(nx * b.width),
        y: Math.round(ny * b.height)
      })
    } catch (e) {}
  }, 16)

  pollTimer = setInterval(poll, 90)

  win.once('ready-to-show', () => {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
  })
}

async function load() {
  if (!win || win.isDestroyed()) return
  await startEmbeddedServer()
  const ok = await waitForServer(5199, 8000)
  if (!ok) {
    console.warn('[Desktop] 服务未在预期时间内就绪，显示等待提示')
    showHint()
    return
  }
  petBase = 'http://127.0.0.1:5199'
  console.log('[Desktop] 正在加载桌宠主页:', petURL())
  win.loadURL(petURL())
}

function readPos() {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'pos.json'), 'utf8'))
    if (Array.isArray(j) && j.length === 2 && Number.isFinite(j[0])) return j
  } catch (e) {}
  return null
}

function clampToDisplays(x, y) {
  try {
    const areas = screen.getAllDisplays().map((d) => d.workArea)
    const w = 200, h = 120
    const inside = areas.some((a) => x + w > a.x && x < a.x + a.width && y + h > a.y && y < a.y + a.height)
    if (inside) return [x, y]
    const p = screen.getPrimaryDisplay().workArea
    return [p.x + p.width - WIN_W, p.y + p.height - 300]
  } catch (e) {
    return [x, y]
  }
}

function savePos() {
  if (!win || win.isDestroyed()) return
  const [x, y] = win.getPosition()
  const dir = app.getPath('userData')
  try {
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'pos.json'), JSON.stringify([x, y]))
  } catch (e) {}
}

function showHint() {
  if (!win || win.isDestroyed()) return
  const html = `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent}
  body{display:flex;align-items:center;justify-content:center;font:13px/1.7 "Microsoft YaHei",-apple-system,sans-serif;color:#fff;text-align:center}
  .box{background:rgba(18,22,34,.92);border:1px solid rgba(255,255,255,.2);border-radius:14px;padding:20px 24px;max-width:85%}
  .t{font-weight:600;margin-bottom:8px;font-size:16px}
  .s{opacity:.8;font-size:13px;margin-bottom:14px}
  button{font:inherit;padding:8px 16px;border-radius:10px;border:1px solid rgba(255,255,255,.25);
    background:linear-gradient(135deg,#3b82f6,#2563eb);color:#fff;cursor:pointer;margin:0 4px}
  code{background:rgba(127,150,255,.2);padding:2px 6px;border-radius:6px}
  </style><body><div class="box">
  <div class="t">🐋 正在连接 Antigravity 桌宠服务…</div>
  <div class="s">端口 <code>5199</code> 正在初始化中，请稍候。</div>
  <button onclick="window.dshpet.reload()">立即重试连接</button>
  </div>
  <script>
    window.dshpet = {
      reload: () => window.dshpetBridge && window.dshpetBridge.reload()
    }
  </script></body>`
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
}

// ——————————————————————————————————————————————————————————————
// 贴边小球（收起态）
// ——————————————————————————————————————————————————————————————
function ballHTML() {
  const icon = `<svg viewBox="0 0 24 24"><path fill="#fff" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 14.5c-2.49 0-4.5-2.01-4.5-4.5S8.51 7.5 11 7.5s4.5 2.01 4.5 4.5-2.01 4.5-4.5 4.5z"/></svg>`
  return `<!doctype html><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:transparent;overflow:hidden;user-select:none;-webkit-app-region:no-drag}
  .ball{width:100%;height:100%;border-radius:50%;box-sizing:border-box;display:flex;align-items:center;justify-content:center;
    background:radial-gradient(120% 120% at 50% 0%, rgba(60,70,96,.98), rgba(16,20,32,.98));
    border:1.5px solid rgba(255,255,255,.34);box-shadow:0 6px 18px rgba(0,0,0,.38);cursor:pointer}
  .ball:hover{border-color:rgba(255,255,255,.6);transform:scale(1.06)}
  svg{width:56%;height:56%}
  </style><body><div class="ball">${icon}</div></body>`
}

function createBall() {
  ballWin = new BrowserWindow({
    width: BALL,
    height: BALL,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    alwaysOnTop: true,
    webPreferences: { contextIsolation: true, preload: path.join(__dirname, 'preload.js') }
  })
  ballWin.setAlwaysOnTop(true, 'screen-saver')
  ballWin.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(ballHTML()))
  ballWin.webContents.on('did-finish-load', () => {
    ballWin.webContents.executeJavaScript(`
      (function(){
        var d=false, moved=0, sx=0, sy=0;
        document.addEventListener('mousedown', function(e){ d=true; moved=0; sx=e.screenX; sy=e.screenY; e.preventDefault() });
        document.addEventListener('mousemove', function(e){ if(!d) return; moved=Math.max(moved, Math.abs(e.screenX-sx)+Math.abs(e.screenY-sy));
          if(moved>3) window.dshpetBridge && window.dshpetBridge.ballMove(e.screenX-sx, e.screenY-sy) });
        document.addEventListener('mouseup', function(){ if(!d) return; d=false;
          window.dshpetBridge && window.dshpetBridge.ballDrop(moved>3) });
      })()
    `).catch(() => {})
  })
  ipcMain.on('ball-move', (_e, dx, dy) => {
    if (!ballWin || !ballDrag) return
    ballWin.setPosition(Math.round(ballDrag[0] + dx), Math.round(ballDrag[1] + dy))
  })
  ipcMain.on('ball-drop', (_e, moved) => {
    if (!ballWin) return
    if (!moved) return expand()
    snapBall()
  })
}

function snapBall() {
  if (!ballWin) return
  const wa = screen.getPrimaryDisplay().workArea
  const [x, y] = ballWin.getPosition()
  const nearest = x + BALL / 2 < wa.x + wa.width / 2 ? wa.x + 4 : wa.x + wa.width - BALL - 4
  const ny = Math.min(Math.max(y, wa.y + 4), wa.y + wa.height - BALL - 4)
  ballWin.setPosition(nearest, ny)
}

function collapse() {
  if (!win || collapsed) return
  collapsed = true
  savePos()
  const [wx, wy] = win.getPosition()
  const wa = screen.getPrimaryDisplay().workArea
  const onLeft = wx + WIN_W / 2 < wa.x + wa.width / 2
  if (!ballWin) createBall()
  ballWin.setPosition(onLeft ? wa.x + 4 : wa.x + wa.width - BALL - 4, Math.round(wy + WIN_H / 2 - BALL / 2))
  ballWin.showInactive()
  ballWin.setAlwaysOnTop(true, 'screen-saver')
  win.hide()
  ballDrag = [ballWin.getPosition()[0], ballWin.getPosition()[1]]
  setTimeout(snapBall, 30)
}

function expand() {
  if (!collapsed) return
  collapsed = false
  if (ballWin) {
    ballDrag = null
    ballWin.hide()
  }
  if (win) {
    win.showInactive()
    win.setAlwaysOnTop(true, 'screen-saver')
    win.webContents.executeJavaScript('window.DSHPet && DSHPet.setHidden && DSHPet.setHidden(false)').catch(() => {})
  }
}

// ——————————————————————————————————————————————————————————————
// 托盘菜单
// ——————————————————————————————————————————————————————————————
function createTray() {
  const iconPath = path.join(__dirname, 'build', 'icon.png')
  let img = nativeImage.createFromPath(iconPath)
  if (!img.isEmpty()) img = img.resize({ width: 16, height: 16 })
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img)
  tray.setToolTip('Antigravity 鲸鱼娘桌宠')
  const rebuild = () =>
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '重新加载', click: load },
        { label: collapsed ? '展开桌宠' : '收起成小球（贴边）', click: () => (collapsed ? expand() : collapse()) },
        { label: '回到右下角', click: resetPos },
        { type: 'separator' },
        {
          label: '低性能模式（少动、省电）',
          type: 'checkbox',
          checked: lowPower,
          click: (mi) => {
            lowPower = mi.checked
            if (win) win.webContents.executeJavaScript('window.DSHPet && DSHPet.setLowPower && DSHPet.setLowPower(' + lowPower + ')').catch(() => {})
          }
        },
        { label: '打开网页版预览 (5199)', click: () => shell.openExternal('http://127.0.0.1:5199/') },
        { type: 'separator' },
        { label: '彻底退出', click: () => app.quit() }
      ])
    )
  tray.on('click', () => (collapsed ? expand() : win && win.showInactive()))
  setInterval(rebuild, 2000)
  rebuild()
}

function resetPos() {
  if (!win) return
  const wa = screen.getPrimaryDisplay().workArea
  win.setPosition(wa.x + wa.width - WIN_W - 16, wa.y + wa.height - WIN_H - 16)
  savePos()
}

// ——————————————————————————————————————————————————————————————
app.whenReady().then(() => {
  app.setAppUserModelId('com.google.antigravity.whalegirlpet')
  createMain()
  createTray()
  ipcMain.on('reload', load)
})

app.on('window-all-closed', () => app.quit())
app.on('before-quit', () => {
  clearInterval(pollTimer)
  clearInterval(dragTimer)
  if (embeddedServer && typeof embeddedServer.close === 'function') {
    embeddedServer.close()
  }
})
