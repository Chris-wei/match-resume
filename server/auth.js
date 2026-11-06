// 身份与会话：HMAC 签名 token（无第三方依赖）。
// 身份优先级：wx.login code 换 openid（需配 WX_APPID/WX_APPSECRET）> 设备 ID（本地开发兜底）。
// 存储的 IP 一律加盐哈希，不落原始 IP。

const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const https = require('https')
const http = require('http')
const config = require('./config')

let cachedSecret = null

// 进程内缓存：每次签名/验签/算 IP 哈希都同步读文件没有必要
function secretKey() {
  if (cachedSecret) return cachedSecret
  const file = path.join(config.DATA_DIR, 'secret.key')
  try {
    const s = fs.readFileSync(file, 'utf8').trim()
    if (s) return (cachedSecret = s)
  } catch {}
  fs.mkdirSync(config.DATA_DIR, { recursive: true })
  const s = crypto.randomBytes(32).toString('hex')
  fs.writeFileSync(file, s, { mode: 0o600 })
  return (cachedSecret = s)
}

function hmac(body) {
  return crypto.createHmac('sha256', secretKey()).update(body).digest('base64url')
}

function issueToken(sub) {
  const payload = { sub, exp: Date.now() + config.SESSION_TTL_DAYS * 86400e3 }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return body + '.' + hmac(body)
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null
  const dot = token.indexOf('.')
  if (dot <= 0) return null
  const body = token.slice(0, dot)
  const sig = token.slice(dot + 1)
  const expect = hmac(body)
  if (sig.length !== expect.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) {
    return null
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'))
    if (!payload.sub || typeof payload.exp !== 'number' || payload.exp < Date.now()) return null
    return payload.sub
  } catch {
    return null
  }
}

function httpsGetJSON(url) {
  return new Promise((resolve, reject) => {
    ;(url.startsWith('http:') ? http : https)
      .get(url, (res) => {
        let d = ''
        res.setEncoding('utf8')
        res.on('data', (c) => (d += c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(d))
          } catch (e) {
            reject(new Error('bad json from weixin'))
          }
        })
      })
      .on('error', reject)
  })
}

// code 换 openid；未配置 AppID/Secret 或失败时返回 null（调用方退化到设备 ID）
async function codeToOpenid(code) {
  if (!config.WX_APPID || !config.WX_APPSECRET || !code) return null
  try {
    const res = await httpsGetJSON(
      `${config.WX_API_BASE}/sns/jscode2session?appid=${encodeURIComponent(config.WX_APPID)}&secret=${encodeURIComponent(config.WX_APPSECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`
    )
    if (res && res.openid) return res.openid
    console.warn('code2session failed:', res && res.errcode, res && res.errmsg)
    return null
  } catch (e) {
    console.warn('code2session error:', e.message)
    return null
  }
}

const DEVICE_ID_RE = /^[\w-]{8,64}$/

// 返回 { sub, kind }；无法建立身份时返回 null。
// 配置了 AppID/Secret 时强制 openid：若允许退回设备 ID，攻击者只要不传 code
// 就能拿到可随意更换的设备身份，openid 风控形同虚设。
async function identityFor(body) {
  const openid = await codeToOpenid(body && body.code)
  if (openid) return { sub: 'o:' + openid, kind: 'openid' }
  if (config.WX_APPID && config.WX_APPSECRET) return null
  const deviceId = body && body.deviceId
  if (typeof deviceId === 'string' && DEVICE_ID_RE.test(deviceId)) {
    return { sub: 'd:' + deviceId, kind: 'device' }
  }
  return null
}

function clientIp(req) {
  if (config.TRUST_PROXY) {
    const fromProxy =
      (req.headers['x-real-ip'] || '').toString().trim() ||
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()
    if (fromProxy) return fromProxy
  }
  return req.socket.remoteAddress || 'unknown'
}

function ipHashOf(req) {
  const ip = clientIp(req)
  return crypto.createHash('sha256').update(ip + secretKey()).digest('hex').slice(0, 24)
}

function bearerToken(req) {
  const h = (req.headers.authorization || '').toString()
  return h.startsWith('Bearer ') ? h.slice(7) : ''
}

module.exports = { issueToken, verifyToken, identityFor, ipHashOf, clientIp, bearerToken, DEVICE_ID_RE }
