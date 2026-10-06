import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '../..')

console.log('[Sync] 同步核心资源到 desktop/windows...')

// 1. 同步 lib 目录
const srcLib = path.join(ROOT, 'lib')
const dstLib = path.join(HERE, 'lib')
fs.cpSync(srcLib, dstLib, { recursive: true })
console.log('  ✓ lib/ 同步完成')

// 2. 同步 assets 目录
const srcAssets = path.join(ROOT, 'assets')
const dstAssets = path.join(HERE, 'assets')
fs.cpSync(srcAssets, dstAssets, { recursive: true })
console.log('  ✓ assets/ 同步完成')

// 3. 同步 config.json
const srcConfig = path.join(ROOT, 'config.json')
const dstConfig = path.join(HERE, 'config.json')
if (fs.existsSync(srcConfig)) {
  fs.copyFileSync(srcConfig, dstConfig)
  console.log('  ✓ config.json 同步完成')
}

console.log('[Sync] 全部核心资源同步就绪！')
