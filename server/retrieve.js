// 步骤④：证据检索（纯代码，不用向量库）。
// 技能别名精确命中优先，其次词元重叠。检索为空也继续，由判定阶段判 miss。

const config = require('./config')
const { aliasesOf } = require('./skills')
const { containsTerm, tokenize } = require('./text')

const STOPWORDS = new Set(
  ('a an and the of to in with for on or at by as is are be have has ' +
    'experience years year strong ability work working using ' +
    '的 了 和 与 或 及 等 优先 负责 具有 熟悉 精通 了解 掌握').split(' ')
)

function retrieveCandidates(req, spans) {
  const skillTerms = req.skill ? aliasesOf(req.skill) : []
  const reqTokens = new Set(tokenize(req.text).filter((t) => !STOPWORDS.has(t)))

  const scored = spans.map((span) => {
    const skillHit = skillTerms.some((t) => containsTerm(span.text, t)) ? 10 : 0
    const spanTokens = new Set(tokenize(span.text))
    let overlap = 0
    for (const t of reqTokens) if (spanTokens.has(t)) overlap += 1
    return { id: span.id, score: skillHit + overlap }
  })

  return scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id, 'en', { numeric: true }))
    .slice(0, config.TOP_K)
    .map((s) => s.id)
}

module.exports = { retrieveCandidates, STOPWORDS }
