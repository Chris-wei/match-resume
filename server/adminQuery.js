// 后台查询（纯函数，只读 data）：汇总、反馈列表（筛选 + 分页）、报告详情。
// 一行 = 一份报告（每份报告只有一个 owner，至多一条反馈记录）。
// 返回给后台的数据一律去掉 owner / inputHash（后台优化不需要知道是谁）。

const { versionTag } = require('./versions')

const DAY_MS = 86400e3
const PAGE_SIZE = 50
const Q1_VALUES = ['accurate', 'partial', 'inaccurate']

/** ok | expired | deleted | missing（deleted 优先于 expired） */
function reportStatus(report, now) {
  if (!report) return 'missing'
  if (report.deletedByUser) return 'deleted'
  if (report.expiresAt < now) return 'expired'
  return 'ok'
}

const updatedAtOf = (f) => f.updatedAt || f.createdAt || 0
const q1Of = (f) => (Q1_VALUES.includes(f.q1) ? f.q1 : 'none')
const wrongCountOf = (f) => (Array.isArray(f.wrongItems) ? f.wrongItems.length : 0)

function summary(data, now) {
  const q1 = { accurate: 0, partial: 0, inaccurate: 0, none: 0 }
  let last7d = 0
  let wrongItems = 0
  for (const f of data.feedback) {
    q1[q1Of(f)]++
    if (updatedAtOf(f) >= now - 7 * DAY_MS) last7d++
    wrongItems += wrongCountOf(f)
  }
  return { total: data.feedback.length, last7d, q1, wrongItems }
}

function list(data, filters = {}, now) {
  const reportById = new Map(data.reports.map((r) => [r.reportId, r]))
  const all = data.feedback.map((f) => {
    const r = reportById.get(f.reportId) || null
    return {
      reportId: f.reportId,
      updatedAt: updatedAtOf(f),
      q1: q1Of(f),
      q2: f.q2 || '',
      comment: f.comment || '',
      wrongCount: wrongCountOf(f),
      score: r && r.score ? r.score.overall : null,
      conclusion: r ? r.conclusion || '' : null,
      status: reportStatus(r, now),
      version: versionTag(r && r.meta)
    }
  })
  const versions = [...new Set(all.map((x) => x.version))].sort()

  const { q1 = 'all', hasWrong, hasComment, version } = filters
  const rows = all
    .filter((x) => q1 === 'all' || x.q1 === q1)
    .filter((x) => !hasWrong || x.wrongCount > 0)
    .filter((x) => !hasComment || x.comment)
    .filter((x) => !version || x.version === version)
    .sort((a, b) => b.updatedAt - a.updatedAt)

  const page = Math.max(1, parseInt(filters.page, 10) || 1)
  return { rows: rows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: rows.length, page, pageSize: PAGE_SIZE, versions }
}

function detail(data, reportId, now) {
  const r = data.reports.find((x) => x.reportId === reportId) || null
  const f = data.feedback.find((x) => x.reportId === reportId) || null
  if (!r && !f) return null
  let feedback = null
  if (f) {
    const { owner, ...rest } = f
    feedback = rest
  }
  if (!r) return { status: 'missing', report: null, feedback }
  const { owner, inputHash, ...report } = r
  report.versionTag = versionTag(r.meta)
  return { status: reportStatus(r, now), report, feedback }
}

module.exports = { reportStatus, summary, list, detail, PAGE_SIZE }
