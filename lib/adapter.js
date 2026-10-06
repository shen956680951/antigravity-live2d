/**
 * lib/adapter.js —— Antigravity 通信适配层 (Adapter)
 *
 * 核心职责：
 * 1. 管理 Antigravity / Gemini / OpenAI 兼容接口的通信与流式传输
 * 2. 维护多轮对话上下文历史（支持一键清空会话与模式切换）
 * 3. 将流式返回与思考状态转化为 Live2D 标准事件（turn-start, delta, tool-call, turn-end 等）
 * 4. 支持任务打断（AbortController）与 Token 消耗统计
 * 5. 在无 API Key 时提供高质量的本地模拟交互，确保开箱即用体验
 */

import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { authManager } from './auth.js'
import { historyManager } from './history.js'

export const AVAILABLE_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.8-flash',
  'gemini-3.1-pro-preview'
]

export function normalizeModelName(model) {
  if (!model) return 'gemini-3.5-flash-lite'
  const raw = String(model).trim()
  const lower = raw.toLowerCase()
  if (lower === 'gemini-3.1-pro-preview' || lower.includes('gemini-3.1') || lower === 'gemini-pro') {
    return 'gemini-3.1-pro-preview'
  }
  if (lower === 'gemini-3.8-flash' || lower.includes('gemini-3.8')) {
    return 'gemini-3.8-flash'
  }
  if (lower === 'gemini-3.5-flash-lite' || lower.includes('gemini-3.5') || lower.includes('flash-lite')) {
    return 'gemini-3.5-flash-lite'
  }
  // 用户指定任意自定义/第三方模型（如 deepseek-chat, deepseek-reasoner, gpt-4o, claude-3-5 等）保留原名
  return raw
}

export function getFallbackCandidates(model) {
  const norm = normalizeModelName(model)
  if (norm === 'gemini-3.1-pro-preview') {
    return ['gemini-3.1-pro-preview', 'gemini-3.8-flash', 'gemini-3.5-flash-lite']
  }
  if (norm === 'gemini-3.8-flash') {
    return ['gemini-3.8-flash', 'gemini-3.5-flash-lite']
  }
  if (norm === 'gemini-3.5-flash-lite') {
    return ['gemini-3.5-flash-lite', 'gemini-3.8-flash']
  }
  // 第三方模型不自动降级到 Google 模型，保持原样
  return [norm]
}

export function detectApiFormat(baseUrl, model) {
  const url = (baseUrl || '').trim().toLowerCase()
  const mod = (model || '').trim().toLowerCase()

  // 1. 如果明确指定为 DeepSeek / OpenAI 官方
  if (url.includes('api.deepseek.com') || url.includes('api.openai.com')) {
    return 'openai'
  }
  // 2. 如果包含标准 OpenAI 路径标识 (/openai, /v1, /chat/completions)
  if (url.includes('/openai') || url.endsWith('/v1') || url.includes('/v1/') || url.includes('/chat/completions')) {
    return 'openai'
  }
  // 3. 如果是 Google 官方原生端点（且不带 /openai）
  if (url.includes('generativelanguage.googleapis.com')) {
    return 'gemini'
  }
  // 4. 如果使用默认或空 BaseURL，根据模型前缀推断
  if (!url || url.includes('generativelanguage')) {
    if (mod.startsWith('deepseek') || mod.startsWith('gpt-') || mod.startsWith('o1') || mod.startsWith('claude') || mod.startsWith('qwen')) {
      return 'openai'
    }
    return 'gemini'
  }
  // 5. 其它所有自定义 BaseURL 均采用 OpenAI 兼容协议
  return 'openai'
}

export class AntigravityAdapter extends EventEmitter {
  constructor(options = {}) {
    super()

    this.options = options
    this.authManager = authManager
    this.historyManager = historyManager
    this.baseUrl = (options.baseUrl || authManager.baseUrl || process.env.ANTIGRAVITY_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/+$/, '')
    this.apiKey = options.apiKey || authManager.apiKey || process.env.ANTIGRAVITY_API_KEY || process.env.GEMINI_API_KEY || ''
    this.model = options.model || process.env.MODEL_NAME || 'gemini-3.5-flash-lite'
    this.mode = options.mode || 'chat' // 'chat' | 'coder' | 'agent'
    this.systemPrompt = options.systemPrompt || process.env.SYSTEM_PROMPT || 
      '你是鲸鱼娘「小胖次」，一只常驻在主人桌面的可爱Live2D鲸鱼少女助手。你的自称是「小胖次」，在所有对话和回复中，请务必始终自称「小胖次」，切勿使用其他自称。你的性格活泼亲切、呆萌可爱、做事认真，喜欢用温和贴心的语气协助主人工作、编码和答疑。回答请保持简练优雅，适合在桌面悬浮气泡中阅读。'

    this.messages = []
    this.turnSeq = 0
    this.totalTokens = 0
    this.currentAbort = null
    this.activeTask = false
    this.currentSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
    this.currentSessionTitle = '新对话'
    this.enableSearch = options.enableSearch ?? false

    this.initSystemPrompt()
    // 默认继续上一次对话（若本地存在历史会话记录）
    this.restoreLatestSession()
  }

  restoreLatestSession() {
    try {
      const latest = this.historyManager.getLatest()
      if (latest && Array.isArray(latest.messages) && latest.messages.some(m => m.role === 'user')) {
        this.currentSessionId = latest.id
        this.currentSessionTitle = latest.title || '历史会话'
        if (latest.mode) this.mode = latest.mode
        if (latest.model) this.model = latest.model
        const nonSystem = latest.messages.filter(m => m.role !== 'system')
        this.initSystemPrompt()
        this.messages.push(...nonSystem)
        console.log(`[AntigravityAdapter] 默认恢复上一次对话: [${latest.id}] "${this.currentSessionTitle}" (${nonSystem.length} 条发言)`)
        return true
      }
    } catch (err) {
      console.warn('[AntigravityAdapter] 自动恢复上一次对话失败:', err.message)
    }
    return false
  }

  initSystemPrompt() {
    let prompt = this.systemPrompt
    if (!prompt.includes('小胖次')) {
      prompt = '你是鲸鱼娘「小胖次」，一只常驻在主人桌面的可爱Live2D鲸鱼少女助手。你的自称是「小胖次」，在回复主人时必须一律自称「小胖次」，切勿使用其他自称。'
    }
    prompt += '\n重要要求：请在回复中务必使用自称「小胖次」，例如“小胖次觉得…”、“小胖次这就为您…”等，保持可爱活泼的桌面助手口吻。'
    if (this.mode === 'coder') {
      prompt += '\n当前模式：编码专家。请重点关注代码质量、架构设计与调试，提供高水准的技术建议。'
    } else if (this.mode === 'agent') {
      prompt += '\n当前模式：自主规划 Agent。请条理清晰地规划步骤并调用工具完成任务。'
    }
    this.messages = [{ role: 'system', content: prompt }]
  }

  setMode(mode) {
    if (['chat', 'coder', 'agent'].includes(mode)) {
      this.mode = mode
      this.initSystemPrompt()
      this.emitEvent({
        t: 'control',
        say: `已切换至【${mode === 'coder' ? '编码专家' : mode === 'agent' ? '智能体 Agent' : '陪伴闲聊'}】模式！`,
        bubbleMs: 3000
      })
      return true
    }
    return false
  }

  setModel(model) {
    if (typeof model === 'string' && model.trim()) {
      this.model = normalizeModelName(model.trim())
      this.emitEvent({
        t: 'control',
        say: `已切换至【${this.model}】模型！`,
        bubbleMs: 3000,
        expression: '开心'
      })
      return true
    }
    return false
  }

  setSearch(enabled) {
    this.enableSearch = !!enabled
    return this.enableSearch
  }

  clearContext() {
    return this.newSession()
  }

  saveCurrentSession() {
    return this.historyManager.saveSession({
      id: this.currentSessionId,
      title: this.currentSessionTitle,
      mode: this.mode,
      model: this.model,
      messages: this.messages
    })
  }

  resumeSession(id) {
    const session = this.historyManager.get(id)
    if (!session) return { ok: false, error: '会话不存在或已删除' }
    this.currentSessionId = session.id
    this.currentSessionTitle = session.title || '历史会话'
    if (session.mode) this.mode = session.mode
    if (session.model) this.model = session.model
    const rawMsgs = Array.isArray(session.messages) ? JSON.parse(JSON.stringify(session.messages)) : []
    const nonSystem = rawMsgs.filter(m => m.role !== 'system')
    this.initSystemPrompt()
    this.messages.push(...nonSystem)
    this.emitEvent({
      t: 'control',
      say: `已继续上一次对话【${this.currentSessionTitle}】~`,
      bubbleMs: 3000,
      expression: '开心'
    })
    return { ok: true, session }
  }

  newSession() {
    this.currentSessionId = 'session_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7)
    this.currentSessionTitle = '新对话'
    this.initSystemPrompt()
    this.emitEvent({
      t: 'control',
      say: '上下文已重置，开启新对话啦~',
      bubbleMs: 2600,
      expression: '开心'
    })
    return { ok: true, sessionId: this.currentSessionId }
  }

  deleteSession(id) {
    const ok = this.historyManager.delete(id)
    if (this.currentSessionId === id) {
      this.newSession()
    }
    return { ok }
  }

  clearAllSessions() {
    this.historyManager.clear()
    this.newSession()
    return { ok: true }
  }

  getStats() {
    const authStatus = this.authManager.getStatus()
    return {
      ok: true,
      model: this.model,
      mode: this.mode,
      baseUrl: authStatus.baseUrl || this.baseUrl,
      authType: authStatus.authType,
      isGoogleLoggedIn: authStatus.isGoogleLoggedIn,
      user: authStatus.user,
      hasKey: authStatus.hasApiKey || !!this.apiKey,
      apiKeyMasked: authStatus.apiKeyMasked,
      historyLength: Math.max(0, this.messages.length - 1),
      currentSessionId: this.currentSessionId,
      currentSessionTitle: this.currentSessionTitle,
      turnSeq: this.turnSeq,
      totalTokens: this.totalTokens,
      enableSearch: this.enableSearch,
      active: this.activeTask
    }
  }

  async getAuthorizationHeader() {
    try {
      const header = await this.authManager.getAuthorizationHeader()
      if (header) return header
    } catch (e) {
      console.warn('[AntigravityAdapter] authManager 获取 Authorization 失败:', e.message)
    }
    if (this.apiKey) return `Bearer ${this.apiKey}`
    return null
  }

  emitEvent(payload) {
    this.emit('agent-event', payload)
  }

  cancel() {
    if (this.currentAbort) {
      this.currentAbort.abort()
      this.currentAbort = null
      this.activeTask = false
      this.emitEvent({
        t: 'turn-end',
        reason: 'aborted',
        ms: 0
      })
      return { ok: true, message: 'Task cancelled' }
    }
    return { ok: false, error: 'No active task to cancel' }
  }

  async ask(userText, options = {}) {
    if (this.activeTask) {
      this.cancel()
    }

    const text = String(userText || '').trim()
    if (!text) return { ok: false, error: 'Empty text' }

    const enableSearch = options.enableSearch !== undefined
      ? !!options.enableSearch
      : (options.search !== undefined ? !!options.search : this.enableSearch)

    this.turnSeq++
    const currentTurn = this.turnSeq
    const startTime = Date.now()
    this.activeTask = true

    // 1. 发送用户消息事件
    this.emitEvent({ t: 'user', text })
    this.messages.push({ role: 'user', content: text })
    if (!this.currentSessionTitle || this.currentSessionTitle === '新对话') {
      this.currentSessionTitle = text.length > 28 ? text.slice(0, 28) + '…' : text
    }

    // 2. 发出 turn-start 与 step-start
    this.emitEvent({ t: 'turn-start', turn: currentTurn })
    this.emitEvent({ t: 'step-start', step: 1 })

    this.currentAbort = new AbortController()

    try {
      const effectiveApiKey = this.getEffectiveApiKey()
      const authHeader = await this.getAuthorizationHeader()
      if (authHeader || effectiveApiKey) {
        try {
          await this.streamFromApi(currentTurn, startTime, this.currentAbort.signal, authHeader, { enableSearch })
        } catch (apiErr) {
          if (apiErr.name === 'AbortError') throw apiErr
          console.warn('[AntigravityAdapter] 云端接口连接失败，自动转为本地兜底模式:', apiErr.message)
          const is503 = apiErr.message && apiErr.message.includes('503')
          const is401 = apiErr.message && (apiErr.message.includes('401') || apiErr.message.includes('UNAUTHENTICATED'))
          let notice = ''
          if (is503) {
            notice = '（Google Gemini 官方服务暂时繁忙 [503]，小胖次已为您切换到本地待机模式~）\n\n'
          } else if (is401) {
            notice = '（主人，小胖次发现您的 Google 账号登录凭据无法直接访问云端大模型哦 [401]。因为 Google 官方限制了个人账号 OAuth 直接调用的权限（需要在 Google Cloud 中复杂配置并开启 API）。\n\n💡 小胖次强烈建议：请在桌宠右键菜单中点击【🔑 API 模式】，填入免费申请的 Gemini API Key，就可以立刻和小胖次畅快联机啦！）\n\n'
          }
          await this.streamMockResponse(text, currentTurn, startTime, this.currentAbort.signal, notice)
        }
      } else {
        await this.streamMockResponse(text, currentTurn, startTime, this.currentAbort.signal)
      }
      return { ok: true, turn: currentTurn }
    } catch (err) {
      if (err.name === 'AbortError') {
        // 已由 cancel 处理
        return { ok: true, aborted: true }
      }
      console.error('[AntigravityAdapter] 请求异常:', err)
      this.emitEvent({
        t: 'turn-end',
        reason: { kind: 'error', error: { message: err.message || '网络请求失败' } }
      })
      return { ok: false, error: err.message }
    } finally {
      this.saveCurrentSession()
      this.activeTask = false
      this.currentAbort = null
    }
  }

  buildGeminiPayload(enableSearch = this.enableSearch) {
    const contents = []
    let systemInstruction = null

    for (const m of this.messages) {
      if (m.role === 'system') {
        systemInstruction = { parts: [{ text: m.content }] }
      } else if (m.role === 'user') {
        contents.push({ role: 'user', parts: [{ text: m.content }] })
      } else if (m.role === 'assistant') {
        contents.push({ role: 'model', parts: [{ text: m.content }] })
      }
    }

    const payload = {
      contents,
      generationConfig: {
        temperature: 0.7
      }
    }

    if (enableSearch) {
      payload.tools = [
        { googleSearch: {} }
      ]
    }

    if (systemInstruction) {
      payload.systemInstruction = systemInstruction
    }

    return payload
  }

  getEffectiveApiKey() {
    const key = (
      this.authManager.apiKey ||
      this.apiKey ||
      process.env.ANTIGRAVITY_API_KEY ||
      process.env.GEMINI_API_KEY ||
      ''
    ).trim()
    return (key && key !== 'undefined' && key !== 'null') ? key : ''
  }

  async streamFromApi(turn, startTime, signal, authHeader, options = {}) {
    const enableSearch = options.enableSearch !== undefined
      ? !!options.enableSearch
      : (options.search !== undefined ? !!options.search : this.enableSearch)

    const apiKey = this.getEffectiveApiKey()
    const hasValidKey = !!apiKey

    let accessToken = null
    if (this.authManager.authType === 'oauth' || (this.authManager.tokens && (this.authManager.tokens.access_token || this.authManager.tokens.refresh_token))) {
      try {
        accessToken = await this.authManager.getValidAccessToken()
      } catch (e) {
        console.warn('[AntigravityAdapter] 获取 OAuth Access Token 异常:', e.message)
      }
    }

    const auth = authHeader || (accessToken ? `Bearer ${accessToken}` : (hasValidKey ? `Bearer ${apiKey}` : null))
    if (!auth && !hasValidKey && !accessToken) {
      throw new Error('未配置认证凭据（未登录 Google 账号且未设置 API Key）')
    }

    const targetModel = normalizeModelName(this.model)
    const candidateModels = getFallbackCandidates(targetModel)
    const apiFormat = detectApiFormat(this.baseUrl, targetModel)
    const isGemini = apiFormat === 'gemini'

    let lastError = null
    let res = null

    for (let cIdx = 0; cIdx < candidateModels.length; cIdx++) {
      const currentCandidate = candidateModels[cIdx]
      if (cIdx > 0) {
        console.warn(`[AntigravityAdapter] 模型降级尝试: ${candidateModels[cIdx - 1]} -> ${currentCandidate}`)
      }

      // 根据检测到的协议智能构建请求 URL 与 Body（Gemini 原生 vs OpenAI / DeepSeek 兼容格式）
      let url = ''
      let reqBody = null
      const headers = { 'Content-Type': 'application/json' }

      if (isGemini) {
        url = `https://generativelanguage.googleapis.com/v1beta/models/${currentCandidate}:streamGenerateContent?alt=sse`
        if (hasValidKey) {
          const sep = url.includes('?') ? '&' : '?'
          url += `${sep}key=${encodeURIComponent(apiKey)}`
          headers['x-goog-api-key'] = apiKey
          // API Key 优先策略：必须确保 headers 中无 Authorization 字段
          delete headers['Authorization']
        } else if (accessToken) {
          // 仅当没有 API Key 且存在 OAuth Token 时才附带 Authorization
          headers['Authorization'] = `Bearer ${accessToken}`
        } else if (authHeader && authHeader.startsWith('Bearer ya29.')) {
          headers['Authorization'] = authHeader
        }
        reqBody = this.buildGeminiPayload(enableSearch)
      } else {
        // OpenAI / DeepSeek / 通用兼容协议
        let base = (this.baseUrl || 'https://api.openai.com/v1').trim().replace(/\/+$/, '')
        if (!base.endsWith('/chat/completions')) {
          url = `${base}/chat/completions`
        } else {
          url = base
        }
        const token = apiKey || (auth ? auth.replace(/^Bearer\s+/i, '') : accessToken)
        if (token) {
          headers['Authorization'] = `Bearer ${token}`
        }
        reqBody = {
          model: currentCandidate,
          messages: this.messages,
          stream: true,
          temperature: 0.7
        }
      }

      const maxAttempts = 2
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          console.log('[Adapter Auth Check] URL has key:', !!url.includes('key='), 'Has Auth Header:', !!headers['Authorization']);

          res = await fetch(url, {
            method: 'POST',
            headers,
            body: JSON.stringify(reqBody),
            signal
          })

          if (!res.ok && (res.status === 401 || res.status === 403 || res.status === 404) && this.authManager.authType === 'oauth') {
            // 若 OAuth 模式下未通过，且用户本地配置了有效 API Key，自动无缝尝试 API Key 重新请求
            if (hasValidKey) {
              console.warn('[AntigravityAdapter] Google OAuth 凭据未通过 (401)，正在自动尝试 API Key 密钥兜底请求...')
              let fallbackUrl = isGemini
                ? `https://generativelanguage.googleapis.com/v1beta/models/${currentCandidate}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`
                : `${this.baseUrl}/chat/completions`

              const fallbackHeaders = {
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey
              }
              delete fallbackHeaders['Authorization']

              console.log('[Adapter Auth Check] URL has key:', !!fallbackUrl.includes('key='), 'Has Auth Header:', !!fallbackHeaders['Authorization']);

              const apiKeyRes = await fetch(fallbackUrl, {
                method: 'POST',
                headers: fallbackHeaders,
                body: JSON.stringify(reqBody),
                signal
              })
              if (apiKeyRes.ok) {
                res = apiKeyRes
                break
              }
            }
          }

          if (res.ok) {
            break
          }

          const errBody = await res.text().catch(() => '')
          lastError = new Error(`API 响应错误 [${res.status}]: ${errBody || res.statusText}`)

          // 遇到 503 且同模型还有重试机会时等待重试
          if (res.status === 503 && attempt < maxAttempts) {
            console.warn(`[AntigravityAdapter] 模型 ${currentCandidate} 遭遇 503 繁忙，正在重试 (${attempt}/${maxAttempts})...`)
            await new Promise(r => setTimeout(r, 1000))
            continue
          } else {
            // 401/403 认证错误直接抛出
            if (res.status === 401 || res.status === 403) {
              throw lastError
            }
            // 404 或 503 超过重试次数，跳出当前模型循环以尝试下一个降级候选模型
            break
          }
        } catch (err) {
          if (err.name === 'AbortError') throw err
          lastError = err
          if (err.message && (err.message.includes('401') || err.message.includes('403'))) {
            throw err
          }
          if (attempt >= maxAttempts) break
        }
      }

      if (res && res.ok) {
        break
      }
    }

    if (!res || !res.ok) {
      throw lastError || new Error(`模型 ${targetModel} 连接失败`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder('utf-8')
    let buffer = ''
    let fullResponse = ''
    let approxTokens = 0
    const groundingQueries = new Set()
    const groundingSources = []

    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() // 保留未完成的行

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith(':')) continue
        if (trimmed === 'data: [DONE]') continue

        if (trimmed.startsWith('data: ')) {
          try {
            const data = JSON.parse(trimmed.slice(6))

            // 1. OpenAI 格式兼容
            const choice = data.choices && data.choices[0]
            if (choice && choice.delta) {
              const delta = choice.delta
              // 思考过程 (Reasoning)
              if (delta.reasoning_content) {
                this.emitEvent({
                  t: 'delta',
                  kind: 'reasoning',
                  text: delta.reasoning_content
                })
              }
              // 正文内容
              if (delta.content) {
                fullResponse += delta.content
                approxTokens += Math.max(1, Math.ceil(delta.content.length / 2))
                this.emitEvent({
                  t: 'delta',
                  kind: 'text',
                  text: delta.content
                })
              }
            } else if (data.candidates && Array.isArray(data.candidates) && data.candidates.length > 0) {
              // 2. Google Gemini Native 格式（全面支持 Grounding 与联网搜索元数据）
              const cand = data.candidates[0]
              if (cand) {
                // 安全解析 groundingMetadata（Google Search 联网检索来源与检索查询）
                const gMeta = cand.groundingMetadata || data.groundingMetadata
                if (gMeta) {
                  // 检索查询关键词 (webSearchQueries)
                  const queries = gMeta.webSearchQueries || gMeta.retrievalQueries
                  if (Array.isArray(queries)) {
                    for (const q of queries) {
                      if (typeof q === 'string' && q.trim() && !groundingQueries.has(q.trim())) {
                        const cleanQ = q.trim()
                        groundingQueries.add(cleanQ)
                        this.emitEvent({
                          t: 'tool-call',
                          name: 'google_search',
                          label: `正在通过 Google 搜索联网检索: ${cleanQ}`,
                          args: { query: cleanQ }
                        })
                      }
                    }
                  }
                  // 检索来源网页参考列表 (groundingChunks)
                  if (Array.isArray(gMeta.groundingChunks)) {
                    for (const ch of gMeta.groundingChunks) {
                      const web = ch && ch.web
                      if (web && web.uri) {
                        if (!groundingSources.some(s => s.uri === web.uri)) {
                          groundingSources.push({
                            uri: web.uri,
                            title: web.title || web.uri
                          })
                        }
                      }
                    }
                  }
                }

                // 提取文本正文内容 (parts)
                const parts = cand.content && cand.content.parts
                if (Array.isArray(parts)) {
                  for (const part of parts) {
                    if (part && typeof part.text === 'string' && part.text) {
                      fullResponse += part.text
                      approxTokens += Math.max(1, Math.ceil(part.text.length / 2))
                      this.emitEvent({
                        t: 'delta',
                        kind: 'text',
                        text: part.text
                      })
                    }
                    if (part && typeof part.thought === 'string' && part.thought) {
                      this.emitEvent({
                        t: 'delta',
                        kind: 'reasoning',
                        text: part.thought
                      })
                    }
                  }
                }
              }

              // 如果官方返回了精确的 Token 统计
              if (data.usageMetadata && typeof data.usageMetadata.candidatesTokenCount === 'number') {
                approxTokens = data.usageMetadata.candidatesTokenCount
              }
            }
          } catch (e) {
            // 忽略单帧 JSON 解析错误
          }
        }
      }
    }

    // 若触发了联网搜索，发送 tool-result 完成状态
    if (groundingQueries.size > 0) {
      this.emitEvent({
        t: 'tool-result',
        name: 'google_search',
        result: {
          queries: Array.from(groundingQueries),
          sourcesCount: groundingSources.length,
          sources: groundingSources
        }
      })
    }

    this.messages.push({ role: 'assistant', content: fullResponse })
    this.totalTokens += approxTokens
    const elapsed = Date.now() - startTime

    this.emitEvent({
      t: 'assistant',
      text: fullResponse,
      usage: { output: approxTokens },
      sources: groundingSources.length > 0 ? groundingSources : undefined
    })

    this.emitEvent({
      t: 'turn-end',
      reason: 'completed',
      tokens: approxTokens,
      ms: elapsed
    })
  }

  async streamMockResponse(userText, turn, startTime, signal, prefixNotice = '') {
    // 模拟思考和工具调用，展现完整的 Live2D 动作管线
    const isCodeQuery = /代码|写|bug|函数|实现|vue|react|js|ts|swift|python/i.test(userText)
    const isWeatherQuery = /天气|下雨|气温|冷不冷|热不热|晴天|阴天|刮风|多云|暴雨|下雪/i.test(userText)
    const isSearchQuery = /查|搜索|文档|什么是|怎么|多少|新闻/i.test(userText)

    // 1. 模拟思考沉思
    await new Promise((r) => setTimeout(r, 600))
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError')

    // 2. 模拟 Tool Calling（若命中特定意图）
    if (isCodeQuery) {
      this.emitEvent({
        t: 'tool-call',
        name: 'codebase_search',
        label: '正在检索本地代码库…',
        args: { query: userText }
      })
      await new Promise((r) => setTimeout(r, 1200))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      this.emitEvent({
        t: 'tool-result',
        name: 'codebase_search',
        result: { status: 'ok', hits: 3 }
      })
    } else if (isWeatherQuery) {
      this.emitEvent({
        t: 'tool-call',
        name: 'weather_check',
        label: '正在探出水面看天气…',
        args: { query: userText }
      })
      await new Promise((r) => setTimeout(r, 900))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      this.emitEvent({
        t: 'tool-result',
        name: 'weather_check',
        result: { status: 'ok' }
      })
    } else if (isSearchQuery) {
      this.emitEvent({
        t: 'tool-call',
        name: 'fetch_docs',
        label: '正在检索相关知识资料…',
        args: { topic: userText }
      })
      await new Promise((r) => setTimeout(r, 1000))
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      this.emitEvent({
        t: 'tool-result',
        name: 'fetch_docs',
        result: { status: 'ok' }
      })
    }

    // 3. 构建模拟回复文本
    let reply = ''
    if (isWeatherQuery) {
      reply = `今天的天气呀…主人不妨推开窗看一看外面的天空呢~ 无论今天外面是晴空万里还是细雨绵绵，都要注意温差变化，出门记得带好雨伞或者添件外套哦！小胖次会一直在桌面上陪伴着主人呢~ （若想获取城市实时精准天气，在右键设置中登录 Google 账号或配置 API Key 即可接入大模型哦！）`
    } else if (isCodeQuery) {
      reply = `小胖次已经仔细看过代码需求啦！针对这个问题，建议采用高内聚、低耦合的模块化设计拆分核心逻辑，这样后续测试和维护都会很轻松~ 小胖次随时准备好协助你继续编写详细实现哦！`
    } else if (isSearchQuery) {
      reply = `关于「${userText}」，小胖次已经帮你梳理好思路要点啦！如果需要更深入的专业解答或完整实现，随时可以告诉小胖次哦~`
    } else {
      const greetings = [
        `小胖次在呢！有什么小胖次可以帮你的吗？不管是写代码、整理思路还是聊聊天，随时吩咐小胖次哦~`,
        `主人好！今天也要元气满满地推进项目呢，需要小胖次为你做些什么嘛？`,
        `收到啦~ 小胖次随时待命！告诉我你的需求吧~`
      ]
      reply = greetings[Math.floor(Math.random() * greetings.length)]
    }

    if (prefixNotice) {
      reply = prefixNotice + reply
    }

    // 4. 打字机式逐字流式推送
    const chunkSize = 2
    for (let i = 0; i < reply.length; i += chunkSize) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
      const slice = reply.slice(i, i + chunkSize)
      this.emitEvent({
        t: 'delta',
        kind: 'text',
        text: slice
      })
      await new Promise((r) => setTimeout(r, 45))
    }

    const approxTokens = Math.ceil(reply.length * 1.5)
    this.totalTokens += approxTokens
    const elapsed = Date.now() - startTime

    this.messages.push({ role: 'assistant', content: reply })

    this.emitEvent({
      t: 'assistant',
      text: reply,
      usage: { output: approxTokens }
    })

    this.emitEvent({
      t: 'turn-end',
      reason: 'completed',
      tokens: approxTokens,
      ms: elapsed
    })
  }
}
