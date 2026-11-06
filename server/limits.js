// 风控层（纯函数，db 注入，可单测）：
//   分析：身份日限 + 身份 10 分钟限 + IP 日限 + IP 10 分钟限 + 全站日限
//   复制：身份日限（每人每天 3 条改写句；同一条重复复制不重复计数）
//   PDF 解析：身份 10 分钟限 + 日限（CPU 密集，防刷）
// 日限按自然日（本地时区）计，10 分钟窗按滚动窗口计。

const config = require('./config')

const DAY_MS = 86400e3
const TEN_MIN_MS = 600e3

function dayStart(now) {
  const d = new Date(now)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function count(db, filter, since) {
  return db.countUsage(filter, since)
}

/**
 * 分析请求的风控检查。返回 { ok:true } 或 { ok:false, code, message }。
 * 检查顺序：全站日限 → 滚动 10 分钟窗（IP、身份）→ 日限（IP、身份）。
 * 窗口限先于日限：连刷场景提示"稍后再试"，额度真正耗尽才提示"明天再来"。
 */
function checkAnalyze(db, owner, ipHash, now = Date.now(), cfg = config) {
  const today = dayStart(now)
  const tenMinAgo = now - TEN_MIN_MS

  const globalDay = count(db, { kind: 'analyze' }, today)
  if (globalDay >= cfg.GLOBAL_DAILY_CAP) {
    return { ok: false, code: 'GLOBAL_LIMITED', message: '今日全站分析次数已达上限，明天再来吧' }
  }
  const ipTen = count(db, { kind: 'analyze', ipHash }, tenMinAgo)
  if (ipTen >= cfg.ANALYZE_PER_IP_PER_10MIN) {
    return { ok: false, code: 'RATE_LIMITED', message: '操作太频繁，请 10 分钟后再试' }
  }
  const idTen = count(db, { kind: 'analyze', owner }, tenMinAgo)
  if (idTen >= cfg.ANALYZE_PER_IDENTITY_PER_10MIN) {
    return { ok: false, code: 'RATE_LIMITED', message: '操作太频繁，请 10 分钟后再试' }
  }
  const ipDay = count(db, { kind: 'analyze', ipHash }, today)
  if (ipDay >= cfg.ANALYZE_PER_IP_PER_DAY) {
    return { ok: false, code: 'IP_LIMITED', message: '当前网络今日分析次数已用完，换个网络或明天再来' }
  }
  const idDay = count(db, { kind: 'analyze', owner }, today)
  if (idDay >= cfg.ANALYZE_PER_IDENTITY_PER_DAY) {
    return { ok: false, code: 'QUOTA_EXCEEDED', message: `今日免费分析次数已用完（每天 ${cfg.ANALYZE_PER_IDENTITY_PER_DAY} 次），明天再来` }
  }
  return { ok: true }
}

/**
 * 复制改写句的检查。返回 { ok, remaining } 或 { ok:false, code, message }。
 */
function checkCopy(db, owner, now = Date.now(), cfg = config) {
  const used = count(db, { kind: 'copy', owner }, dayStart(now))
  const limit = cfg.COPY_PER_IDENTITY_PER_DAY
  if (used >= limit) {
    return { ok: false, code: 'COPY_LIMIT', message: `今天已复制 ${limit} 条改写句，明天再来（复制不限内容展示，仅限一键复制）` }
  }
  return { ok: true, remaining: limit - used - 1, used, limit }
}

/** PDF 解析限次。返回 { ok:true } 或 { ok:false, code, message }。 */
function checkPdf(db, owner, now = Date.now(), cfg = config) {
  const ten = count(db, { kind: 'pdf', owner }, now - TEN_MIN_MS)
  if (ten >= cfg.PDF_PER_IDENTITY_PER_10MIN) {
    return { ok: false, code: 'RATE_LIMITED', message: '解析太频繁，请 10 分钟后再试，或直接粘贴文本' }
  }
  const day = count(db, { kind: 'pdf', owner }, dayStart(now))
  if (day >= cfg.PDF_PER_IDENTITY_PER_DAY) {
    return { ok: false, code: 'PDF_LIMIT', message: '今日 PDF 解析次数已用完，请直接粘贴文本' }
  }
  return { ok: true }
}

/**
 * 内容安全拦截后的试探限制：10 分钟内被拦次数达上限（身份或 IP 任一）即拒。
 * 被拦截的提交不扣分析次数，没有这道闸就能无限次换说法试探词库 / 刷微信接口。
 */
function checkBlocked(db, owner, ipHash, now = Date.now(), cfg = config) {
  const since = now - TEN_MIN_MS
  const max = cfg.MODERATION_BLOCKS_PER_10MIN
  if (count(db, { kind: 'blocked', owner }, since) >= max || count(db, { kind: 'blocked', ipHash }, since) >= max) {
    return { ok: false, code: 'RATE_LIMITED', message: '操作太频繁，请 10 分钟后再试' }
  }
  return { ok: true }
}

/** 本地时区的 YYYY-MM-DD（与日限的自然日口径一致；toISOString 是 UTC，凌晨会差一天）。 */
function localDateKey(now) {
  const d = new Date(now)
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function quotaInfo(db, owner, ipHash, now = Date.now(), cfg = config) {
  const today = dayStart(now)
  const analyzeUsed = count(db, { kind: 'analyze', owner }, today)
  const copyUsed = count(db, { kind: 'copy', owner }, today)
  return {
    analyze: {
      used: analyzeUsed,
      limit: cfg.ANALYZE_PER_IDENTITY_PER_DAY,
      remaining: Math.max(0, cfg.ANALYZE_PER_IDENTITY_PER_DAY - analyzeUsed)
    },
    copies: {
      used: copyUsed,
      limit: cfg.COPY_PER_IDENTITY_PER_DAY,
      remaining: Math.max(0, cfg.COPY_PER_IDENTITY_PER_DAY - copyUsed)
    },
    dateKey: localDateKey(now)
  }
}

module.exports = { checkAnalyze, checkCopy, checkPdf, checkBlocked, quotaInfo, dayStart, localDateKey, DAY_MS }
