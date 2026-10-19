// 预加载脚本：给网页搭一座桥，让 Windows 版和 macOS 版用同一套前端协议。
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('__DSHPET_SHELL__', true)
contextBridge.exposeInMainWorld('webkit', {
  messageHandlers: {
    dshpetshell: {
      postMessage: (msg) => ipcRenderer.send('shell-msg', String(msg)),
    },
  },
})
// 提示页用的桥（DSH 没起来时那张卡片上的两个按钮）
contextBridge.exposeInMainWorld('dshpetBridge', {
  install: () => ipcRenderer.send('install-plugin'),
  reload: () => ipcRenderer.send('reload'),
  ballMove: (dx, dy) => ipcRenderer.send('ball-move', dx, dy),
  ballDrop: (moved) => ipcRenderer.send('ball-drop', moved),
})

// 拖动处理：
// 1. 点在输入框、按钮或面板控件内不触发窗口拖动；
// 2. 超过 4px 阈值才视为拖动窗口（普通点击仍可正常摸头/交互）；
// 3. 锁定 pointer capture，防止高速拖动时鼠标移出窗口导致丢帧和抽搐。
let dragSession = null

window.addEventListener(
  'pointerdown',
  (e) => {
    if (e.button !== 0) return
    const target = e.target
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable)
    ) {
      return
    }
    const isPanel = !!(
      target &&
      target.closest &&
      target.closest(
        '.dshp-panel, .dshp-menu, .dshp-hud, .dshp-composer, .dshp-dock, .dshp-tab, input, button, textarea'
      )
    )
    if (isPanel) return

    dragSession = {
      startX: Math.round(Number(e.screenX) || 0),
      startY: Math.round(Number(e.screenY) || 0),
      pointerId: e.pointerId,
      target: target,
      started: false,
    }
  },
  true
)

window.addEventListener(
  'pointermove',
  (e) => {
    if (!dragSession) return
    const curX = Math.round(Number(e.screenX) || 0)
    const curY = Math.round(Number(e.screenY) || 0)
    const dx = curX - dragSession.startX
    const dy = curY - dragSession.startY
    if (!dragSession.started && Math.abs(dx) + Math.abs(dy) > 4) {
      dragSession.started = true
      try {
        if (dragSession.target && dragSession.target.setPointerCapture) {
          dragSession.target.setPointerCapture(dragSession.pointerId)
        }
      } catch (_) {}
      ipcRenderer.send('drag-start', { x: dragSession.startX, y: dragSession.startY })
    }
  },
  true
)

const endDrag = () => {
  if (dragSession) {
    if (dragSession.started) {
      ipcRenderer.send('drag-end')
    }
    try {
      if (dragSession.target && dragSession.target.releasePointerCapture) {
        dragSession.target.releasePointerCapture(dragSession.pointerId)
      }
    } catch (_) {}
    dragSession = null
  }
}

window.addEventListener('pointerup', endDrag, true)
window.addEventListener('pointercancel', endDrag, true)
