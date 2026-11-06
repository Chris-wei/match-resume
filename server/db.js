// JSON 文件存储（本地开发用，零依赖）。
// 集合：reports（脱敏报告，30 天过期）/ usage（限流计数）/ feedback（反馈）/ jdCache（JD 拆解缓存）。
// 简历以"脱敏后的行"形式存在报告里（供引用上下文），不存未脱敏原文。
//
// 写入策略：内存为准，落盘合并（SAVE_DEBOUNCE_MS 内的多次修改只写一次文件，
// 用 tmp+rename 原子替换）；进程退出时同步 flush。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('./config')
const retention = require('./retention')
const feedback = require('./feedback')

const FILE = path.join(config.DATA_DIR, 'db.json')
const SAVE_DEBOUNCE_MS = 200
const JD_CACHE_MAX = 500

let data = { reports: [], usage: [], feedback: [], jdCache: [] }

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    if (parsed && Array.isArray(parsed.reports)) data = parsed
  } catch {
    // 首次运行没有文件，用默认空结构
  }
  for (const k of ['reports', 'usage', 'feedback', 'jdCache']) if (!Array.isArray(data[k])) data[k] = []
  fs.mkdirSync(config.DATA_DIR, { recursive: true })
}
load()

let saveTimer = null

function flush() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const tmp = FILE + '.tmp'
  fs.writeFileSync(tmp, JSON.stringify(data))
  fs.renameSync(tmp, FILE)
}

function save() {
  if (saveTimer) return
  saveTimer = setTimeout(() => {
    saveTimer = null
    try {
      flush()
    } catch (e) {
      console.error('db save failed:', e.message)
    }
  }, SAVE_DEBOUNCE_MS)
  // 不因为待写入的定时器阻止进程退出（退出时由 exit 钩子 flush）
  if (saveTimer.unref) saveTimer.unref()
}

// 进程退出前把没落盘的修改写掉
let exitHooked = false
function hookExit() {
  if (exitHooked) return
  exitHooked = true
  process.on('exit', () => {
    if (saveTimer) flush()
  })
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.once(sig, () => {
      if (saveTimer) flush()
      process.exit(0)
    })
  }
}
hookExit()

function newId(prefix) {
  return prefix + crypto.randomBytes(8).toString('hex')
}

function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex')
}

// ---------------- reports ----------------

function getReport(reportId) {
  return data.reports.find((r) => r.reportId === reportId) || null
}

function reportsByOwner(owner, now = Date.now()) {
  return data.reports
    .filter((r) => r.owner === owner && !(r.expiresAt < now))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, 10)
}

/** 同一身份、同一输入（哈希）且未过期的报告：重复提交直接复用，不再扣次数。 */
function findReportByInput(owner, inputHash, now = Date.now()) {
  return (
    data.reports
      .filter((r) => r.owner === owner && r.inputHash === inputHash && !(r.expiresAt < now))
      .sort((a, b) => b.createdAt - a.createdAt)[0] || null
  )
}

function insertReport(doc) {
  data.reports.push(doc)
  save()
}

// 用户删除：无反馈的报告彻底删除；有反馈的报告脱敏留存（retention.deleteReport）
function removeReport(reportId, owner, now = Date.now()) {
  const removed = retention.deleteReport(data, reportId, owner, now)
  if (removed) save()
  return removed
}

function updateReport(reportId, owner, patch) {
  const doc = getReport(reportId)
  if (!doc || doc.owner !== owner) return false
  Object.assign(doc, patch)
  save()
  return true
}

// ---------------- usage（限流计数）----------------

function countUsage(filter, since) {
  return data.usage.filter(
    (u) => u.kind === filter.kind && u.createdAt >= since &&
      (!filter.owner || u.owner === filter.owner) &&
      (!filter.ipHash || u.ipHash === filter.ipHash) &&
      (!filter.ref || u.ref === filter.ref)
  ).length
}

// 返回记录 id。opts.pending=true 表示"预占"：分析开始时先占额度（并发请求能看到），
// 成功后 confirmUsage 转正，失败时 removeUsage 退还；进程重启时残留的预占会被清掉。
// opts.ref 用于去重（如同一份报告的同一条改写句重复复制只计一次）。
function recordUsage(kind, owner, ipHash, now, opts = {}) {
  const id = newId('u')
  const row = { id, kind, owner, ipHash, createdAt: now }
  if (opts.ref) row.ref = opts.ref
  if (opts.pending) row.pending = true
  data.usage.push(row)
  save()
  return id
}

function confirmUsage(id) {
  const row = data.usage.find((u) => u.id === id)
  if (row && row.pending) {
    delete row.pending
    save()
  }
}

function removeUsage(id) {
  const before = data.usage.length
  data.usage = data.usage.filter((u) => u.id !== id)
  if (data.usage.length !== before) save()
}

/** 启动时调用：上次进程中途退出留下的预占记录，对应的分析已不可能完成，退还给用户。 */
function releasePendingUsage() {
  const before = data.usage.length
  data.usage = data.usage.filter((u) => !u.pending)
  const n = before - data.usage.length
  if (n) save()
  return n
}

// ---------------- feedback ----------------

// 反馈逻辑见 feedback.js（整份反馈合并保存，不覆盖逐条判错）
function saveFeedbackForm(owner, reportId, form, now = Date.now()) {
  const doc = feedback.saveForm(data, owner, reportId, form, now)
  save()
  return doc
}

function setWrongItem(owner, reportId, reqId, wrong, now = Date.now()) {
  const ids = feedback.setWrong(data, owner, reportId, reqId, wrong, now)
  save()
  return ids
}

function wrongItemsOf(owner, reportId) {
  return feedback.wrongIds(data, owner, reportId)
}

// ---------------- JD 拆解缓存 ----------------
// key = hash(模型 + JD 文本)。同一份 JD 被多人/多版简历分析时，省掉一轮串行 LLM 调用，
// 也让同一份 JD 下各报告的要求列表一致、可横向比较。

function getJdCache(key, now = Date.now()) {
  const hit = data.jdCache.find((c) => c.key === key)
  if (!hit) return null
  if (now - hit.createdAt > config.JD_CACHE_TTL_DAYS * 86400e3) return null
  hit.lastUsedAt = now
  return hit.requirements
}

function setJdCache(key, requirements, now = Date.now()) {
  data.jdCache = data.jdCache.filter((c) => c.key !== key)
  data.jdCache.push({ key, requirements, createdAt: now, lastUsedAt: now })
  if (data.jdCache.length > JD_CACHE_MAX) {
    data.jdCache.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
    data.jdCache.length = JD_CACHE_MAX
  }
  save()
}

// 过期清理：启动时（migrate 之后）+ 每天调用一次。返回删除的报告数
function prune(now) {
  const { removed, unlinked } = retention.prune(data, now, config)
  if (removed || unlinked) save()
  return removed
}

// 老数据补齐新字段：启动时必须在 prune 之前调用（否则有反馈的老报告会被当成无反馈删掉）
function migrate() {
  const n = retention.migrate(data)
  if (n) save()
  return n
}

module.exports = {
  get data() {
    return data
  },
  save,
  flush,
  newId,
  sha256,
  getReport,
  reportsByOwner,
  findReportByInput,
  insertReport,
  removeReport,
  updateReport,
  countUsage,
  recordUsage,
  confirmUsage,
  removeUsage,
  releasePendingUsage,
  saveFeedbackForm,
  setWrongItem,
  wrongItemsOf,
  getJdCache,
  setJdCache,
  prune,
  migrate
}
