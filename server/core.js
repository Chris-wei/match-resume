// 流水线编排（设计文档 §2 的 ②~⑦ 步）：
// 切分 → JD 拆解(LLM，可缓存) → 引用校验(代码) → 检索(代码) → 判定(LLM) → 引用校验(代码) → 打分(代码) → 一句话结论。
// 纯逻辑、不碰 http/db（缓存与进度回调由调用方注入），本地 node 可直接跑（scripts/test-local.js）。

const { segmentResume } = require('./segment')
const { redactSpans } = require('./redact')
const { retrieveCandidates } = require('./retrieve')
const { verifyRequirements, verifyJudgments } = require('./verify')
const { scoreMatch } = require('./score')
const { conclude } = require('./conclude')
const { splitJD } = require('./jdSplit')
const { judgeRequirements } = require('./judge')

/**
 * @param {object} opts
 *   deadline  绝对时间戳，LLM 调用超过即放弃
 *   jdCache   { get(jdText) → rawRequirements|null, set(jdText, rawRequirements) }，可选
 *   onStage   (stage) => void，stage ∈ split | judge | score，可选（给前端展示真实进度）
 */
async function runPipeline(resumeText, jdText, { deadline, jdCache, onStage } = {}) {
  const stage = (s) => onStage && onStage(s)
  const rejections = []

  // ② 切分简历（顺手脱敏：联系方式与姓名绝不进模型上下文；spans 留存用于前端"引用看上下文"）
  const spans = redactSpans(segmentResume(resumeText))
  if (spans.length === 0) throw new Error('RESUME_EMPTY_SPANS')

  // ③ JD 拆原子要求（LLM，同一份 JD 命中缓存则跳过）→ 校验 jd_quote 逐字存在于 JD
  stage('split')
  let rawRequirements = jdCache ? jdCache.get(jdText) : null
  const jdCacheHit = !!rawRequirements
  if (!rawRequirements) {
    rawRequirements = await splitJD(jdText, { deadline })
  }
  const requirements = verifyRequirements(jdText, rawRequirements, rejections)
  if (requirements.length === 0) throw new Error('NO_VALID_REQUIREMENTS')
  // 只缓存能用的拆解结果
  if (jdCache && !jdCacheHit) jdCache.set(jdText, rawRequirements)

  // ④ 证据检索（纯代码）
  const candidates = new Map(requirements.map((r) => [r.id, retrieveCandidates(r, spans)]))

  // ⑤ 逐条判定（LLM，批次独立）→ ⑥ 引用逐字校验，失败降级 unclear
  stage('judge')
  const { judgments: rawJudgments, failedReqIds } = await judgeRequirements(spans, requirements, candidates, { deadline })
  const judgments = verifyJudgments(requirements, spans, rawJudgments, rejections, failedReqIds)

  // ⑦ 确定性打分 + 一句话结论
  stage('score')
  const score = scoreMatch(requirements, judgments)
  const conclusion = conclude(score, requirements, judgments)

  return {
    spans,
    requirements,
    judgments,
    score: {
      overall: score.overall,
      capped: score.capped,
      failedHardGates: score.failedHardGates,
      radar: score.radar
    },
    conclusion,
    spanCount: spans.length,
    rejectionCount: rejections.length,
    jdCacheHit,
    judgeFailedCount: failedReqIds.length
  }
}

module.exports = { runPipeline }
