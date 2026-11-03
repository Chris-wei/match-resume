// 步骤⑦：确定性打分（纯代码）。同一份输入永远同一个分，不受模型随机性影响。
// 设计文档 §3.4 算法 + resume-matcher 的类别权重思想。

const config = require('./config')

/**
 * 单条要求的命中度 0~1。
 * hit 且 JD 有年限要求：按 yearsHint/reqYears 比例打折；
 * yearsHint 缺失时不惩罚（判 hit 说明证据明确，只是年限未知，标记 years_unverified）。
 */
function hitScore(verdict, yearsHint, req) {
  const s = config.STATUS_SCORE
  if (verdict === 'miss') return { score: s.miss, flags: [] }
  if (verdict === 'unclear') return { score: s.unclear, flags: [] }
  if (verdict === 'partial') return { score: s.partial, flags: [] }
  if (verdict === 'hit') {
    if (req.years && req.years > 0) {
      if (yearsHint == null) return { score: s.hit, flags: ['years_unverified'] }
      return { score: Math.min(1, yearsHint / req.years), flags: [] }
    }
    return { score: s.hit, flags: [] }
  }
  return { score: 0, flags: ['bad_verdict'] }
}

function scoreMatch(requirements, judgments) {
  const byReq = new Map(judgments.map((j) => [j.reqId, j]))
  const items = requirements.map((req) => {
    const j = byReq.get(req.id) || {
      reqId: req.id,
      verdict: 'unclear',
      quoteId: '',
      quote: '',
      reason: '',
      yearsHint: null,
      flags: ['no_judgment']
    }
    const { score, flags } = hitScore(j.verdict, j.yearsHint, req)
    return { req, judgment: j, score, flags }
  })

  // 加权总分
  let total = 0
  let weightSum = 0
  for (const item of items) {
    const w = item.req.weight * (config.CATEGORY_FACTOR[item.req.category] != null
      ? config.CATEGORY_FACTOR[item.req.category]
      : 1)
    total += item.score * w
    weightSum += w
  }
  let overall = weightSum === 0 ? 0 : Math.round((total / weightSum) * 100)

  // 硬门槛封顶（设计文档 §3.4）：JD 明确要求年限（≥HARD_GATE_MIN_YEARS）的经验项被判 miss。
  // 目前只有年限门槛；学历不设硬门槛（学历要求常是“本科及以上”这类软性表述）
  const failedHardGates = items
    .filter(
      (i) =>
        i.req.weight >= 1 &&
        i.req.category === 'experience' &&
        i.req.years >= config.HARD_GATE_MIN_YEARS &&
        i.judgment.verdict === 'miss'
    )
    .map((i) => i.req.id)
  const capped = failedHardGates.length > 0 && overall > config.HARD_GATE_CAP
  if (capped) overall = config.HARD_GATE_CAP

  // 雷达图：按类别求平均
  const radar = config.RADAR_CATEGORIES.map((category) => {
    const catItems = items.filter((i) => i.req.category === category)
    const value =
      catItems.length === 0
        ? 0
        : Math.round((catItems.reduce((sum, i) => sum + i.score, 0) / catItems.length) * 100)
    return { category, value, count: catItems.length }
  })

  return { overall, capped, failedHardGates, radar, items }
}

module.exports = { scoreMatch, hitScore }
