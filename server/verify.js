// 步骤⑥：引用校验（纯代码）。这是整个产品的护城河——
// LLM 的每条判断必须能在原文里逐字找到引用，找不到就降级 unclear，绝不回退给模型圆谎。

const { locateQuote } = require('./text')

// ---- JD 拆解校验：jd_quote 必须真的在 JD 里，否则拒收这条要求 ----
function verifyRequirements(jdText, rawRequirements, rejections) {
  const requirements = []
  for (const r of rawRequirements) {
    if (!r || typeof r.text !== 'string' || !r.text.trim()) continue
    const loc = typeof r.jd_quote === 'string' ? locateQuote(r.jd_quote, jdText) : null
    if (!loc) {
      rejections.push({ stage: 'jd', reason: 'jd_quote 未在 JD 原文中找到', text: r.text })
      continue
    }
    requirements.push({
      id: 'R' + (requirements.length + 1),
      text: r.text.trim().slice(0, 120),
      // 存原文切片，不存模型抄写版本；模糊命中时存最相似的整句
      jdQuote: loc.text,
      jdQuoteFuzzy: !loc.exact,
      category: r.category,
      weight: r.weight,
      years: r.years || null,
      skill: r.skill || null
    })
  }
  return requirements
}

// ---- 判定校验：quote 必须逐字出现在 quote_id 指向的片段里 ----
// hit/partial 失去有效证据 → 整条降级 unclear（前端灰显，提示自行核对）。
// failedReqIds：判定批次失败的要求，标"待核对"而不是"模型未返回"
function verifyJudgments(requirements, spans, rawJudgments, rejections, failedReqIds) {
  const failed = new Set(failedReqIds || [])
  const spanById = new Map(spans.map((s) => [s.id, s]))
  const rawById = new Map(
    (rawJudgments || []).filter((j) => j && j.req_id).map((j) => [j.req_id, j])
  )

  return requirements.map((req) => {
    const j = rawById.get(req.id)
    if (!j) {
      const judgeFailed = failed.has(req.id)
      return {
        reqId: req.id,
        verdict: 'unclear',
        quoteId: '',
        quote: '',
        reason: judgeFailed ? '这条暂时没判出来（服务波动），请自行核对' : '模型未返回该条判定，请自行核对',
        yearsHint: null,
        flags: [judgeFailed ? 'judge_failed' : 'no_judgment']
      }
    }

    const flags = []
    let verdict = j.verdict
    let quoteId = ''
    let quote = ''

    if (typeof j.quote === 'string' && j.quote.trim() && typeof j.quote_id === 'string') {
      const span = spanById.get(j.quote_id)
      const loc = span ? locateQuote(j.quote, span.text) : null
      if (loc) {
        quoteId = j.quote_id
        // 展示从简历片段里切出来的原文；模糊命中（模型抄写有漂移）时展示整行并打标
        quote = loc.exact ? loc.text : span.text
        if (!loc.exact) flags.push('fuzzy_quote')
      } else {
        rejections.push({
          stage: 'judge',
          reason: '证据引用未在简历片段中找到',
          detail: { req: req.id, quote_id: j.quote_id }
        })
        flags.push('evidence_rejected')
      }
    }

    // miss/unclear 不允许携带证据；hit/partial 没有有效证据则降级
    if (verdict === 'miss' || verdict === 'unclear') {
      quoteId = ''
      quote = ''
    } else if ((verdict === 'hit' || verdict === 'partial') && !quoteId) {
      verdict = 'unclear'
      flags.push('downgraded_no_evidence')
    }

    let yearsHint = null
    if (typeof j.years_hint === 'number' && isFinite(j.years_hint) && j.years_hint >= 0) {
      yearsHint = Math.min(45, j.years_hint)
    }

    return {
      reqId: req.id,
      verdict,
      quoteId,
      quote,
      reason: typeof j.reason === 'string' ? j.reason.trim().slice(0, 160) : '',
      yearsHint,
      flags
    }
  })
}

module.exports = { verifyRequirements, verifyJudgments }
