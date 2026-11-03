// 步骤⑦-改写：分析时同步生成（第一版免费）。LLM 只负责措辞，铁律在 prompt 里；
// improve 类的原句必须与判定时保存的引用对得上，否则丢弃该条建议。

const fs = require('fs')
const path = require('path')
const config = require('./config')
const { chatJSON } = require('./llm')
const { quoteMatches } = require('./text')
const mock = require('./mock')

const SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'rewrite.txt'), 'utf8')

const MAX_REWRITES = 8

async function proposeRewrites(requirements, judgments, { deadline } = {}) {
  const reqById = new Map(requirements.map((r) => [r.id, r]))
  const targets = judgments
    .filter((j) => j.verdict === 'partial' || j.verdict === 'miss')
    .slice(0, MAX_REWRITES)

  let list
  if (config.LLM_MOCK) {
    list = mock.proposeRewrites(requirements, judgments)
  } else {
    const lines = targets
      .map((j) => {
        const r = reqById.get(j.reqId)
        if (!r) return ''
        if (j.verdict === 'partial') {
          return `${j.reqId} [partial] 要求: ${r.text}\n  简历原句: ${j.quote}`
        }
        return `${j.reqId} [miss] 要求: ${r.text}\n  简历中缺失`
      })
      .filter(Boolean)
      .join('\n')
    if (!lines) return []

    const out = await chatJSON({ system: SYSTEM, user: lines, maxTokens: 3000, deadline })
    list = out && Array.isArray(out.rewrites) ? out.rewrites : []
  }

  const out = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const req = reqById.get(item.req_id)
    const rewrite = typeof item.rewrite === 'string' ? item.rewrite.trim() : ''
    if (!req || !rewrite || rewrite.length > 400) continue
    const j = judgments.find((x) => x.reqId === item.req_id)
    const type = j && j.quote && item.type !== 'add' ? 'improve' : 'add'
    let original = typeof item.original === 'string' ? item.original.trim() : ''
    if (type === 'improve') {
      if (!j || !j.quote || !quoteMatches(original || j.quote, j.quote)) original = j ? j.quote : ''
      if (!original) continue
    } else {
      original = ''
    }
    out.push({
      reqId: item.req_id,
      type,
      original,
      rewrite,
      note: typeof item.note === 'string' ? item.note.trim().slice(0, 120) : ''
    })
  }
  return out.slice(0, MAX_REWRITES)
}

module.exports = { proposeRewrites }
