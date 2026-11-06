// 网页后台：/admin 页面 + /admin/api/* 数据接口（只给开发者本人用）。
//   - ADMIN_PASSWORD 未设置 → /admin* 一律 404（后台完全关闭）
//   - 登录：密码常量时间比较 → HttpOnly + SameSite=Strict 会话 cookie（HMAC 签名，12 小时）
//   - 防爆破：同一 IP 10 分钟内失败 5 次即锁定
//   - 后台 cookie 与小程序 token 签名输入不同（加 'admin.' 前缀），互不通用
// 查询逻辑见 adminQuery.js；设计文档 §5。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const db = require('./db')
const { secretKey, ipHashOf } = require('./auth')
const adminQuery = require('./adminQuery')

const COOKIE = 'admin_session'
const LOCK_WINDOW_MS = 10 * 60e3
const LOCK_MAX_FAILURES = 5
const BODY_CAP = 10 * 1024

const failures = new Map() // ipHash -> [失败时间戳]

const HTML_FILE = path.join(__dirname, 'admin.html')

const sign = (body) => crypto.createHmac('sha256', secretKey()).update('admin.' + body).digest('base64url')

function issueSession(now = Date.now()) {
  const body = Buffer.from(JSON.stringify({ kind: 'admin', exp: now + config.ADMIN_SESSION_HOURS * 3600e3 })).toString('base64url')
  return body + '.' + sign(body)
}

function verifySession(token, now = Date.now()) {
  if (!token || typeof token !== 'string') return false
  const dot = token.indexOf('.')
  if (dot <= 0) return false
  const body = token.slice(0, dot)
  const sig = Buffer.from(token.slice(dot + 1))
  const expect = Buffer.from(sign(body))
  if (sig.length !== expect.length || !crypto.timingSafeEqual(sig, expect)) return false
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    return p.kind === 'admin' && typeof p.exp === 'number' && p.exp > now
  } catch {
    return false
  }
}

function passwordOk(input) {
  // 先各自哈希成等长再比较，长度不同也不泄露时间差
  const a = crypto.createHash('sha256').update(String(input || '')).digest()
  const b = crypto.createHash('sha256').update(config.ADMIN_PASSWORD).digest()
  return crypto.timingSafeEqual(a, b)
}

function recentFailures(ipHash, now) {
  const list = (failures.get(ipHash) || []).filter((t) => now - t < LOCK_WINDOW_MS)
  failures.set(ipHash, list)
  return list
}

function cookieOf(req, name) {
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=')
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim()
  }
  return ''
}

function cookieAttrs(maxAge) {
  return `HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${maxAge}${config.TRUST_PROXY ? '; Secure' : ''}`
}

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer'
}

function sendJSON(res, status, obj, extra = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS, ...extra })
  res.end(JSON.stringify(obj))
}

const fail = (code, message) => ({ ok: false, code, message })

function readJSON(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size <= BODY_CAP) chunks.push(c)
    })
    req.on('end', () => {
      if (size > BODY_CAP) return resolve(null)
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

async function handle(req, res, url) {
  if (!config.ADMIN_PASSWORD) return sendJSON(res, 404, fail('NOT_FOUND', '接口不存在'))
  const p = url.pathname.replace(/\/+$/, '') || '/'
  const now = Date.now()

  if (req.method === 'GET' && p === '/admin') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...SECURITY_HEADERS })
    return res.end(fs.readFileSync(HTML_FILE))
  }

  if (req.method === 'POST' && p === '/admin/api/login') {
    const ipHash = ipHashOf(req)
    if (recentFailures(ipHash, now).length >= LOCK_MAX_FAILURES) {
      return sendJSON(res, 200, fail('LOCKED', '尝试次数过多，请 10 分钟后再试'))
    }
    const body = await readJSON(req)
    if (!body || !passwordOk(body.password)) {
      failures.get(ipHash).push(now)
      return sendJSON(res, 200, fail('BAD_PASSWORD', '密码错误'))
    }
    failures.delete(ipHash)
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=${issueSession(now)}; ${cookieAttrs(config.ADMIN_SESSION_HOURS * 3600)}` })
  }

  if (req.method === 'POST' && p === '/admin/api/logout') {
    return sendJSON(res, 200, { ok: true }, { 'Set-Cookie': `${COOKIE}=; ${cookieAttrs(0)}` })
  }

  if (!p.startsWith('/admin/api/')) return sendJSON(res, 404, fail('NOT_FOUND', '接口不存在'))
  if (!verifySession(cookieOf(req, COOKIE), now)) return sendJSON(res, 401, fail('UNAUTHORIZED', '请先登录'))
  if (req.method !== 'GET') return sendJSON(res, 405, fail('BAD_METHOD', '不支持的请求方法'))

  const data = db.data
  if (p === '/admin/api/summary') return sendJSON(res, 200, { ok: true, ...adminQuery.summary(data, now) })
  if (p === '/admin/api/feedback') {
    const q = url.searchParams
    const filters = {
      q1: q.get('q1') || 'all',
      hasWrong: q.get('hasWrong') === '1',
      hasComment: q.get('hasComment') === '1',
      version: q.get('version') || '',
      page: q.get('page') || 1
    }
    return sendJSON(res, 200, { ok: true, ...adminQuery.list(data, filters, now) })
  }
  const m = p.match(/^\/admin\/api\/report\/([\w-]+)$/)
  if (m) {
    const d = adminQuery.detail(data, m[1], now)
    if (!d) return sendJSON(res, 200, fail('NOT_FOUND', '报告不存在'))
    return sendJSON(res, 200, { ok: true, ...d })
  }
  return sendJSON(res, 404, fail('NOT_FOUND', '接口不存在'))
}

module.exports = { handle, _verifySession: verifySession, _issueSession: issueSession }
