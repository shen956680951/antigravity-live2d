/**
 * lib/auth.js —— Antigravity 鲸鱼娘 Google OAuth 2.0 与 API Key 鉴权管理模块
 *
 * 功能：
 * 1. Google OAuth 2.0 桌面端授权（自动唤起浏览器、本地回调接收 Code、换取 Token）
 * 2. Token 持久化存储与基于 refresh_token 的静默自动刷新
 * 3. 支持「Google 账号登录」与「API Key 密钥」双认证模式无缝切换
 * 4. 暴露状态查询、登录、登出、模式切换及密钥配置接口
 */

import fs from 'node:fs'
import path from 'node:path'
import { exec } from 'node:child_process'
import { EventEmitter } from 'node:events'

const OAUTH_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
const OAUTH_TOKEN_URL = 'https://oauth2.googleapis.com/token'
const OAUTH_USERINFO_URL = 'https://www.googleapis.com/oauth2/v2/userinfo'
const DEFAULT_SCOPES = [
  'openid',
  'email',
  'profile',
  'https://www.googleapis.com/auth/cloud-platform'
].join(' ')

export class AuthManager extends EventEmitter {
  constructor(options = {}) {
    super()
    this.options = options
    this.port = options.port || Number(process.env.PORT) || 5199
    this.authFilePath = options.authFilePath || path.join(process.cwd(), '.auth.json')

    // 默认或环境变量配置的 Google OAuth 凭据
    this.clientId = options.clientId || process.env.GOOGLE_CLIENT_ID || ''
    this.clientSecret = options.clientSecret || process.env.GOOGLE_CLIENT_SECRET || ''
    this.redirectUri = `http://localhost:${this.port}/auth/google/callback`

    // 当前运行时状态
    this.authType = 'none' // 'oauth' | 'apikey' | 'none'
    this.tokens = null // { access_token, refresh_token, expiry_date, email, name, picture }
    this.apiKey = process.env.ANTIGRAVITY_API_KEY || process.env.GEMINI_API_KEY || ''
    this.baseUrl = (process.env.ANTIGRAVITY_BASE_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/').replace(/\/+$/, '')

    this.loadState()
  }

  /** 从本地磁盘读取持久化鉴权信息 */
  loadState() {
    try {
      if (fs.existsSync(this.authFilePath)) {
        const raw = fs.readFileSync(this.authFilePath, 'utf8')
        const data = JSON.parse(raw)
        if (data.clientId) this.clientId = data.clientId
        if (data.clientSecret) this.clientSecret = data.clientSecret
        if (data.redirectUri) this.redirectUri = data.redirectUri
        if (data.tokens) this.tokens = data.tokens
        if (data.apiKey) this.apiKey = data.apiKey
        if (data.baseUrl) this.baseUrl = data.baseUrl
        if (data.authType) this.authType = data.authType
      }
    } catch (e) {
      console.warn('[AuthManager] 读取 .auth.json 失败，将使用初始配置:', e.message)
    }

    // 自动判定当前生效的 authType
    if (!this.authType || this.authType === 'none') {
      if (this.tokens && this.tokens.refresh_token) {
        this.authType = 'oauth'
      } else if (this.apiKey) {
        this.authType = 'apikey'
      } else {
        this.authType = 'none'
      }
    }
  }

  /** 将当前鉴权信息保存至磁盘 */
  saveState() {
    try {
      const data = {
        authType: this.authType,
        clientId: this.clientId,
        clientSecret: this.clientSecret,
        redirectUri: this.redirectUri,
        tokens: this.tokens,
        apiKey: this.apiKey,
        baseUrl: this.baseUrl,
        updatedAt: new Date().toISOString()
      }
      fs.writeFileSync(this.authFilePath, JSON.stringify(data, null, 2), { mode: 0o600 })
    } catch (e) {
      console.error('[AuthManager] 保存 .auth.json 失败:', e.message)
    }
  }

  /** 获取当前认证状态供 UI 展示 */
  getStatus() {
    const isGoogleLoggedIn = !!(this.tokens && (this.tokens.refresh_token || this.tokens.access_token))
    const hasApiKey = !!this.apiKey
    return {
      authType: this.authType,
      isGoogleLoggedIn,
      user: isGoogleLoggedIn ? {
        email: this.tokens.email || 'Google User',
        name: this.tokens.name || '已登录用户',
        picture: this.tokens.picture || ''
      } : null,
      hasApiKey,
      apiKeyMasked: hasApiKey ? (this.apiKey.length > 8 ? this.apiKey.slice(0, 4) + '••••••••' + this.apiKey.slice(-4) : '••••••••') : '',
      apiKeyRaw: this.apiKey,
      baseUrl: this.baseUrl,
      hasClientCredentials: !!(this.clientId && this.clientSecret),
      clientId: this.clientId ? (this.clientId.length > 12 ? this.clientId.slice(0, 12) + '••••' : this.clientId) : '',
      clientIdRaw: this.clientId,
      clientSecretRaw: this.clientSecret,
      redirectUri: this.redirectUri
    }
  }

  /** 设置并保存 OAuth Client 凭据 */
  setOAuthCredentials(clientId, clientSecret, redirectUri) {
    if (!clientId) throw new Error('Client ID 不能为空')
    this.clientId = clientId.trim()
    this.clientSecret = (clientSecret || '').trim()
    if (redirectUri && redirectUri.trim()) {
      this.redirectUri = redirectUri.trim()
    }
    this.saveState()
    return true
  }

  /** 生成 Google OAuth 授权链接并自动唤起默认浏览器 */
  startOAuthLogin() {
    if (!this.clientId) {
      throw new Error('未配置 Google Client ID。请先在设置中填写 Google Cloud OAuth 2.0 桌面端凭据。')
    }

    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: DEFAULT_SCOPES,
      access_type: 'offline',
      prompt: 'consent'
    })
    const authUrl = `${OAUTH_AUTH_URL}?${params.toString()}`

    // 唤起系统默认浏览器（支持 macOS / Linux / Windows）
    const cmd = process.platform === 'darwin'
      ? `open "${authUrl}"`
      : process.platform === 'win32'
        ? `start "" "${authUrl}"`
        : `xdg-open "${authUrl}"`

    exec(cmd, (err) => {
      if (err) console.warn('[AuthManager] 唤起浏览器失败，请手动在浏览器中打开授权链接:', authUrl)
    })

    return { authUrl }
  }

  /** 处理 Google OAuth 回调并换取 Token */
  async handleOAuthCallback(code) {
    if (!code) throw new Error('回调缺少授权 code')
    if (!this.clientId) throw new Error('缺少 Google Client ID')

    const body = new URLSearchParams({
      code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code'
    })

    const res = await fetch(OAUTH_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body
    })

    if (!res.ok) {
      const errText = await res.text().catch(() => '')
      throw new Error(`Google Token 交换失败 [${res.status}]: ${errText}`)
    }

    const tokenData = await res.json()
    const { access_token, refresh_token, expires_in, id_token } = tokenData

    // 获取用户信息
    let userInfo = {}
    try {
      const userRes = await fetch(OAUTH_USERINFO_URL, {
        headers: { Authorization: `Bearer ${access_token}` }
      })
      if (userRes.ok) {
        userInfo = await userRes.json()
      } else if (id_token) {
        // 解码 id_token 中的基本信息
        const payload = JSON.parse(Buffer.from(id_token.split('.')[1], 'base64').toString('utf8'))
        userInfo = { email: payload.email, name: payload.name, picture: payload.picture }
      }
    } catch (e) {
      console.warn('[AuthManager] 获取用户信息失败:', e.message)
    }

    this.tokens = {
      access_token,
      refresh_token: refresh_token || (this.tokens && this.tokens.refresh_token),
      expiry_date: Date.now() + ((expires_in || 3600) - 120) * 1000,
      email: userInfo.email || 'google_user@gmail.com',
      name: userInfo.name || 'Google 用户',
      picture: userInfo.picture || ''
    }

    this.authType = 'oauth'
    this.saveState()
    this.emit('auth-changed', this.getStatus())

    return {
      ok: true,
      user: {
        email: this.tokens.email,
        name: this.tokens.name
      }
    }
  }

  /** 获取当前有效的 Google Access Token（带静默自动刷新） */
  async getValidAccessToken() {
    if (!this.tokens || !this.tokens.access_token) {
      throw new Error('未登录 Google 账号')
    }

    // 检查是否临近过期（提前 60 秒刷新）
    const isExpired = Date.now() >= (this.tokens.expiry_date || 0)
    if (!isExpired) {
      return this.tokens.access_token
    }

    // 如果过期且有 refresh_token，静默刷新
    if (this.tokens.refresh_token) {
      try {
        const body = new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          refresh_token: this.tokens.refresh_token,
          grant_type: 'refresh_token'
        })

        const res = await fetch(OAUTH_TOKEN_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body
        })

        if (!res.ok) {
          const errText = await res.text().catch(() => '')
          throw new Error(`Token 刷新失败 [${res.status}]: ${errText}`)
        }

        const data = await res.json()
        this.tokens.access_token = data.access_token
        this.tokens.expiry_date = Date.now() + ((data.expires_in || 3600) - 120) * 1000
        if (data.refresh_token) this.tokens.refresh_token = data.refresh_token
        this.saveState()
        return this.tokens.access_token
      } catch (err) {
        console.error('[AuthManager] 静默刷新 Access Token 失败:', err)
        throw new Error('Google 登录凭证已过期，请重新登录 Google 账号。')
      }
    }

    throw new Error('Google 授权已过期且无刷新凭证，请重新登录。')
  }

  /** 获取当前用于请求的 Bearer Authorization Header */
  async getAuthorizationHeader() {
    if (this.authType === 'oauth') {
      if (!this.tokens || (!this.tokens.access_token && !this.tokens.refresh_token)) {
        return null
      }
      const accessToken = await this.getValidAccessToken()
      return `Bearer ${accessToken}`
    } else if (this.authType === 'apikey') {
      if (!this.apiKey) return null
      return `Bearer ${this.apiKey}`
    } else {
      // 自动退回：如果已登录就用 oauth，如果配了 key 就用 apikey
      if (this.tokens && (this.tokens.access_token || this.tokens.refresh_token)) {
        const token = await this.getValidAccessToken()
        return `Bearer ${token}`
      }
      if (this.apiKey) {
        return `Bearer ${this.apiKey}`
      }
      return null
    }
  }

  /** 退出 Google 账号登录 */
  logoutGoogle() {
    this.tokens = null
    this.authType = this.apiKey ? 'apikey' : 'none'
    this.saveState()
    this.emit('auth-changed', this.getStatus())
    return true
  }

  /** 配置并保存 API Key */
  setApiKey(key, baseUrl) {
    this.apiKey = (key || '').trim()
    if (baseUrl) this.baseUrl = baseUrl.trim().replace(/\/+$/, '')
    this.authType = 'apikey'
    this.saveState()
    this.emit('auth-changed', this.getStatus())
    return true
  }

  /** 切换认证模式 ('oauth' | 'apikey') */
  setAuthMode(mode) {
    if (!['oauth', 'apikey'].includes(mode)) {
      throw new Error('不支持的认证模式: ' + mode)
    }
    this.authType = mode
    this.saveState()
    this.emit('auth-changed', this.getStatus())
    return true
  }
}

export const authManager = new AuthManager()
