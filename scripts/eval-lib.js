// 评测公共逻辑：样本加载、标准答案 ↔ 流水线要求的匹配、单次结果打分、汇总指标。
// 纯函数，eval.js / eval-compare.js / test-local.js 共用。

const fs = require('fs')
const path = require('path')
const { normalize, tokenize } = require('../server/text')

const VERDICTS = ['hit', 'partial', 'miss', 'unclear']

// ---------------- 样本 ----------------

function joinLines(v) {
  return Array.isArray(v) ? v.join('\n') : String(v || '')
}

/** 校验并规整一份样本；结构错误直接抛错（样本写错要尽早发现）。 */
function normalizeCase(raw, file = '') {
  const where = file ? `${file}: ` : ''
  if (!raw || typeof raw.id !== 'string' || !raw.id) throw new Error(`${where}缺少 id`)
  const resume = joinLines(raw.resume)
  const jd = joinLines(raw.jd)
  if (!resume.trim() || !jd.trim()) throw new Error(`${where}resume / jd 不能为空`)
  if (!Array.isArray(raw.expect) || raw.expect.length === 0) throw new Error(`${where}expect 不能为空`)
  const expect = raw.expect.map((e, i) => {
    if (!e || typeof e.anchor !== 'string' || !e.anchor.trim()) throw new Error(`${where}expect[${i}] 缺少 anchor`)
    if (!normalize(jd).includes(normalize(e.anchor))) throw new Error(`${where}expect[${i}] 的 anchor 不在 JD 原文里：${e.anchor}`)
    if (!VERDICTS.includes(e.verdict)) throw new Error(`${where}expect[${i}] verdict 无效：${e.verdict}`)
    const accept = Array.isArray(e.accept) && e.accept.length ? e.accept : [e.verdict]
    if (!accept.includes(e.verdict) || accept.some((v) => !VERDICTS.includes(v))) {
      throw new Error(`${where}expect[${i}] accept 必须是有效判定且包含 verdict`)
    }
    return { anchor: e.anchor, keywords: e.keywords || null, verdict: e.verdict, accept, why: e.why || '' }
  })
  const [lo, hi] = Array.isArray(raw.scoreRange) ? raw.scoreRange : [0, 100]
  if (!(lo >= 0 && hi <= 100 && lo <= hi)) throw new Error(`${where}scoreRange 无效`)
  return { id: raw.id, title: raw.title || raw.id, notes: raw.notes || '', resume, jd, expect, scoreRange: [lo, hi] }
}

function loadCases(dir) {
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort()
  const cases = files.map((f) => normalizeCase(JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')), f))
  const ids = new Set()
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`样本 id 重复：${c.id}`)
    ids.add(c.id)
  }
  return cases
}

// ---------------- 匹配：标准答案锚点 → 流水线拆出的要求 ----------------

/**
 * 锚点与要求的相似度 0~1：jdQuote 与锚点互相包含 → 1；否则按锚点的词元被覆盖的比例。
 * 拆解每次结果不同，不能按序号对应，只能按"这条要求引用的是 JD 哪一句"来对。
 */
function anchorSimilarity(anchor, req) {
  const a = normalize(anchor)
  const q = normalize(req.jdQuote || '')
  if (!a || !q) return 0
  if (q.includes(a)) return 1
  // 要求只引了锚点的一部分：至少 0.5，引得越全越像（防止只引了"Java"两个字的要求抢走整句锚点）
  if (a.includes(q)) return 0.5 + 0.5 * (q.length / a.length)
  const at = tokenize(anchor)
  if (at.length === 0) return 0
  const qt = new Set(tokenize(req.jdQuote))
  return at.filter((t) => qt.has(t)).length / at.length
}

const MATCH_THRESHOLD = 0.5

function keywordOk(exp, req) {
  if (!exp.keywords) return true
  const hay = normalize(req.text + ' ' + req.jdQuote)
  return exp.keywords.some((k) => hay.includes(normalize(k)))
}

/** 给每条标准答案找最像的要求；返回 [{ exp, req|null }]。同一条要求可以对上多条（模型把两条合成了一条）。 */
function matchExpectations(expect, requirements) {
  return expect.map((exp) => {
    let best = null
    let bestSim = 0
    for (const req of requirements) {
      if (!keywordOk(exp, req)) continue
      const sim = anchorSimilarity(exp.anchor, req)
      if (sim > bestSim) {
        best = req
        bestSim = sim
      }
    }
    return { exp, req: bestSim >= MATCH_THRESHOLD ? best : null }
  })
}

// ---------------- 单次结果打分 ----------------

/** 把一次流水线结果对照标准答案打分，结果可直接存进运行文件。 */
function gradeRun(c, pipeline) {
  const judgByReq = new Map(pipeline.judgments.map((j) => [j.reqId, j]))
  const matches = matchExpectations(c.expect, pipeline.requirements)
  const usedReqIds = new Set(matches.filter((m) => m.req).map((m) => m.req.id))

  const items = matches.map(({ exp, req }) => {
    if (!req) return { anchor: exp.anchor, expected: exp.verdict, accept: exp.accept, matched: false, got: null, correct: false }
    const j = judgByReq.get(req.id) || {}
    return {
      anchor: exp.anchor,
      expected: exp.verdict,
      accept: exp.accept,
      matched: true,
      reqId: req.id,
      reqText: req.text,
      got: j.verdict || 'unclear',
      reason: j.reason || '',
      quote: j.quote || '',
      flags: j.flags || [],
      correct: exp.accept.includes(j.verdict)
    }
  })

  const flagCount = {}
  for (const j of pipeline.judgments) for (const f of j.flags || []) flagCount[f] = (flagCount[f] || 0) + 1
  const verdictCount = {}
  for (const j of pipeline.judgments) verdictCount[j.verdict] = (verdictCount[j.verdict] || 0) + 1
  const [lo, hi] = c.scoreRange
  const overall = pipeline.score.overall

  return {
    ok: true,
    score: overall,
    capped: pipeline.score.capped,
    scoreInRange: overall >= lo && overall <= hi,
    scoreMiss: overall < lo ? overall - lo : overall > hi ? overall - hi : 0,
    reqCount: pipeline.requirements.length,
    extra: pipeline.requirements.filter((r) => !usedReqIds.has(r.id)).map((r) => r.text),
    rejectionCount: pipeline.rejectionCount,
    verdictCount,
    flagCount,
    items
  }
}

// ---------------- 汇总 ----------------

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null)

function percentile(arr, p) {
  if (!arr.length) return null
  const s = [...arr].sort((a, b) => a - b)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

/** 汇总所有样本的所有轮次。cases: [{ id, runs: [gradeRun 结果 | {ok:false}] }] */
function summarize(cases) {
  let runs = 0
  let failed = 0
  let items = 0
  let matched = 0
  let correct = 0
  let extra = 0
  let judgments = 0
  let unclear = 0
  let inRange = 0
  let rejected = 0
  let downgraded = 0
  let judgeFailed = 0
  const durations = []
  const confusion = {}
  let stableItems = 0
  let stabilityTotal = 0
  const scoreSpreads = []

  for (const c of cases) {
    const okRuns = c.runs.filter((r) => r.ok)
    for (const r of c.runs) {
      runs++
      if (r.durationMs) durations.push(r.durationMs)
      if (!r.ok) {
        failed++
        continue
      }
      for (const it of r.items) {
        items++
        const got = it.matched ? it.got : '未拆出'
        confusion[it.expected] = confusion[it.expected] || {}
        confusion[it.expected][got] = (confusion[it.expected][got] || 0) + 1
        if (!it.matched) continue
        matched++
        if (it.correct) correct++
      }
      extra += r.extra.length
      for (const [v, n] of Object.entries(r.verdictCount)) {
        judgments += n
        if (v === 'unclear') unclear += n
      }
      rejected += r.flagCount.evidence_rejected || 0
      downgraded += r.flagCount.downgraded_no_evidence || 0
      judgeFailed += r.flagCount.judge_failed || 0
      if (r.scoreInRange) inRange++
    }
    // 稳定性：同一样本多轮之间，每条标准答案的判定是否一致
    if (okRuns.length > 1) {
      const n = okRuns[0].items.length
      for (let i = 0; i < n; i++) {
        stabilityTotal++
        const set = new Set(okRuns.map((r) => (r.items[i].matched ? r.items[i].got : '未拆出')))
        if (set.size === 1) stableItems++
      }
      const scores = okRuns.map((r) => r.score)
      scoreSpreads.push(Math.max(...scores) - Math.min(...scores))
    }
  }

  const okRuns = runs - failed
  return {
    runs,
    failedRuns: failed,
    expectItems: items,
    splitRecall: pct(matched, items), // 标准答案里的要求被拆出来的比例
    accuracyMatched: pct(correct, matched), // 拆出来的要求里判对的比例
    accuracyOverall: pct(correct, items), // 端到端：所有标准答案里判对的比例（漏拆算错）
    extraPerRun: okRuns ? Math.round((extra / okRuns) * 10) / 10 : null,
    unclearRate: pct(unclear, judgments),
    evidenceRejectedPerRun: okRuns ? Math.round((rejected / okRuns) * 10) / 10 : null,
    downgradedPerRun: okRuns ? Math.round((downgraded / okRuns) * 10) / 10 : null,
    judgeFailedPerRun: okRuns ? Math.round((judgeFailed / okRuns) * 10) / 10 : null,
    scoreInRange: pct(inRange, okRuns),
    verdictStability: stabilityTotal ? pct(stableItems, stabilityTotal) : null,
    scoreSpreadAvg: scoreSpreads.length ? Math.round((scoreSpreads.reduce((a, b) => a + b, 0) / scoreSpreads.length) * 10) / 10 : null,
    durationAvgMs: durations.length ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length) : null,
    durationP90Ms: percentile(durations, 90),
    confusion
  }
}

// 指标说明与方向（compare 用来判断变好还是变坏）：higher=true 表示越大越好
const METRICS = [
  ['accuracyOverall', '端到端准确率 %', true],
  ['accuracyMatched', '判定准确率 %（已拆出的）', true],
  ['splitRecall', '拆解召回 %', true],
  ['scoreInRange', '总分落在预期区间 %', true],
  ['verdictStability', '多轮判定一致 %', true],
  ['extraPerRun', '多拆条数 / 次', null],
  ['unclearRate', '待核对占比 %', false],
  ['evidenceRejectedPerRun', '引用被拒 / 次', false],
  ['downgradedPerRun', '无证据降级 / 次', false],
  ['judgeFailedPerRun', '判定批次失败 / 次', false],
  ['scoreSpreadAvg', '多轮总分极差', false],
  ['failedRuns', '整次失败数', false],
  ['durationAvgMs', '平均耗时 ms', false],
  ['durationP90Ms', 'P90 耗时 ms', false]
]

/** 按显示宽度补齐（中文占 2 格），终端表格对齐用 */
function padW(v, n, left = false) {
  const str = String(v)
  const w = [...str].reduce((a, ch) => a + (/[\u1100-\uffff]/.test(ch) ? 2 : 1), 0)
  const pad = ' '.repeat(Math.max(0, n - w))
  return left ? pad + str : str + pad
}

module.exports = { padW, loadCases, normalizeCase, anchorSimilarity, matchExpectations, gradeRun, summarize, METRICS, VERDICTS }
