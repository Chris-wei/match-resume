// 反馈记录（纯函数，只改传入的 data）：每个用户 × 每份报告一条，整份反馈与逐条判错合在一起。
//   { owner, reportId, q1, q2, comment, wrongItems: [{ reqId, at }], createdAt, updatedAt }
// 一旦产生反馈，报告置 retained=true（长期保留，见 retention.js）；取消标记不回退。

function findOrCreate(data, owner, reportId, now) {
  let doc = data.feedback.find((f) => f.owner === owner && f.reportId === reportId)
  if (!doc) {
    doc = { owner, reportId, q1: '', q2: '', comment: '', wrongItems: [], createdAt: now, updatedAt: now }
    data.feedback.push(doc)
  }
  if (!Array.isArray(doc.wrongItems)) doc.wrongItems = []
  return doc
}

function markRetained(data, reportId) {
  const report = data.reports.find((r) => r.reportId === reportId)
  if (report) report.retained = true
}

/** 整份反馈：合并到已有记录，不动 wrongItems。调用方负责留言脱敏。 */
function saveForm(data, owner, reportId, { q1, q2, comment }, now) {
  const doc = findOrCreate(data, owner, reportId, now)
  doc.q1 = q1
  doc.q2 = q2
  doc.comment = comment
  doc.updatedAt = now
  markRetained(data, reportId)
  return doc
}

/** 逐条判错：wrong=true 标记（幂等），false 取消。返回当前判错的 reqId 列表。 */
function setWrong(data, owner, reportId, reqId, wrong, now) {
  const doc = findOrCreate(data, owner, reportId, now)
  const has = doc.wrongItems.some((w) => w.reqId === reqId)
  if (wrong && !has) doc.wrongItems.push({ reqId, at: now })
  if (!wrong && has) doc.wrongItems = doc.wrongItems.filter((w) => w.reqId !== reqId)
  doc.updatedAt = now
  markRetained(data, reportId)
  return doc.wrongItems.map((w) => w.reqId)
}

function wrongIds(data, owner, reportId) {
  const doc = data.feedback.find((f) => f.owner === owner && f.reportId === reportId)
  return doc && Array.isArray(doc.wrongItems) ? doc.wrongItems.map((w) => w.reqId) : []
}

module.exports = { saveForm, setWrong, wrongIds }
