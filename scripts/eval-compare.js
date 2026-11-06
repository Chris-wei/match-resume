// 对比两次评测：先看总体指标的变化，再列出每条标准答案"从对变错 / 从错变对"。
// 用法：npm run eval:compare -- eval/runs/<基线>.json eval/runs/<新>.json

const fs = require('fs')
const path = require('path')
const { METRICS, padW } = require('./eval-lib')

function load(file) {
  return JSON.parse(fs.readFileSync(path.resolve(file), 'utf8'))
}

/** 每条标准答案在该次评测里的判对率（多轮取比例）与各轮实际判定。key = 样本 id + 锚点 */
function itemStats(run) {
  const map = new Map()
  for (const c of run.cases) {
    for (const r of c.runs) {
      if (!r.ok) continue
      for (const it of r.items) {
        const key = `${c.id}\u0000${it.anchor}`
        const s = map.get(key) || { caseId: c.id, anchor: it.anchor, accept: it.accept, n: 0, correct: 0, got: [], reasons: [] }
        s.n++
        if (it.correct) s.correct++
        s.got.push(it.matched ? it.got : '未拆出')
        if (it.reason) s.reasons.push(it.reason)
        map.set(key, s)
      }
    }
  }
  return map
}

function caseScores(run) {
  const map = new Map()
  for (const c of run.cases) {
    const ok = c.runs.filter((r) => r.ok)
    map.set(c.id, {
      range: c.scoreRange,
      scores: ok.map((r) => r.score),
      inRange: ok.filter((r) => r.scoreInRange).length,
      n: ok.length,
      failed: c.runs.length - ok.length
    })
  }
  return map
}

function describe(run) {
  const p = Object.entries(run.env.prompts).map(([k, v]) => `${k}@${v}`).join(' ')
  return `${run.label || '(无标签)'}  ${run.createdAt}  ${run.env.model} + ${run.env.judgeModel}  ×${run.repeat}  ${p}`
}

function main() {
  const [fa, fb] = process.argv.slice(2)
  if (!fa || !fb) {
    console.error('用法：npm run eval:compare -- <基线.json> <新.json>')
    process.exit(2)
  }
  const a = load(fa)
  const b = load(fb)
  console.log(`基线：${describe(a)}`)
  console.log(`新版：${describe(b)}`)

  // 改了什么
  const changes = []
  if (a.env.model !== b.env.model) changes.push(`拆解模型 ${a.env.model} → ${b.env.model}`)
  if (a.env.judgeModel !== b.env.judgeModel) changes.push(`判定模型 ${a.env.judgeModel} → ${b.env.judgeModel}`)
  for (const f of new Set([...Object.keys(a.env.prompts), ...Object.keys(b.env.prompts)])) {
    if (a.env.prompts[f] !== b.env.prompts[f]) changes.push(`提示词 ${f} 有改动`)
  }
  console.log(`改动：${changes.length ? changes.join('；') : '模型与提示词都没变（可用来看随机波动）'}`)

  const idsA = new Set(a.cases.map((c) => c.id))
  const idsB = new Set(b.cases.map((c) => c.id))
  const onlyA = [...idsA].filter((x) => !idsB.has(x))
  const onlyB = [...idsB].filter((x) => !idsA.has(x))
  if (onlyA.length || onlyB.length) {
    console.log(`⚠ 样本集不一致，汇总指标不可直接比较（仅基线有：${onlyA.join(',') || '无'}；仅新版有：${onlyB.join(',') || '无'}）。下方逐条对比只看共同样本。`)
  }

  console.log('\n== 汇总指标 ==')
  console.log(`  ${padW('指标', 28)} ${padW('基线', 8, true)} ${padW('新版', 8, true)}  变化`)
  for (const [key, label, higher] of METRICS) {
    const va = a.summary[key]
    const vb = b.summary[key]
    let mark = ''
    if (va != null && vb != null && va !== vb) {
      const d = Math.round((vb - va) * 10) / 10
      const better = higher == null ? null : higher ? d > 0 : d < 0
      mark = `${d > 0 ? '+' : ''}${d}${better == null ? '' : better ? '  ✓ 变好' : '  ✗ 变差'}`
    }
    console.log(`  ${padW(label, 28)} ${padW(va ?? '-', 8, true)} ${padW(vb ?? '-', 8, true)}  ${mark}`)
  }

  const sa = itemStats(a)
  const sb = itemStats(b)
  const worse = []
  const better = []
  const changed = []
  for (const [key, x] of sa) {
    const y = sb.get(key)
    if (!y) continue
    const ra = x.correct / x.n
    const rb = y.correct / y.n
    if (rb < ra) worse.push([x, y])
    else if (rb > ra) better.push([x, y])
    else if (x.got.join() !== y.got.join()) changed.push([x, y])
  }
  const line = ([x, y]) =>
    `  [${x.caseId}] 「${x.anchor}」 预期 ${x.accept.join('/')}：${x.got.join(',')} → ${y.got.join(',')}` +
    (y.reasons.length ? `\n      新版理由：${y.reasons[0]}` : '')

  console.log(`\n== 从对变错（${worse.length}）==`)
  console.log(worse.length ? worse.map(line).join('\n') : '  （无）')
  console.log(`\n== 从错变对（${better.length}）==`)
  console.log(better.length ? better.map(line).join('\n') : '  （无）')
  if (changed.length) {
    console.log(`\n== 判定变了但对错没变（${changed.length}）==`)
    console.log(changed.map(line).join('\n'))
  }

  const ca = caseScores(a)
  const cb = caseScores(b)
  const scoreLines = []
  for (const [id, x] of ca) {
    const y = cb.get(id)
    if (!y) continue
    const fmtS = (s) => (s.n ? s.scores.join('/') : '失败')
    if (x.scores.join() !== y.scores.join() || x.failed !== y.failed) {
      const flag = y.inRange / (y.n || 1) > x.inRange / (x.n || 1) ? '✓' : y.inRange / (y.n || 1) < x.inRange / (x.n || 1) ? '✗' : ' '
      scoreLines.push(`  ${flag} ${id.padEnd(24)} 预期 ${x.range.join('~').padEnd(7)} ${fmtS(x)} → ${fmtS(y)}`)
    }
  }
  console.log(`\n== 总分变化（✓ 进入区间 / ✗ 跑出区间）==`)
  console.log(scoreLines.length ? scoreLines.join('\n') : '  （无变化）')
}

main()
