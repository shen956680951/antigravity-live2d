/**
 * test/integration.test.mjs —— Antigravity 桌宠服务端与适配器集成测试
 */

import { AntigravityAdapter } from '../lib/adapter.js'
import http from 'node:http'

async function runTests() {
  console.log('--- 开始测试 AntigravityAdapter ---')
  const adapter = new AntigravityAdapter({
    mode: 'chat',
    model: 'gemini-3.5-flash-lite'
  })

  const events = []
  adapter.on('agent-event', (e) => {
    events.push(e)
  })

  // 1. 测试提问（本地模拟模式）
  console.log('测试 1: 提问与流式事件产生...')
  const askRes = await adapter.ask('你好，请做个自我介绍！')
  if (!askRes.ok) throw new Error('ask failed: ' + askRes.error)

  const hasUser = events.some((e) => e.t === 'user')
  const hasTurnStart = events.some((e) => e.t === 'turn-start')
  const hasDelta = events.some((e) => e.t === 'delta')
  const hasAssistant = events.some((e) => e.t === 'assistant')
  const hasTurnEnd = events.some((e) => e.t === 'turn-end')

  if (!hasUser || !hasTurnStart || !hasDelta || !hasAssistant || !hasTurnEnd) {
    throw new Error('缺失关键事件: ' + JSON.stringify(events.map((e) => e.t)))
  }
  console.log(`  ✓ 收到事件 ${events.length} 个 (user, turn-start, delta, assistant, turn-end)`)

  // 2. 测试工具调用触发（编码类提问）
  events.length = 0
  console.log('测试 2: 编码提问触发 Tool Calling 表演与状态映射...')
  await adapter.ask('帮我写一个快速排序函数')
  const hasToolCall = events.some((e) => e.t === 'tool-call')
  const hasToolResult = events.some((e) => e.t === 'tool-result')
  if (!hasToolCall || !hasToolResult) {
    throw new Error('未触发工具调用事件: ' + JSON.stringify(events.map((e) => e.t)))
  }
  console.log('  ✓ 成功触发 tool-call 与 tool-result')

  // 3. 测试上下文清空
  events.length = 0
  console.log('测试 3: 清空上下文...')
  adapter.clearContext()
  if (adapter.messages.length !== 1 || adapter.messages[0].role !== 'system') {
    throw new Error('上下文未清空')
  }
  console.log('  ✓ 上下文成功重置为系统提示词')

  // 4. 测试模式切换
  console.log('测试 4: 模式切换...')
  adapter.setMode('coder')
  if (adapter.mode !== 'coder') throw new Error('模式设置失败')
  console.log('  ✓ 模式成功切换为 coder')

  // 5. 测试模型切换至 gemini-3.5-flash-lite, gemini-3.8-flash 与 gemini-3.1-pro-preview
  console.log('测试 5: 模型切换至 3 款指定模型及降级列表自检...')
  adapter.setModel('gemini-3.5-flash-lite')
  if (adapter.model !== 'gemini-3.5-flash-lite') throw new Error('切换 gemini-3.5-flash-lite 失败')
  adapter.setModel('gemini-3.8-flash')
  if (adapter.model !== 'gemini-3.8-flash') throw new Error('切换 gemini-3.8-flash 失败')
  adapter.setModel('gemini-3.1-pro-preview')
  if (adapter.model !== 'gemini-3.1-pro-preview') throw new Error('切换 gemini-3.1-pro-preview 失败')
  adapter.setModel('gemini-3.5-flash-lite')
  if (adapter.model !== 'gemini-3.5-flash-lite') throw new Error('恢复默认 gemini-3.5-flash-lite 失败')

  const { getFallbackCandidates } = await import('../lib/adapter.js')
  const proCands = getFallbackCandidates('gemini-3.1-pro-preview')
  if (!proCands.includes('gemini-3.8-flash') || !proCands.includes('gemini-3.5-flash-lite')) {
    throw new Error('gemini-3.1-pro-preview 降级列表不完整')
  }
  console.log('  ✓ 三款模型切换与降级候选列表自检全部通过！')

  // 6. 测试自称「小胖次」人设校验
  console.log('测试 6: 人设自称「小胖次」与 Prompt 规则自检...')
  const sysMsg = adapter.messages.find(m => m.role === 'system')
  if (!sysMsg || !sysMsg.content.includes('小胖次')) {
    throw new Error('系统提示词缺少「小胖次」人设自称要求')
  }
  if (sysMsg.content.includes('溟月')) {
    throw new Error('系统提示词仍含有「溟月」残留')
  }
  console.log('  ✓ 系统 Prompt 成功锁定「小胖次」自称！')

  // 7. 测试 AuthManager 鉴权与 Bearer Header 模块
  console.log('测试 7: AuthManager 鉴权系统测试 (Google OAuth 与 API Key)...')
  const { authManager } = await import('../lib/auth.js')
  const initialStatus = authManager.getStatus()
  if (!initialStatus || typeof initialStatus.authType !== 'string') {
    throw new Error('AuthManager getStatus 格式异常')
  }

  // 测试设置 API Key
  authManager.setApiKey('test-antigravity-api-key-12345')
  if (authManager.apiKey !== 'test-antigravity-api-key-12345') {
    throw new Error('设置 API Key 失败')
  }
  const authHeader = await adapter.getAuthorizationHeader()
  if (!authHeader || !authHeader.startsWith('Bearer test-antigravity-api-key-12345')) {
    throw new Error('生成的 Bearer Authorization Header 异常: ' + authHeader)
  }

  // 测试模式切换
  authManager.setAuthMode('apikey')
  if (authManager.authType !== 'apikey') throw new Error('切换 apikey 模式失败')

  console.log('  ✓ AuthManager 鉴权与 Bearer 请求头联动测试通过！')

  // 8. 测试 Google Search Grounding (联网搜索) 开关与 tools 配置（默认为关闭）
  console.log('测试 8: Google Search Grounding (联网搜索) 开关与 tools 配置（默认关闭）...')
  // 默认自检：应为关闭状态，tools 为 undefined
  const defaultPayload = adapter.buildGeminiPayload()
  if (defaultPayload.tools && defaultPayload.tools.length > 0) {
    throw new Error('默认状态下 tools 应该为关闭 (不包含 tools)')
  }
  // 用户主动开启时：应包含 tools: [{ googleSearch: {} }]
  const searchPayload = adapter.buildGeminiPayload(true)
  if (!searchPayload.tools || !Array.isArray(searchPayload.tools)) {
    throw new Error('开启搜索时 Gemini Payload 缺少 tools 配置')
  }
  const hasGoogleSearch = searchPayload.tools.some(t => t && t.googleSearch && typeof t.googleSearch === 'object')
  if (!hasGoogleSearch) {
    throw new Error('开启搜索时 Gemini tools 中缺少 googleSearch: {} 配置')
  }
  // 测试 setSearch 方法
  adapter.setSearch(true)
  if (!adapter.enableSearch) throw new Error('setSearch(true) 失败')
  const payloadAfterSet = adapter.buildGeminiPayload()
  if (!payloadAfterSet.tools || !payloadAfterSet.tools.some(t => t && t.googleSearch)) {
    throw new Error('setSearch(true) 后 buildGeminiPayload 未带 tools')
  }
  adapter.setSearch(false)
  if (adapter.enableSearch) throw new Error('setSearch(false) 失败')
  console.log('  ✓ 默认关闭、用户主动开启时包含 tools: [{ googleSearch: {} }] 自检通过！')

  // 9. 测试历史会话记录管理
  console.log('测试 9: 历史会话记录管理器 (HistoryManager)...')
  const { historyManager } = await import('../lib/history.js')
  const testSessionId = 'test-session-' + Date.now()
  historyManager.saveSession(testSessionId, '测试会话标题', [
    { role: 'user', content: '你好小胖次' },
    { role: 'assistant', content: '主人好呀！我是小胖次~' }
  ])
  const sessionList = historyManager.list()
  const found = sessionList.find(s => s.id === testSessionId)
  if (!found) throw new Error('保存的会话未在历史列表中找到')
  if (found.title !== '测试会话标题') throw new Error('历史会话标题不匹配')
  if (found.messageCount !== 2) throw new Error('历史会话消息数不匹配')

  // 测试恢复会话
  const resumed = adapter.resumeSession(testSessionId)
  if (!resumed || !resumed.ok) throw new Error('恢复会话失败')
  if (adapter.currentSessionId !== testSessionId) throw new Error('当前激活会话 ID 异常')
  const nonSystemMsgs = adapter.messages.filter(m => m.role !== 'system')
  if (nonSystemMsgs.length !== 2) throw new Error('恢复的消息数量异常')

  // 测试删除会话
  const deleted = historyManager.delete(testSessionId)
  if (!deleted) throw new Error('删除会话失败')
  const foundAfterDel = historyManager.get(testSessionId)
  if (foundAfterDel) throw new Error('删除后会话仍然存在')
  console.log('  ✓ 历史会话的创建、列表、恢复与删除测试通过！')

  // 10. 测试任意 API 协议格式智能识别 (Gemini 原生 vs OpenAI / DeepSeek 兼容格式)
  console.log('测试 10: 智能识别 API 格式 (detectApiFormat) 及任意自定义模型...')
  const { detectApiFormat, normalizeModelName } = await import('../lib/adapter.js')
  
  if (detectApiFormat('https://api.deepseek.com', 'deepseek-chat') !== 'openai') {
    throw new Error('DeepSeek 格式识别异常')
  }
  if (detectApiFormat('https://api.openai.com/v1', 'gpt-4o') !== 'openai') {
    throw new Error('OpenAI 格式识别异常')
  }
  if (detectApiFormat('https://generativelanguage.googleapis.com', 'gemini-3.5-flash-lite') !== 'gemini') {
    throw new Error('Gemini 格式识别异常')
  }
  if (detectApiFormat('https://custom-proxy.com/v1', 'deepseek-reasoner') !== 'openai') {
    throw new Error('自定义 OpenAI 兼容接口识别异常')
  }

  // 验证自定义模型原样保留
  if (normalizeModelName('deepseek-chat') !== 'deepseek-chat') {
    throw new Error('自定义模型名 deepseek-chat 被错误修改')
  }
  if (normalizeModelName('gpt-4o') !== 'gpt-4o') {
    throw new Error('自定义模型名 gpt-4o 被错误修改')
  }
  console.log('  ✓ 任意 API (DeepSeek/OpenAI/Gemini/第三方) 格式智能识别通过！')

  // 11. 测试默认继续上一次对话
  console.log('测试 11: 默认继续上一次对话 (restoreLatestSession)...')
  const persistSessionId = 'test-persist-' + Date.now()
  historyManager.saveSession(persistSessionId, '上次对话主题', [
    { role: 'user', content: '小胖次，我们上次聊到了什么？' },
    { role: 'assistant', content: '主人，上次我们聊到了人工智能哦~' }
  ])
  const restored = adapter.restoreLatestSession()
  if (!restored) throw new Error('restoreLatestSession 恢复失败')
  if (adapter.currentSessionId !== persistSessionId) {
    throw new Error('恢复的会话 ID 不匹配')
  }
  if (!adapter.currentSessionTitle.includes('上次对话主题')) {
    throw new Error('恢复的会话标题不匹配')
  }
  historyManager.delete(persistSessionId)
  console.log('  ✓ 默认自动恢复上一次对话会话测试通过！')

  console.log('--- 所有测试通过！---')
  process.exit(0)
}

runTests().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})
