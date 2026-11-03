// 步骤⑤：逐条判定（LLM，按批次并行）。引用校验在 verify.js，本模块只做结构规整。

const fs = require('fs')
const path = require('path')
const config = require('./config')
const { chatJSON, withShapeRetry, listFrom } = require('./llm')
const { renderSpans } = require('./segment')
const mock = require('./mock')

const SYSTEM = fs.readFileSync(path.join(__dirname, 'prompts', 'judge.txt'), 'utf8')
const VERDICTS = ['hit', 'partial', 'miss', 'unclear']

/** 判定用的模型：LLM_JUDGE_MODEL 优先，否则沿用主模型 */
const judgeModel = () => config.LLM_JUDGE_MODEL || config.LLM_MODEL

function normalizeJudgments(out) {
  const list = listFrom(out, 'judgments')
  if (!list) throw new Error('JUDGE_BAD_SHAPE')
  const norm = []
  for (const j of list) {
    if (!j || typeof j !== 'object' || typeof j.req_id !== 'string') continue
    let yearsHint = Number(j.years_hint)
    yearsHint = isFinite(yearsHint) && yearsHint > 0 ? Math.min(45, yearsHint) : null
    norm.push({
      req_id: j.req_id,
      verdict: VERDICTS.includes(j.verdict) ? j.verdict : 'unclear',
      quote: typeof j.quote === 'string' ? j.quote.trim().slice(0, 300) : '',
      quote_id: typeof j.quote_id === 'string' ? j.quote_id.trim() : '',
      reason: typeof j.reason === 'string' ? j.reason.trim().slice(0, 160) : '',
      years_hint: yearsHint
    })
  }
  if (norm.length === 0) throw new Error('JUDGE_EMPTY')
  return norm
}

async function judgeBatch(spansContext, batchLines, deadline) {
  return withShapeRetry(
    async () =>
      normalizeJudgments(
        await chatJSON({
          system: SYSTEM,
          user: `${spansContext}\n\n<requirements>\n${batchLines}\n</requirements>`,
          maxTokens: 3500,
          deadline,
          model: judgeModel()
        })
      ),
    config.MAX_JUDGMENT_RETRY,
    'JUDGE_FAILED'
  )
}

/**
 * 返回 { judgments, failedReqIds }。
 * 批次各自独立：某一批重试后仍失败，只把这批的要求记进 failedReqIds（后续标"待核对"），
 * 不拖垮整份报告；失败比例超过 JUDGE_MAX_FAILED_RATIO 才整体失败（报告已无参考价值）。
 */
async function judgeRequirements(spans, requirements, candidates, { deadline } = {}) {
  if (config.LLM_MOCK) {
    return { judgments: mock.judgeRequirements(spans, requirements, candidates), failedReqIds: [] }
  }

  const spansContext = `<resume_spans>\n${renderSpans(spans)}\n</resume_spans>`
  const batches = []
  for (let i = 0; i < requirements.length; i += config.JUDGE_BATCH_SIZE) {
    batches.push(requirements.slice(i, i + config.JUDGE_BATCH_SIZE))
  }

  const settled = await Promise.allSettled(
    batches.map((batch) => {
      const lines = batch
        .map((r) => {
          const hint = (candidates.get(r.id) || []).join(', ') || 'none'
          return `${r.id} [${r.category}/权重${r.weight}] ${r.text}\n  候选片段: ${hint}`
        })
        .join('\n')
      return judgeBatch(spansContext, lines, deadline)
    })
  )

  const judgments = []
  const failedReqIds = []
  let lastErr
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') judgments.push(...r.value)
    else {
      lastErr = r.reason
      for (const req of batches[i]) failedReqIds.push(req.id)
    }
  })
  if (failedReqIds.length > 0) {
    console.warn(`judge: ${failedReqIds.length}/${requirements.length} 条判定失败:`, lastErr && lastErr.message)
  }
  if (requirements.length > 0 && failedReqIds.length / requirements.length > config.JUDGE_MAX_FAILED_RATIO) {
    throw lastErr || new Error('JUDGE_FAILED')
  }
  return { judgments, failedReqIds }
}

module.exports = { judgeRequirements, normalizeJudgments, judgeModel }
