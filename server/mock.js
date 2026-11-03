// LLM_MOCK=1 的启发式替身（参考 resume-matcher 的 mock-stages 思路）：
// 联调 UI 和跑单测不花一分钱 API 费。引用一律取原文整行，天然通过第⑥步校验。

const { tokenize } = require('./text')

function splitJD(jdText) {
  const chunks = []
  for (const line of String(jdText || '').split(/\r?\n/)) {
    let t = line.replace(/^\s*(?:[-*•▪◦·]|\d+[.)、])\s*/, '').trim()
    if (!t) continue
    // 薪资/福利/组织信息不是能力要求，不参与打分
    if (/薪资|福利|待遇|五险一金|双休|体检|年假|节日|团建|汇报对象|^部门|编制|职级/.test(t)) continue
    // 章节标题（【个人概述】【岗位职责】等）不是要求
    if (/^【|】\s*$/.test(t)) continue
    // 短行整行保留（'协同设计、研发、测试、运营推进项目上线，把控进度与质量'是一条要求）；
    // 超长行（常见于整段无换行粘贴的 JD）才按句切分
    const pieces = t.length > 60 ? t.split(/[；;。】|，,]/) : [t]
    for (const piece of pieces) {
      const p = piece.trim()
      if (p.length >= 4) chunks.push(p)
    }
  }
  return chunks.slice(0, 20).map((chunk) => {
    const yearsMatch = chunk.match(/(\d+)\s*年/)
    const years = yearsMatch ? parseInt(yearsMatch[1], 10) : null
    let category = 'keywords'
    if (/学历|本科|硕士|大专|博士|统招/.test(chunk)) category = 'education'
    else if (/经验|年限/.test(chunk)) category = 'experience'
    else if (/项目/.test(chunk)) category = 'projects'
    else if (/熟悉|掌握|精通|了解|使用|负责|开发|设计|优化|具备/.test(chunk)) category = 'skills'
    const latin = chunk.match(/[A-Za-z][A-Za-z0-9.+#/-]{1,20}/)
    return {
      text: chunk.slice(0, 80),
      jd_quote: chunk,
      category,
      weight: years ? 1.2 : /必须|优先考虑|加分/.test(chunk) ? 1 : 0.7,
      years,
      skill: category === 'skills' && latin ? latin[0] : null
    }
  })
}

function judgeRequirements(spans, requirements, candidates) {
  return requirements.map((req) => {
    const ids = candidates.get(req.id) || []
    let best = null
    let bestScore = 0
    const reqTokens = new Set(tokenize(req.text))
    for (const id of ids) {
      const span = spans.find((s) => s.id === id)
      if (!span) continue
      const spanTokens = new Set(tokenize(span.text))
      let overlap = 0
      for (const t of reqTokens) if (spanTokens.has(t)) overlap += 1
      if (overlap > bestScore) {
        bestScore = overlap
        best = span
      }
    }
    if (best && bestScore >= 2) {
      const yearsMatch = best.text.match(/(\d+)\s*年/)
      return {
        req_id: req.id,
        verdict: 'hit',
        quote: best.text,
        quote_id: best.id,
        reason: '（mock）找到相关经历片段',
        years_hint: yearsMatch ? parseInt(yearsMatch[1], 10) : undefined
      }
    }
    // 地点类要求特判：'城市：上海' ↔ '工作地点：上海' 只有一个地名重叠也算命中
    if (/地点|城市|base/i.test(req.text)) {
      const meaningful = (s) =>
        tokenize(s).filter((t) => t.length >= 2 && !/^\d+$/.test(t))
      const spanById = new Map(spans.map((s) => [s.id, s]))
      for (const id of ids) {
        const span = spanById.get(id)
        if (!span) continue
        const spanTokens = new Set(meaningful(span.text))
        const shared = meaningful(req.text).filter((t) => spanTokens.has(t))
        if (shared.length > 0) {
          return {
            req_id: req.id,
            verdict: 'hit',
            quote: span.text,
            quote_id: span.id,
            reason: '（mock）地点信息匹配'
          }
        }
      }
    }
    // 学历类要求特判：JD 要'本科及以上'，简历教育经历出现 本科/硕士/博士 即算命中
    if (/学历/.test(req.text)) {
      const m = req.text.match(/(博士|硕士|本科|大专|专科)/)
      if (m) {
        const span = spans.find((s) => s.text.includes(m[1]))
        if (span) {
          return {
            req_id: req.id,
            verdict: 'hit',
            quote: span.text,
            quote_id: span.id,
            reason: '（mock）学历信息匹配'
          }
        }
      }
    }
    return { req_id: req.id, verdict: 'miss', quote: '', quote_id: '', reason: '（mock）未找到相关内容' }
  })
}

function proposeRewrites(requirements, judgments) {
  const out = []
  for (const j of judgments) {
    const req = requirements.find((r) => r.id === j.reqId)
    if (!req) continue
    if (j.verdict === 'partial' && j.quote) {
      out.push({
        req_id: req.id,
        type: 'improve',
        original: j.quote,
        rewrite: `${j.quote}（建议：对齐 JD 中「${req.text}」的表述，并补充可量化的结果数据）`,
        note: '（mock）改写建议'
      })
    } else if (j.verdict === 'miss') {
      out.push({
        req_id: req.id,
        type: 'add',
        original: '',
        rewrite: `建议新增一条经历：围绕「${req.text}」补一段真实项目描述，包含做了什么、用了什么技术、结果如何（附数据）。`,
        note: '（mock）缺失项补写方向'
      })
    }
  }
  return out.slice(0, 8)
}

module.exports = { splitJD, judgeRequirements, proposeRewrites }
