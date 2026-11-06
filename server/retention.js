// 数据生命周期（纯函数，只改传入的 data，不碰磁盘；db.js 负责调用后落盘）：
//   - 迁移：老数据补齐新字段（启动时、prune 之前执行，幂等）
//   - 清理：无反馈的报告过期删除；有反馈的报告（retained）过期不删，但断开与用户的关联
//   - 用户删除：无反馈 → 彻底删；有反馈 → 脱敏留存（删简历内容与用户关联，留 JD 要求/判定/理由/分数/反馈）
// 设计文档：docs/superpowers/specs/2026-11-05-admin-feedback-design.md §3

const { redact } = require('./redact')

const DAY_MS = 86400e3

const feedbackOf = (data, reportId) => data.feedback.filter((f) => f.reportId === reportId)

/** 老数据补齐：有反馈的报告补 retained；反馈补 wrongItems / updatedAt；旧留言补脱敏。返回变更条数。 */
function migrate(data) {
  let changed = 0
  const withFeedback = new Set(data.feedback.map((f) => f.reportId))
  for (const r of data.reports) {
    if (withFeedback.has(r.reportId) && r.retained !== true) {
      r.retained = true
      changed++
    }
  }
  for (const f of data.feedback) {
    let touched = false
    if (!Array.isArray(f.wrongItems)) {
      f.wrongItems = []
      touched = true
    }
    if (!f.updatedAt) {
      f.updatedAt = f.createdAt
      touched = true
    }
    if (typeof f.comment === 'string' && f.comment) {
      const clean = redact(f.comment)
      if (clean !== f.comment) {
        f.comment = clean
        touched = true
      }
    }
    if (touched) changed++
  }
  changed += unlinkOrphanFeedback(data)
  return changed
}

/** 断开报告（及其反馈、复制计数里的报告引用）与用户的关联 */
function unlink(data, report) {
  report.owner = ''
  report.inputHash = ''
  for (const f of feedbackOf(data, report.reportId)) f.owner = ''
  const prefix = report.reportId + '#'
  for (const u of data.usage) if (typeof u.ref === 'string' && u.ref.startsWith(prefix)) delete u.ref
}

/** 报告已不存在的反馈（上线前就被删掉的老报告）：断开与用户的关联。返回处理条数 */
function unlinkOrphanFeedback(data) {
  const ids = new Set(data.reports.map((r) => r.reportId))
  let n = 0
  for (const f of data.feedback) {
    if (f.owner && !ids.has(f.reportId)) {
      f.owner = ''
      n++
    }
  }
  return n
}

/**
 * 过期清理。返回 { removed, unlinked }。
 * 反馈记录不再按时间清理（跟随报告长期保留，含报告早已不存在的老反馈）。
 */
function prune(data, now, cfg) {
  const reportCut = now - cfg.REPORT_TTL_DAYS * DAY_MS
  const recordCut = now - cfg.RECORD_TTL_DAYS * DAY_MS
  const jdCut = now - cfg.JD_CACHE_TTL_DAYS * DAY_MS
  let removed = 0
  let unlinked = 0
  data.reports = data.reports.filter((r) => {
    const expired = r.createdAt <= reportCut || r.expiresAt < now
    if (!expired) return true
    if (!r.retained) {
      removed++
      return false
    }
    if (r.owner) {
      unlink(data, r)
      unlinked++
    }
    return true
  })
  unlinked += unlinkOrphanFeedback(data)
  data.usage = data.usage.filter((u) => u.createdAt > recordCut)
  data.jdCache = data.jdCache.filter((c) => c.createdAt > jdCut)
  return { removed, unlinked }
}

/** 用户删除报告。不是该用户的报告返回 false。 */
function deleteReport(data, reportId, owner, now) {
  const report = data.reports.find((r) => r.reportId === reportId && r.owner === owner && owner)
  if (!report) return false
  if (!report.retained) {
    data.reports = data.reports.filter((r) => r !== report)
    return true
  }
  // 脱敏留存：删掉一切来自简历的内容
  delete report.spans
  report.rewrites = []
  report.rewritesStatus = 'none'
  for (const j of report.judgments || []) {
    j.quote = ''
    j.quoteId = ''
  }
  report.deletedByUser = true
  report.deletedAt = now
  unlink(data, report)
  return true
}

module.exports = { migrate, prune, deleteReport }
