// 评测：用 eval/cases 下的模拟样本跑真实模型，量化诊断质量，结果存 eval/runs/ 供前后对比。
//
// 用法：
//   npm run eval -- --label 改判定提示词            # 全部样本跑一遍
//   npm run eval -- --label 基线 --repeat 3         # 每份样本跑 3 遍，看稳定性
//   npm run eval -- --only be-java-strong,pm-mid    # 只跑指定样本
//   npm run eval -- --concurrency 1                 # 智谱免费版只允许 1 并发
// 对比：npm run eval:compare -- eval/runs/<基线>.json eval/runs/<新>.json
//
// 只跑主报告（JD 拆解 → 判定 → 打分），不生成改写建议，不用 JD 缓存，不读写 data/。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const config = require('../server/config')
const { runPipeline } = require('../server/core')
const { judgeModel } = require('../server/judge')
const { loadCases, gradeRun, summarize, METRICS, padW } = require('./eval-lib')

const ROOT = path.join(__dirname, '..')

function parseArgs(argv) {
  const args = { label: '', repeat: 1, only: null, concurrency: 3, allowMock: false, cases: path.join(ROOT, 'eval', 'cases'), out: path.join(ROOT, 'eval', 'runs') }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    const next = () => argv[++i]
    if (a === '--label') args.label = next()
    else if (a === '--repeat') args.repeat = Math.max(1, parseInt(next(), 10) || 1)
    else if (a === '--only') args.only = next().split(',').map((s) => s.trim()).filter(Boolean)
    else if (a === '--concurrency') args.concurrency = Math.max(1, parseInt(next(), 10) || 1)
    else if (a === '--allow-mock') args.allowMock = true // 仅用于测试脚本本身，mock 结果没有评测意义
    else if (a === '--cases') args.cases = path.resolve(next())
    else if (a === '--out') args.out = path.resolve(next())
    else if (a === '-h' || a === '--help') {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(0, 11).join('\n'))
      process.exit(0)
    } else throw new Error(`未知参数：${a}`)
  }
  return args
}

/** 提示词版本：每个提示词文件内容的短哈希，对比时一眼看出改了哪个。 */
function promptVersions() {
  const dir = path.join(ROOT, 'server', 'prompts')
  const out = {}
  for (const f of fs.readdirSync(dir).sort()) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 8)
  }
  return out
}

async function pool(tasks, n) {
  const results = new Array(tasks.length)
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const i = next++
      results[i] = await tasks[i]()
    }
  }
  await Promise.all(Array.from({ length: Math.min(n, tasks.length) }, worker))
  return results
}

function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

const fmt = (v) => (v == null ? '-' : String(v))

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (config.LLM_MOCK && !args.allowMock) {
    console.error('✗ 当前是 MOCK 模式（未配置 LLM_API_KEY 或 LLM_MOCK=1）。评测必须用真实模型，请在 .env 里配置 LLM_API_KEY。')
    process.exit(2)
  }

  let cases = loadCases(args.cases)
  if (args.only) {
    const unknown = args.only.filter((id) => !cases.some((c) => c.id === id))
    if (unknown.length) throw new Error(`找不到样本：${unknown.join(', ')}`)
    cases = cases.filter((c) => args.only.includes(c.id))
  }

  const env = {
    mock: config.LLM_MOCK,
    model: config.LLM_MOCK ? 'mock' : config.LLM_MODEL,
    judgeModel: config.LLM_MOCK ? 'mock' : judgeModel(),
    apiBase: config.LLM_MOCK ? '' : new URL(config.LLM_API_BASE).host,
    prompts: promptVersions(),
    deadlineMs: config.ANALYZE_DEADLINE_MS
  }
  console.log(`评测：${cases.length} 份样本 × ${args.repeat} 轮，并发 ${args.concurrency}`)
  console.log(`模型：${env.model}（拆解） + ${env.judgeModel}（判定）  提示词：${Object.entries(env.prompts).map(([k, v]) => `${k}@${v}`).join(' ')}\n`)

  const tasks = []
  for (const c of cases) {
    for (let round = 0; round < args.repeat; round++) {
      tasks.push(async () => {
        const startedAt = Date.now()
        let result
        try {
          const pipeline = await runPipeline(c.resume, c.jd, { deadline: startedAt + config.ANALYZE_DEADLINE_MS })
          result = gradeRun(c, pipeline)
        } catch (e) {
          result = { ok: false, error: e.message }
        }
        result.durationMs = Date.now() - startedAt
        const tag = args.repeat > 1 ? `#${round + 1}` : ''
        if (result.ok) {
          const right = result.items.filter((i) => i.correct).length
          console.log(`  ${result.scoreInRange ? '✓' : '△'} ${c.id}${tag}  判对 ${right}/${result.items.length}  总分 ${result.score}（预期 ${c.scoreRange.join('~')}）  ${(result.durationMs / 1000).toFixed(1)}s`)
        } else {
          console.log(`  ✗ ${c.id}${tag}  失败：${result.error}`)
        }
        return { caseId: c.id, round, result }
      })
    }
  }
  const startedAt = Date.now()
  const done = await pool(tasks, args.concurrency)

  const byCase = cases.map((c) => ({
    id: c.id,
    title: c.title,
    scoreRange: c.scoreRange,
    runs: done.filter((d) => d.caseId === c.id).sort((a, b) => a.round - b.round).map((d) => d.result)
  }))
  const summary = summarize(byCase)

  // 判错明细：调提示词时最有用的部分
  console.log('\n== 判错 / 漏拆明细 ==')
  let wrong = 0
  for (const c of byCase) {
    c.runs.forEach((r, round) => {
      if (!r.ok) return
      for (const it of r.items) {
        if (it.correct) continue
        wrong++
        const tag = args.repeat > 1 ? `#${round + 1}` : ''
        if (!it.matched) console.log(`  [${c.id}${tag}] 漏拆：「${it.anchor}」（预期 ${it.expected}）`)
        else console.log(`  [${c.id}${tag}] 「${it.anchor}」预期 ${it.accept.join('/')}，实际 ${it.got}：${it.reason}`)
      }
    })
  }
  if (!wrong) console.log('  （无）')

  console.log('\n== 汇总 ==')
  for (const [key, label] of METRICS) console.log(`  ${padW(label, 28)} ${fmt(summary[key])}`)
  console.log('\n  混淆矩阵（行=预期，列=实际）')
  const cols = ['hit', 'partial', 'miss', 'unclear', '未拆出']
  console.log('  ' + ['预期\\实际', ...cols].map((s) => padW(s, 10)).join(''))
  for (const exp of ['hit', 'partial', 'miss', 'unclear']) {
    const row = summary.confusion[exp]
    if (!row) continue
    console.log('  ' + [exp, ...cols.map((c) => String(row[c] || 0))].map((s) => padW(s, 10)).join(''))
  }

  fs.mkdirSync(args.out, { recursive: true })
  const label = (args.label || 'run').replace(/[^\p{L}\p{N}_-]+/gu, '-').slice(0, 40)
  const file = path.join(args.out, `${stamp()}-${label}.json`)
  const out = {
    label: args.label,
    createdAt: new Date().toISOString(),
    wallMs: Date.now() - startedAt,
    repeat: args.repeat,
    env,
    summary,
    cases: byCase
  }
  fs.writeFileSync(file, JSON.stringify(out, null, 2))
  console.log(`\n结果已保存：${path.relative(ROOT, file)}`)
  console.log(`对比：npm run eval:compare -- <基线文件> ${path.relative(ROOT, file)}`)
}

main().catch((e) => {
  console.error('评测失败：', e.message)
  process.exit(1)
})
