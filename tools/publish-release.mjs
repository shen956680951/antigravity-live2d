#!/usr/bin/env node
/**
 * tools/publish-release.mjs
 * 
 * 自动发布 Antigravity 鲸鱼娘桌宠到 GitHub Releases：
 * 1. 检查或创建 Git Tag (默认 v1.0.0)
 * 2. 推送源码与标签到 GitHub 远端
 * 3. 自动打包/收集 dist/installers/ 目录下的所有安装包与压缩包
 * 4. 通过 GitHub CLI (gh) 或 GitHub REST API 创建 Release 并上传所有资源文件
 */

import { execSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')
const INSTALLERS_DIR = path.join(ROOT, 'dist', 'installers')

const TAG = process.env.RELEASE_TAG || 'v1.0.0'
const TITLE = process.env.RELEASE_TITLE || 'v1.0.0 - Antigravity 鲸鱼娘桌宠全新跨平台发布'
const REPO = 'Andersen216/dsh-whale-girl-live2d'

const RELEASE_NOTES = `## 🐋 Antigravity 鲸鱼娘桌宠 v1.0.0 跨平台正式发布

### ✨ 核心功能亮点
- 🪟 **原生桌面伴侣**：支持 Windows 与 macOS 全平台透明、置顶、点击穿透常驻桌面。
- ⚡ **开箱即用内置服务**：桌面客户端内置 Antigravity Node.js 后端与 Live2D 模型，无需提前运行命令行即可直接打开使用。
- 🤖 **任意模型与 API 智能兼容**：支持 Google Gemini 官方模型（3.5-flash-lite / 3.8-flash / 3.1-pro）、DeepSeek 官方（含 R1 思考流式解析）、OpenAI 官方以及任意第三方兼容中转接口，自适应协议路由。
- 💬 **对话记忆与上一次会话续接**：默认自动延续上一次对话，支持在输入面板一键开启「➕ 新对话」，配备大屏会话管理历史界面。
- 🔍 **Google Search 联网能力**：支持用户自主选择开启或关闭实时联网搜索。

---

### 📦 安装包下载指引

#### 1. Windows 用户
- **推荐安装包**：\`Antigravity-WhaleGirl-Pet-Windows-Setup-v1.0.0.exe\`（NSIS 安装向导，自动创建桌面与开始菜单快捷方式）
- **免安装绿色版**：\`Antigravity-WhaleGirl-Pet-Windows-v1.0.0.zip\`（解压即用）

#### 2. macOS 用户
- **Apple Silicon (M1/M2/M3/M4 系列芯片)**：
  - 推荐安装镜像：\`Antigravity-WhaleGirl-Pet-macOS-arm64-v1.0.0.dmg\`（双击打开拖拽至“应用程序”即可）
  - 独立 App 压缩包：\`Antigravity-WhaleGirl-Pet-macOS-arm64-v1.0.0.zip\`
- **Intel 架构 Mac**：
  - 安装镜像：\`Antigravity-WhaleGirl-Pet-macOS-x64-v1.0.0.dmg\`
  - 独立 App 压缩包：\`Antigravity-WhaleGirl-Pet-macOS-x64-v1.0.0.zip\`
- **原生极简 Swift 轻量版 (1.5MB)**：
  - 压缩包：\`Antigravity-WhaleGirl-Pet-macOS-Native.zip\`
`

async function main() {
  console.log('==================================================')
  console.log(`  🚀 开始发布 GitHub Release: ${TAG}`)
  console.log(`  📦 目标仓库: ${REPO}`)
  console.log('==================================================\n')

  // 1. 收集待上传的安装包
  if (!fs.existsSync(INSTALLERS_DIR)) {
    console.error(`❌ 未找到安装包目录: ${INSTALLERS_DIR}`)
    process.exit(1)
  }

  const files = fs.readdirSync(INSTALLERS_DIR).filter(file => {
    return file.endsWith('.exe') || file.endsWith('.dmg') || (file.endsWith('.zip') && !file.includes('win-unpacked'))
  }).map(file => path.join(INSTALLERS_DIR, file))

  if (files.length === 0) {
    console.error('❌ 未在 dist/installers/ 找到任何安装包文件 (.exe, .dmg, .zip)')
    process.exit(1)
  }

  console.log('📦 找到以下打包产物：')
  files.forEach(f => {
    const sizeMb = (fs.statSync(f).size / 1024 / 1024).toFixed(1)
    console.log(`  - ${path.basename(f)} (${sizeMb} MB)`)
  })
  console.log()

  // 2. 检查 Tag
  try {
    const existingTags = execSync('git tag', { cwd: ROOT, encoding: 'utf8' }).split('\n')
    if (!existingTags.includes(TAG)) {
      console.log(`📌 创建本地 Git Tag: ${TAG}`)
      execSync(`git tag -a ${TAG} -m "${TITLE}"`, { cwd: ROOT, stdio: 'inherit' })
    }
  } catch (e) {
    console.warn('⚠️ 检查/创建 Tag 警告:', e.message)
  }

  // 3. 检查 gh CLI
  let ghPath = null
  try {
    ghPath = execSync('which gh || ls /opt/homebrew/bin/gh', { encoding: 'utf8' }).trim()
  } catch (e) {}

  if (ghPath) {
    console.log(`🔧 检测到 GitHub CLI: ${ghPath}`)
    try {
      execSync(`${ghPath} auth status`, { stdio: 'pipe' })
      console.log('✓ GitHub CLI 认证状态正常！')

      // 推送 git 提交与 tag
      console.log('📤 推送代码与标签到 GitHub...')
      execSync(`git push origin main --tags`, { cwd: ROOT, stdio: 'inherit' })

      // 创建 notes 临时文件
      const notesFile = path.join(ROOT, '.release-notes.tmp.md')
      fs.writeFileSync(notesFile, RELEASE_NOTES, 'utf8')

      // 使用 gh 创建 release 并上传 assets
      console.log(`🚀 正在创建 Release ${TAG} 并上传安装包...`)
      const fileArgs = files.map(f => `"${f}"`).join(' ')
      execSync(
        `${ghPath} release create ${TAG} ${fileArgs} --title "${TITLE}" --notes-file "${notesFile}"`,
        { cwd: ROOT, stdio: 'inherit' }
      )
      fs.unlinkSync(notesFile)
      console.log('\n🎉 发布成功！已在 GitHub Releases 中就绪。')
      return
    } catch (err) {
      console.log('ℹ️ gh CLI 尚未登录，尝试检查 GITHUB_TOKEN 环境变量...')
    }
  }

  // 4. 如果 gh 未登录，但环境变量中有 GITHUB_TOKEN
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  if (token) {
    console.log('🔑 使用 GITHUB_TOKEN 通过 GitHub REST API 进行发布...')
    // 推送 git
    try {
      execSync(`git push https://${token}@github.com/${REPO}.git main --tags`, { cwd: ROOT, stdio: 'inherit' })
    } catch (e) {
      console.warn('⚠️ Git 推送警告:', e.message)
    }

    // 调用 GitHub API 创建 Release
    const res = await fetch(`https://api.github.com/repos/${REPO}/releases`, {
      method: 'POST',
      headers: {
        Authorization: `token ${token}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'WhaleGirl-Release-Bot'
      },
      body: JSON.stringify({
        tag_name: TAG,
        target_commitish: 'main',
        name: TITLE,
        body: RELEASE_NOTES,
        draft: false,
        prerelease: false
      })
    })

    const releaseData = await res.json()
    if (!res.ok) {
      console.error('❌ 创建 Release 失败:', releaseData)
      process.exit(1)
    }

    console.log(`✓ Release 创建成功: ${releaseData.html_url}`)
    const uploadUrl = releaseData.upload_url.replace(/\{.*?\}$/, '')

    for (const f of files) {
      const fileName = path.basename(f)
      const fileBuf = fs.readFileSync(f)
      console.log(`  ⬆️ 正在上传: ${fileName}...`)
      const upRes = await fetch(`${uploadUrl}?name=${encodeURIComponent(fileName)}`, {
        method: 'POST',
        headers: {
          Authorization: `token ${token}`,
          'Content-Type': 'application/octet-stream',
          'User-Agent': 'WhaleGirl-Release-Bot'
        },
        body: fileBuf
      })
      if (!upRes.ok) {
        console.warn(`  ⚠️ 上传 ${fileName} 失败:`, await upRes.text())
      } else {
        console.log(`  ✓ 上传完成: ${fileName}`)
      }
    }

    console.log('\n🎉 全部安装包已成功上传到 GitHub Releases！')
    return
  }

  console.log(`
----------------------------------------------------------------------
ℹ️ 本地安装包已全部打包完成！
存放目录: ${INSTALLERS_DIR}

由于需要向您的 GitHub 仓库 (${REPO}) 推送代码并创建 Release，
请执行以下任意一种授权方式：

方式 A（推荐）：
在终端中运行一键登录命令：
  gh auth login
然后重新运行：
  node tools/publish-release.mjs

方式 B：
提供一个具备 repo 权限的 GitHub Personal Access Token (PAT)，运行：
  GITHUB_TOKEN=ghp_xxxx node tools/publish-release.mjs
----------------------------------------------------------------------
`)
}

main().catch(err => {
  console.error('执行发布异常:', err)
  process.exit(1)
})
