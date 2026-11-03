// 步骤③：JD 拆原子要求（LLM + 输出规整 + 失败重试）。
// 引用是否真的在 JD 里由 verify.js 把关，这里只做结构校验。

const fs = require('fs')
const path = require('path')
const config = require('./config')
const { chatJSON, withShapeRetry } = require('./llm')
const mock = require('./mock')

const SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'jd-split.txt'), 'utf8')
const CATEGORIES = ['skills', 'experience', 'projects', 'education', 'keywords']

function normalizeRequirements(out) {
  const list = out && Array.isArray(out.requirements) ? out.requirements : null
  if (!list) throw new Error('JD_SPLIT_BAD_SHAPE')
  const norm = []
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const text = typeof r.text === 'string' ? r.text.trim() : ''
    const jdQuote = typeof r.jd_quote === 'string' ? r.jd_quote.trim() : ''
    if (!text || !jdQuote) continue
    let weight = Number(r.weight)
    if (!isFinite(weight)) weight = 1
    weight = Math.min(1.5, Math.max(0.5, weight))
    let years = Number(r.years)
    years = isFinite(years) && years > 0 ? Math.min(40, Math.round(years)) : null
    norm.push({
      text: text.slice(0, 120),
      jd_quote: jdQuote.slice(0, 200),
      category: CATEGORIES.includes(r.category) ? r.category : 'keywords',
      weight,
      years,
      skill: typeof r.skill === 'string' && r.skill.trim() ? r.skill.trim().slice(0, 40) : null
    })
  }
  if (norm.length === 0) throw new Error('JD_SPLIT_EMPTY')
  return norm.slice(0, config.MAX_REQUIREMENTS)
}

async function splitJD(jdText, { deadline } = {}) {
  if (config.LLM_MOCK) return mock.splitJD(jdText)
  return withShapeRetry(
    async () =>
      normalizeRequirements(
        await chatJSON({
          system: SYSTEM,
          user: `<job_description>\n${jdText}\n</job_description>`,
          maxTokens: 3000,
          deadline
        })
      ),
    config.MAX_JUDGMENT_RETRY,
    'JD_SPLIT_FAILED'
  )
}

module.exports = { splitJD, normalizeRequirements }
