/**
 * lib/history.js —— 对话历史会话管理模块
 *
 * 核心功能：
 * 1. 本地文件持久化存储会话历史（.history.json）
 * 2. 支持多会话列表展示、查看详情、新建会话
 * 3. 支持恢复/继续上一次对话（加载历史多轮上下文）
 * 4. 支持手动删除指定会话及一键清空全部历史
 */

import fs from 'node:fs'
import path from 'node:path'

export class HistoryManager {
  constructor(options = {}) {
    this.filePath = options.filePath || path.join(process.cwd(), '.history.json')
    this.sessions = []
    this.load()
  }

  /** 从本地磁盘读取持久化会话历史 */
  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const raw = fs.readFileSync(this.filePath, 'utf8')
        const data = JSON.parse(raw)
        if (Array.isArray(data)) {
          this.sessions = data
        } else if (data && Array.isArray(data.sessions)) {
          this.sessions = data.sessions
        }
      }
    } catch (e) {
      console.warn('[HistoryManager] 读取历史记录失败，使用空记录:', e.message)
      this.sessions = []
    }
  }

  /** 保存所有会话至本地磁盘 */
  save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.sessions, null, 2), { mode: 0o600 })
    } catch (e) {
      console.error('[HistoryManager] 保存历史记录失败:', e.message)
    }
  }

  /** 获取按最近更新时间排序的会话简要列表 */
  list() {
    return this.sessions
      .slice()
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0))
      .map((s) => {
        const nonSystemMsgs = (s.messages || []).filter((m) => m.role !== 'system')
        const userMsgs = (s.messages || []).filter((m) => m.role === 'user')
        const lastMsg = nonSystemMsgs.slice(-1)[0]
        return {
          id: s.id,
          title: s.title || (userMsgs[0] ? String(userMsgs[0].content).slice(0, 30) : '未命名对话'),
          createdAt: s.createdAt,
          updatedAt: s.updatedAt,
          mode: s.mode || 'chat',
          model: s.model || 'gemini-3.5-flash-lite',
          messageCount: nonSystemMsgs.length,
          lastSnippet: lastMsg ? String(lastMsg.content || '').slice(0, 60) : ''
        }
      })
  }

  /** 获取单个完整会话详情（包含全部消息） */
  get(id) {
    return this.sessions.find((s) => s.id === id) || null
  }

  /** 获取最近一次更新的完整会话（用于默认自动继续上一轮对话） */
  getLatest() {
    const list = this.list()
    if (!list || list.length === 0) return null
    return this.get(list[0].id)
  }

  /** 保存或更新会话（支持传入对象或 (id, title, messages) 参数） */
  saveSession(sessionDataOrId, maybeTitle, maybeMessages, options = {}) {
    let sessionData = {}
    if (typeof sessionDataOrId === 'string') {
      sessionData = {
        id: sessionDataOrId,
        title: maybeTitle,
        messages: maybeMessages,
        ...options
      }
    } else if (sessionDataOrId && typeof sessionDataOrId === 'object') {
      sessionData = sessionDataOrId
    }
    if (!sessionData || !sessionData.id) return null
    const idx = this.sessions.findIndex((s) => s.id === sessionData.id)
    const now = new Date().toISOString()

    // 智能提取标题：若标题为空或新对话，则使用首条用户发言截取
    let title = sessionData.title
    const userMsgs = (sessionData.messages || []).filter((m) => m.role === 'user')
    if ((!title || title === '新对话' || title === '未命名对话') && userMsgs.length > 0) {
      const firstText = String(userMsgs[0].content || '').trim()
      if (firstText) {
        title = firstText.length > 28 ? firstText.slice(0, 28) + '…' : firstText
      }
    }

    const updated = {
      id: sessionData.id,
      title: title || '未命名对话',
      createdAt: sessionData.createdAt || now,
      updatedAt: now,
      mode: sessionData.mode || 'chat',
      model: sessionData.model || 'gemini-3.5-flash-lite',
      messages: sessionData.messages ? JSON.parse(JSON.stringify(sessionData.messages)) : []
    }

    if (idx >= 0) {
      updated.createdAt = this.sessions[idx].createdAt || updated.createdAt
      this.sessions[idx] = updated
    } else {
      this.sessions.unshift(updated)
    }

    this.save()
    return updated
  }

  /** 删除单个指定会话 */
  delete(id) {
    const before = this.sessions.length
    this.sessions = this.sessions.filter((s) => s.id !== id)
    if (this.sessions.length !== before) {
      this.save()
      return true
    }
    return false
  }

  /** 清空全部会话记录 */
  clear() {
    this.sessions = []
    this.save()
    return true
  }
}

export const historyManager = new HistoryManager()
