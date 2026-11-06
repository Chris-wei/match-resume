// 内容安全检查：本地敏感词库 → 微信 msgSecCheck（2.0）。
//   - 本地词库：sensitive-words.txt（命中即拦）+ sensitive-allow.txt（白名单，防误伤正常表述，如「反洗钱」）
//     匹配前统一归一化（全角半角、大小写）并去掉空白/标点/符号，防「杀 人」「杀*人」这类变形绕过
//   - 微信接口：以微信判定为准。suggest=risky 拦截；review 放行只记日志
//     配了 AppID/Secret 但调用失败 → 返回 unavailable，由调用方判提交失败（不扣次数）
//     未配置 → 跳过，只查本地词库（本地开发 / mock）
// 日志只记字段、来源、命中词/类别，不记原文。

const fs = require('fs')
const path = require('path')
const http = require('http')
const https = require('https')
const { URL } = require('url')
const config = require('./config')

// ---------------- 本地词库 ----------------

/** 匹配用的紧凑形式：归一化后去掉空白、标点、符号。 */
function compact(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, '')
}

function loadList(file) {
  let text = ''
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch {
    console.warn(`⚠ 敏感词文件不存在：${file}`)
    return []
  }
  const out = new Set()
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    const key = compact(line)
    if (key) out.add(key)
  }
  return [...out]
}

let lists = null
function defaultLists() {
  if (!lists) {
    lists = {
      words: loadList(config.SENSITIVE_WORDS_FILE),
      allow: loadList(config.SENSITIVE_ALLOW_FILE)
    }
  }
  return lists
}

/**
 * 本地词库检查。返回命中的敏感词（紧凑形式）或 null。
 * 白名单先把文本中对应位置遮掉，再查敏感词：「反洗钱」不会因为含「洗钱」被拦。
 */
function localCheck(text, { words, allow } = defaultLists()) {
  let s = compact(text)
  if (!s) return null
  for (const a of allow) {
    if (s.includes(a)) s = s.split(a).join('\u0000'.repeat(a.length))
  }
  for (const w of words) if (s.includes(w)) return w
  return null
}

// ---------------- 微信 msgSecCheck ----------------

const wechatEnabled = () => !!(config.WX_APPID && config.WX_APPSECRET)
const mode = () => (wechatEnabled() ? 'local+wechat' : 'local')

function postJSON(urlStr, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const lib = url.protocol === 'http:' ? http : https
    const data = Buffer.from(JSON.stringify(body))
    const req = lib.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
      (res) => {
        let d = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch {
            reject(new Error('WX_BAD_JSON'))
          }
        })
      }
    )
    req.setTimeout(timeoutMs, () => req.destroy(new Error('WX_TIMEOUT')))
    req.on('error', reject)
    req.end(data)
  })
}

// access_token 用 getStableAccessToken：与其他服务共用同一 AppID 时不会互相顶掉
let tokenCache = { token: '', expiresAt: 0 }
async function accessToken(forceRefresh = false) {
  if (!forceRefresh && tokenCache.token && Date.now() < tokenCache.expiresAt) return tokenCache.token
  const res = await postJSON(
    `${config.WX_API_BASE}/cgi-bin/stable_token`,
    { grant_type: 'client_credential', appid: config.WX_APPID, secret: config.WX_APPSECRET, force_refresh: forceRefresh },
    config.WX_SEC_TIMEOUT_MS
  )
  if (!res || !res.access_token) throw new Error(`WX_TOKEN_${res && res.errcode}`)
  // 提前 5 分钟过期，避免边界上拿到刚失效的 token
  tokenCache = { token: res.access_token, expiresAt: Date.now() + Math.max(60, (res.expires_in || 7200) - 300) * 1000 }
  return tokenCache.token
}

const TOKEN_INVALID = new Set([40001, 40014, 42001])

/** 单段检测。返回 { suggest, label }；接口失败抛错。token 失效时刷新一次重试。 */
async function secCheckOnce(content, openid, scene) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const token = await accessToken(attempt > 0)
    const res = await postJSON(
      `${config.WX_API_BASE}/wxa/msg_sec_check?access_token=${encodeURIComponent(token)}`,
      { content, version: 2, scene, openid },
      config.WX_SEC_TIMEOUT_MS
    )
    if (res && res.errcode === 0 && res.result) return { suggest: res.result.suggest, label: res.result.label }
    if (res && TOKEN_INVALID.has(res.errcode) && attempt === 0) continue
    throw new Error(`WX_SEC_${res && res.errcode}`)
  }
}

/** 按行切段，每段不超过 max 字（单行超长再硬切）。 */
function chunk(text, max = config.WX_SEC_CHUNK_CHARS) {
  const out = []
  let cur = ''
  for (const line of String(text).split('\n')) {
    for (let i = 0; i < Math.max(1, line.length); i += max) {
      const piece = line.slice(i, i + max)
      if (cur && cur.length + 1 + piece.length > max) {
        out.push(cur)
        cur = piece
      } else {
        cur = cur ? cur + '\n' + piece : piece
      }
    }
  }
  if (cur.trim()) out.push(cur)
  return out
}

// 微信 scene：1 资料 / 2 评论
const SCENE = { profile: 1, comment: 2 }

/**
 * 检查一组文本。items: [{ field, text, scene: 'profile'|'comment' }]
 * opts.owner：会话身份（'o:<openid>' 才能调微信）；opts.skipWechat：只查本地（如复用已经过微信检查的报告）
 * 返回：
 *   { ok: true, wechatChecked }                          通过
 *   { ok: false, blocked: true, field, source, hit }     命中（source: local | wechat）
 *   { ok: false, unavailable: true }                     微信已配置但调用失败
 */
async function checkTexts(items, { owner = '', skipWechat = false, lists: custom } = {}) {
  const texts = items.filter((it) => it.text && String(it.text).trim())

  for (const it of texts) {
    const hit = localCheck(it.text, custom)
    if (hit) {
      console.warn(`moderation blocked: field=${it.field} source=local word=${hit}`)
      return { ok: false, blocked: true, field: it.field, source: 'local', hit }
    }
  }

  if (!wechatEnabled() || skipWechat) return { ok: true, wechatChecked: false }

  const openid = owner.startsWith('o:') ? owner.slice(2) : ''
  if (!openid) {
    // 配置了微信却没有 openid（如配置前签发的旧会话）：无法检测，按不可用处理
    console.warn('moderation unavailable: session has no openid')
    return { ok: false, unavailable: true }
  }

  const tasks = []
  for (const it of texts) {
    for (const piece of chunk(it.text)) {
      tasks.push(secCheckOnce(piece, openid, SCENE[it.scene] || SCENE.profile).then((r) => ({ field: it.field, ...r })))
    }
  }
  let results
  try {
    results = await Promise.all(tasks)
  } catch (e) {
    console.warn('moderation unavailable:', e.message)
    return { ok: false, unavailable: true }
  }
  for (const r of results) {
    if (r.suggest === 'risky') {
      console.warn(`moderation blocked: field=${r.field} source=wechat label=${r.label}`)
      return { ok: false, blocked: true, field: r.field, source: 'wechat', hit: String(r.label) }
    }
    if (r.suggest === 'review') console.warn(`moderation review (放行): field=${r.field} label=${r.label}`)
  }
  return { ok: true, wechatChecked: true }
}

module.exports = {
  checkTexts,
  localCheck,
  compact,
  chunk,
  mode,
  wechatEnabled,
  _resetToken: () => (tokenCache = { token: '', expiresAt: 0 })
}
