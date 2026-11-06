// 本地内核测试（不调任何 API、不碰网络与磁盘存储）：
//   1. 纯逻辑单测：脱敏 / 引用匹配 / 切分 / 校验 / 打分 / 一句话结论 / 风控
//   2. mock 流水线集成测试：examples 下的简历 + JD 全链路跑通
// 运行：npm test  或  node scripts/test-local.js

process.env.LLM_MOCK = '1' // 必须在 require 之前设置

const fs = require('fs')
const path = require('path')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
const S = (f) => path.join(ROOT, 'server', f)

const { redact, redactSpans } = require(S('redact'))
const { redact: clientRedact } = require(path.join(ROOT, 'miniprogram', 'utils', 'redact'))
const { quoteMatches, locateQuote, containsTerm } = require(S('text'))
const config = require(S('config'))
const auth = require(S('auth'))
const llm = require(S('llm'))
const http = require('http')
const { segmentResume, renderSpans } = require(S('segment'))
const { verifyRequirements, verifyJudgments } = require(S('verify'))
const { scoreMatch } = require(S('score'))
const { retrieveCandidates } = require(S('retrieve'))
const { conclude } = require(S('conclude'))
const limits = require(S('limits'))
const { runPipeline } = require(S('core'))
const { proposeRewrites } = require(S('rewrite'))
const moderation = require(S('moderation'))
const evalLib = require(path.join(ROOT, 'scripts', 'eval-lib'))

let passed = 0
let failed = 0
async function testAsync(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message}`)
  }
}
function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.error(`  ✗ ${name}\n    ${e.message}`)
  }
}

// 构造假 db（只暴露 limits 用到的 countUsage），隔离磁盘
function fakeDb(usage) {
  return { countUsage: (filter, since) => usage.filter(
    (u) => u.kind === filter.kind && u.createdAt >= since &&
      (!filter.owner || u.owner === filter.owner) &&
      (!filter.ipHash || u.ipHash === filter.ipHash)
  ).length }
}

const CFG = {
  GLOBAL_DAILY_CAP: 200,
  ANALYZE_PER_IP_PER_DAY: 10,
  ANALYZE_PER_IP_PER_10MIN: 5,
  ANALYZE_PER_IDENTITY_PER_DAY: 3,
  ANALYZE_PER_IDENTITY_PER_10MIN: 3,
  COPY_PER_IDENTITY_PER_DAY: 3
}
const NOW = new Date('2026-11-02T14:00:00').getTime()
const TODAY = limits.dayStart(NOW)
const u = (kind, owner, ipHash, at) => ({ kind, owner, ipHash, createdAt: at })

console.log('\n== 单测：脱敏 ==')
test('邮箱替换', () => assert.ok(redact('联系 zhangsan@example.com').includes('[EMAIL]')))
test('大陆手机号替换', () => assert.ok(redact('手机 13812345678').includes('[PHONE]')))
test('带分隔手机号替换', () => assert.ok(redact('电话 138-1234-5678').includes('[PHONE]')))
test('身份证替换', () => assert.ok(redact('号 11010119900307891X').includes('[ID]')))
test('普通数字不受影响', () => assert.equal(redact('QPS 8000，提升 60%'), 'QPS 8000，提升 60%'))
test('小程序端与服务端脱敏结果一致（两份正则不漂移）', () => {
  const samples = ['邮箱 a.b+c@x-y.com.cn', '手机 +86 138-1234-5678', '身份证 11010119900307891X', 'tel +1 (415) 555-0123', 'QPS 8000，2019-2023']
  for (const t of samples) assert.equal(clientRedact(t), redact(t), t)
})
test('姓名脱敏：header 首行名字 / 姓名字段', () => {
  const out = redactSpans(segmentResume('张晨\n姓名：欧阳娜娜\nName: John Smith\n工作经历\n负责后端')).map((x) => x.text)
  assert.deepEqual(out, ['[NAME]', '姓名：[NAME]', 'Name: [NAME]', '负责后端'])
})
test('姓名脱敏不误伤正文', () => {
  const out = redactSpans(segmentResume('求职意向：产品经理\n工作经历\n张江高科')).map((x) => x.text)
  assert.deepEqual(out, ['求职意向：产品经理', '张江高科'])
})

console.log('\n== 单测：引用匹配（护城河）==')
test('逐字命中', () => assert.ok(quoteMatches('负责后端服务开发，使用 Java', '负责后端服务开发，使用 Java / Spring Boot')))
test('标点/大小写漂移容忍', () => assert.ok(quoteMatches('负责后端服务开发，使用 java', '负责后端服务开发，使用 Java')))
test('改写不接受', () => assert.ok(!quoteMatches('负责后端核心服务的开发工作', '负责后端服务开发，使用 Java')))
test('空引用拒绝', () => assert.ok(!quoteMatches('', '任意原文')))
test('定位引用：展示的是原文切片而非模型抄写版本', () => {
  const r = locateQuote('负责后端服务开发，使用 java', '负责后端服务开发，使用 Java / Spring Boot')
  assert.equal(r.exact, true)
  assert.equal(r.text, '负责后端服务开发，使用 Java')
})
test('定位引用：模糊命中返回原文整句并标记 exact=false', () => {
  const r = locateQuote('负责 后端 服务 开发 Java Spring', 'Java Spring 负责后端服务开发和维护。另一句')
  assert.equal(r.exact, false)
  assert.equal(r.text, 'Java Spring 负责后端服务开发和维护')
})
test('java 不误匹配 javascript', () => assert.ok(!containsTerm('精通 JavaScript 开发', 'java')))
test('CJK 内嵌英文可命中', () => assert.ok(containsTerm('使用Python开发服务', 'python')))

console.log('\n== 单测：切分 ==')
const spans = segmentResume('张三\n\n工作经历\n- 负责 A 项目\n2021 入职 ABC\nEducation\n本科')
test('标题不占编号', () => assert.equal(spans.length, 4))
test('编号连续 S1..Sn', () => assert.deepEqual(spans.map((s) => s.id), ['S1', 'S2', 'S3', 'S4']))
test('bullet 前缀剥离', () => assert.equal(spans[1].text, '负责 A 项目'))
test('中英标题识别', () => assert.equal(spans[1].section, 'experience') && assert.equal(spans[3].section, 'education'))

console.log('\n== 单测：JD 拆解校验 ==')
const rejections = []
const reqs = verifyRequirements(
  '要求 5年以上 Java 开发经验；熟悉 K8s',
  [
    { text: 'Java 经验', jd_quote: '5年以上 Java 开发经验', category: 'experience', weight: 1, years: 5, skill: 'java' },
    { text: '编造的要求', jd_quote: '这句不在 JD 里', category: 'skills', weight: 1 }
  ],
  rejections
)
test('未在 JD 中的 quote 被拒收', () => assert.equal(reqs.length, 1) && assert.equal(rejections.length, 1))
test('id 重排', () => assert.equal(reqs[0].id, 'R1'))
test('文本相同的要求去重（只差标点空格也算重复）', () => {
  const rej = []
  const out = verifyRequirements(
    '熟悉 MySQL、Redis、Kafka',
    [
      { text: '熟悉 MySQL、Redis、Kafka', jd_quote: '熟悉 MySQL、Redis、Kafka', category: 'skills', weight: 1 },
      { text: '熟悉MySQL、Redis、Kafka。', jd_quote: '熟悉 MySQL、Redis、Kafka', category: 'skills', weight: 1 },
      { text: '熟悉 Kafka', jd_quote: 'Kafka', category: 'skills', weight: 1 }
    ],
    rej
  )
  assert.deepEqual(out.map((r) => r.text), ['熟悉 MySQL、Redis、Kafka', '熟悉 Kafka'])
  assert.equal(rej[0].reason, '与前面的要求重复')
})

console.log('\n== 单测：判定校验（降级 unclear）==')
const jRej = []
const reqs2 = reqs.concat([
  { id: 'R2', text: '技能 b', jdQuote: '熟悉 K8s', category: 'skills', weight: 1, years: null, skill: null }
])
const judgments = verifyJudgments(
  reqs2,
  spans,
  [
    { req_id: 'R1', verdict: 'hit', quote: '简历里没有这句', quote_id: 'S2', reason: '幻觉' },
    { req_id: 'R2', verdict: 'hit', quote: '负责 A 项目', quote_id: 'S2', reason: 'ok' }
  ],
  jRej
)
test('幻觉引用整条降级 unclear', () => {
  assert.equal(judgments[0].verdict, 'unclear')
  assert.ok(judgments[0].flags.includes('evidence_rejected'))
  assert.ok(judgments[0].flags.includes('downgraded_no_evidence'))
})
test('真实引用保留 hit', () => assert.equal(judgments[1].verdict, 'hit') && assert.equal(judgments[1].quoteId, 'S2'))
test('大小写漂移的引用被替换为原文切片', () => {
  const jj = verifyJudgments(reqs2.slice(1), spans, [{ req_id: 'R2', verdict: 'hit', quote: '负责 a 项目', quote_id: 'S2' }], [])
  assert.equal(jj[0].quote, '负责 A 项目')
})

console.log('\n== 单测：确定性打分 ==')
const mkReq = (id, category, weight, years) => ({ id, text: '要求' + id, jdQuote: 'q', category, weight, years: years || null, skill: null })
const mkJudg = (id, verdict, yearsHint) => ({ reqId: id, verdict, quoteId: verdict === 'hit' ? 'S1' : '', quote: '', reason: '', yearsHint: yearsHint ?? null, flags: [] })
const scoreReqSet = () => scoreMatch(
  [mkReq('R1', 'skills', 1), mkReq('R2', 'experience', 1, 5), mkReq('R3', 'education', 1), mkReq('R4', 'keywords', 0.5)],
  [mkJudg('R1', 'hit'), mkJudg('R2', 'hit', 3), mkJudg('R3', 'hit'), mkJudg('R4', 'miss')]
)
const s1 = scoreReqSet()
const s2 = scoreReqSet()
test('同一输入必得同分', () => assert.equal(s1.overall, s2.overall))
test('年限不足按比例打折', () => {
  const item = s1.items.find((i) => i.req.id === 'R2')
  assert.ok(Math.abs(item.score - 0.6) < 1e-9)
})
test('雷达五维齐全', () => assert.equal(s1.radar.length, 5) && assert.ok(s1.radar.every((r) => typeof r.value === 'number')))
const s3 = scoreMatch(
  [mkReq('R1', 'experience', 1, 5), mkReq('R2', 'skills', 1), mkReq('R3', 'skills', 1), mkReq('R4', 'skills', 1)],
  [mkJudg('R1', 'miss'), mkJudg('R2', 'hit'), mkJudg('R3', 'hit'), mkJudg('R4', 'hit')]
)
test('硬门槛 miss 触发封顶 60（原始 75 → 60）', () => assert.ok(s3.capped) && assert.equal(s3.overall, 60))

console.log('\n== 单测：一句话结论（截图第一版：总分 + 一句话结论）==')
const c1 = conclude(s1.score || s1, s1.items.map((i) => i.req), s1.items.map((i) => i.judgment))
const c2 = conclude(s1.score || s1, s1.items.map((i) => i.req), s1.items.map((i) => i.judgment))
test('结论非空且确定性', () => assert.ok(c1 && c1.length >= 8) && assert.equal(c1, c2))
test('低分结论点名最重的缺失项', () => {
  const low = conclude(s3, s3.items.map((i) => i.req), s3.items.map((i) => i.judgment))
  assert.ok(low.includes('要求R1'))
  assert.ok(low.includes('硬性年限'))
})

console.log('\n== 单测：风控（每人限次 / IP 限制 / 全站上限 / 复制限 3 条）==')
const mkLimits = (usage) => limits.checkAnalyze(fakeDb(usage), 'u1', 'ip1', NOW, CFG)

test('无记录 → 放行', () => assert.ok(mkLimits([]).ok))
test('身份当日 3 次 → 拒（QUOTA_EXCEEDED）', () => {
  const r = mkLimits([u('analyze', 'u1', 'ip9', TODAY + 1), u('analyze', 'u1', 'ip9', TODAY + 2), u('analyze', 'u1', 'ip9', TODAY + 3)])
  assert.equal(r.code, 'QUOTA_EXCEEDED')
})
test('身份当日 2 次 → 放行', () => {
  assert.ok(mkLimits([u('analyze', 'u1', 'ip9', TODAY + 1), u('analyze', 'u1', 'ip9', TODAY + 2)]).ok)
})
test('昨天的记录不占今日额度', () => {
  assert.ok(mkLimits([u('analyze', 'u1', 'ip9', TODAY - 1000), u('analyze', 'u1', 'ip9', TODAY - 2000), u('analyze', 'u1', 'ip9', TODAY - 3000)]).ok)
})
test('身份 10 分钟窗 3 次 → 拒（RATE_LIMITED）', () => {
  const r = mkLimits([u('analyze', 'u1', 'ip9', NOW - 60e3), u('analyze', 'u1', 'ip9', NOW - 120e3), u('analyze', 'u1', 'ip9', NOW - 180e3)])
  assert.equal(r.code, 'RATE_LIMITED')
})
test('IP 当日 10 次 → 拒（换设备也没用）', () => {
  const usage = []
  for (let i = 0; i < 10; i++) usage.push(u('analyze', 'u' + i, 'ip1', TODAY + i * 1000))
  assert.equal(mkLimits(usage).code, 'IP_LIMITED')
})
test('全站当日达 GLOBAL_DAILY_CAP → 拒', () => {
  const usage = []
  for (let i = 0; i < 200; i++) usage.push(u('analyze', 'u' + i, 'ip' + i, TODAY + 1000))
  assert.equal(mkLimits(usage).code, 'GLOBAL_LIMITED')
})
test('PDF 解析 10 分钟窗限次', () => {
  const usage = []
  for (let i = 0; i < 5; i++) usage.push(u('pdf', 'u1', 'ip1', NOW - i * 1000))
  assert.equal(limits.checkPdf(fakeDb(usage), 'u1', NOW, { PDF_PER_IDENTITY_PER_10MIN: 5, PDF_PER_IDENTITY_PER_DAY: 20 }).code, 'RATE_LIMITED')
})
test('quotaInfo.dateKey 用本地日期', () => {
  assert.equal(limits.quotaInfo(fakeDb([]), 'u1', 'ip1', new Date(2026, 10, 2, 0, 30).getTime(), CFG).dateKey, '2026-11-02')
})
const copyDb = fakeDb([u('copy', 'u1', 'ip1', TODAY + 1), u('copy', 'u1', 'ip1', TODAY + 2), u('copy', 'u1', 'ip1', TODAY + 3)])
test('复制 3 条后 → 拒（COPY_LIMIT）', () => {
  const r = limits.checkCopy(copyDb, 'u1', NOW, CFG)
  assert.equal(r.code, 'COPY_LIMIT')
})
test('复制 2 条 → 放行且余 0', () => {
  const r = limits.checkCopy(fakeDb([u('copy', 'u1', 'ip1', TODAY + 1), u('copy', 'u1', 'ip1', TODAY + 2)]), 'u1', NOW, CFG)
  assert.ok(r.ok) && assert.equal(r.remaining, 0)
})
test('quotaInfo 统计今日用量', () => {
  const q = limits.quotaInfo(fakeDb([u('analyze', 'u1', 'ip1', TODAY + 1), u('copy', 'u1', 'ip1', TODAY + 2)]), 'u1', 'ip1', NOW, CFG)
  assert.equal(q.analyze.remaining, 2) && assert.equal(q.copies.remaining, 2)
})

console.log('\n== 单测：模型输出 JSON 抽取 ==')
test('裸数组也能解析（千问偶尔不包外层对象）', () => {
  const out = llm.extractJSON('[\n {"id":"R1","text":"a"},\n {"id":"R2","text":"b"}\n]')
  assert.deepEqual(llm.listFrom(out, 'requirements').map((r) => r.id), ['R1', 'R2'])
})
test('围栏 + 结尾多余内容 + 字符串里的括号', () => {
  const out = llm.extractJSON('```json\n{"judgments":[{"reason":"含 } 和 ] 的理由"}]}\n```\n补充说明 {x}')
  assert.equal(llm.listFrom(out, 'judgments')[0].reason, '含 } 和 ] 的理由')
})
test('包了外层对象照常取 key', () => assert.equal(llm.listFrom({ rewrites: [1] }, 'rewrites').length, 1))

console.log('\n== 单测：身份与 IP ==')
const fakeReq = (headers) => ({ headers, socket: { remoteAddress: '10.0.0.1' } })
test('默认不信任 X-Real-IP / X-Forwarded-For（防伪造绕过 IP 限制）', () => {
  assert.equal(auth.clientIp(fakeReq({ 'x-real-ip': '1.2.3.4', 'x-forwarded-for': '5.6.7.8' })), '10.0.0.1')
})
test('TRUST_PROXY=1 时才取代理头', () => {
  config.TRUST_PROXY = true
  try {
    assert.equal(auth.clientIp(fakeReq({ 'x-forwarded-for': '5.6.7.8, 10.0.0.2' })), '5.6.7.8')
  } finally {
    config.TRUST_PROXY = false
  }
})

console.log('\n== 单测：内容安全（本地词库）==')
const L = { words: ['碎尸', '洗钱', '约炮'].map(moderation.compact), allow: ['反洗钱'].map(moderation.compact) }
test('命中敏感词', () => assert.equal(moderation.localCheck('他描述了碎尸的过程', L), '碎尸'))
test('空格/符号/全角变形也能命中', () => {
  assert.equal(moderation.localCheck('碎 尸', L), '碎尸')
  assert.equal(moderation.localCheck('碎*尸', L), '碎尸')
  assert.equal(moderation.localCheck('约　炮！', L), '约炮')
})
test('白名单不误伤（反洗钱）', () => assert.equal(moderation.localCheck('负责反洗钱系统建设', L), null))
test('白名单只遮自己那段，别处的敏感词照拦', () => assert.equal(moderation.localCheck('负责反洗钱系统，私下帮人洗钱', L), '洗钱'))
test('正常简历不误伤（默认词库）', () => {
  const text = fs.readFileSync(path.join(ROOT, 'examples', 'resume.txt'), 'utf8') +
    fs.readFileSync(path.join(ROOT, 'examples', 'jd.txt'), 'utf8') +
    '负责秒杀系统、杀毒引擎、暴力破解防护，用户量爆炸式增长；反洗钱合规平台'
  assert.equal(moderation.localCheck(text), null)
})
test('默认词库可加载且能命中', () => assert.equal(moderation.localCheck('网上看到血腥视频'), '血腥'))
test('微信送检按行切段且每段不超长', () => {
  const pieces = moderation.chunk(['a'.repeat(1500), 'b'.repeat(1500), 'c'.repeat(4500)].join('\n'), 2000)
  assert.ok(pieces.every((p) => p.length <= 2000))
  assert.equal(pieces.join('').replace(/\n/g, '').length, 7500)
})
test('被拦截 10 分钟内达上限 → RATE_LIMITED（身份或 IP 任一）', () => {
  const cfg = { MODERATION_BLOCKS_PER_10MIN: 5 }
  const five = Array.from({ length: 5 }, (_, i) => u('blocked', 'A', 'ip1', NOW - i * 1000))
  assert.equal(limits.checkBlocked(fakeDb(five), 'A', 'ipX', NOW, cfg).code, 'RATE_LIMITED')
  assert.equal(limits.checkBlocked(fakeDb(five), 'B', 'ip1', NOW, cfg).code, 'RATE_LIMITED')
  assert.ok(limits.checkBlocked(fakeDb(five.slice(1)), 'A', 'ip1', NOW, cfg).ok)
  const old = Array.from({ length: 5 }, () => u('blocked', 'A', 'ip1', NOW - 11 * 60e3))
  assert.ok(limits.checkBlocked(fakeDb(old), 'A', 'ip1', NOW, cfg).ok)
})

console.log('\n== 单测：评测工具（标准答案匹配与打分）==')
test('全部评测样本格式有效、锚点都在 JD 原文里', () => {
  const cs = evalLib.loadCases(path.join(ROOT, 'eval', 'cases'))
  assert.ok(cs.length >= 20)
})
test('锚点不在 JD 里 → 样本加载报错', () => {
  assert.throws(() => evalLib.normalizeCase({ id: 'x', resume: 'r', jd: '熟悉 Java', expect: [{ anchor: '熟悉 Go', verdict: 'hit' }] }), /不在 JD/)
})
test('锚点匹配：整句引用优先于只引了一个词的要求', () => {
  const reqs = [
    { id: 'R1', text: 'Java', jdQuote: 'Java' },
    { id: 'R2', text: '5 年 Java 经验', jdQuote: '5年以上 Java 后端开发经验' }
  ]
  const [m] = evalLib.matchExpectations([{ anchor: '5年以上 Java 后端开发经验', keywords: null }], reqs)
  assert.equal(m.req.id, 'R2')
})
test('锚点匹配：对不上任何要求 → 漏拆', () => {
  const [m] = evalLib.matchExpectations([{ anchor: '本科及以上学历', keywords: null }], [{ id: 'R1', text: 'Go', jdQuote: '精通 Go 语言' }])
  assert.equal(m.req, null)
})
test('gradeRun：判对 / 判错 / 漏拆 / 多拆 / 总分区间', () => {
  const c = evalLib.normalizeCase({
    id: 't', resume: 'r', jd: '熟悉 Go\n本科及以上学历\n有 K8s 经验', scoreRange: [50, 80],
    expect: [
      { anchor: '熟悉 Go', verdict: 'hit' },
      { anchor: '本科及以上学历', verdict: 'hit', accept: ['hit', 'partial'] },
      { anchor: '有 K8s 经验', verdict: 'miss' }
    ]
  })
  const g = evalLib.gradeRun(c, {
    requirements: [
      { id: 'R1', text: 'Go', jdQuote: '熟悉 Go' },
      { id: 'R2', text: '本科', jdQuote: '本科及以上学历' },
      { id: 'R3', text: '加班', jdQuote: '能接受加班' }
    ],
    judgments: [
      { reqId: 'R1', verdict: 'partial', flags: [] },
      { reqId: 'R2', verdict: 'partial', flags: ['fuzzy_quote'] },
      { reqId: 'R3', verdict: 'unclear', flags: [] }
    ],
    score: { overall: 60, capped: false },
    rejectionCount: 0
  })
  assert.deepEqual(g.items.map((i) => [i.matched, i.correct]), [[true, false], [true, true], [false, false]])
  assert.deepEqual(g.extra, ['加班'])
  assert.ok(g.scoreInRange)
  const s = evalLib.summarize([{ id: 't', runs: [g, { ok: false, error: 'x' }] }])
  assert.equal(s.failedRuns, 1)
  assert.equal(s.splitRecall, 66.7)
  assert.equal(s.accuracyMatched, 50)
  assert.equal(s.accuracyOverall, 33.3)
  assert.equal(s.confusion.miss['未拆出'], 1)
})

console.log('\n== 单测：检索 ==')
const reqForRetrieval = { id: 'R1', text: '精通 Kubernetes 容器编排', skill: 'kubernetes' }
test('别名命中排第一', () => {
  const ids = retrieveCandidates(reqForRetrieval, [
    { id: 'S1', text: '负责业务开发' },
    { id: 'S2', text: '部署于 k8s 集群' },
    { id: 'S3', text: '编写文档' }
  ])
  assert.equal(ids[0], 'S2')
})

console.log('\n== 集成：mock 流水线（examples 简历 + JD）==')
  ; (async () => {
    await testAsync('配了 AppID 时不传 code 拿不到设备身份（openid 不可绕过）', async () => {
      config.WX_APPID = 'wx_test'
      config.WX_APPSECRET = 'secret'
      try {
        assert.equal(await auth.identityFor({ deviceId: 'dabcdefgh123' }), null)
      } finally {
        config.WX_APPID = ''
        config.WX_APPSECRET = ''
      }
    })
    await testAsync('未配 AppID 时设备 ID 兜底可用', async () => {
      assert.deepEqual(await auth.identityFor({ deviceId: 'dabcdefgh123' }), { sub: 'd:dabcdefgh123', kind: 'device' })
    })

    // 起一个本地假微信接口，验证 msgSecCheck 的判定与降级
    const withFakeWx = async (handler, fn) => {
      const calls = { token: 0, check: 0, bodies: [] }
      const srv = http.createServer((req, res) => {
        let d = ''
        req.on('data', (c) => (d += c))
        req.on('end', () => {
          const body = d ? JSON.parse(d) : {}
          const out = handler(req.url, body, calls)
          if (out === 'HANG') return // 不回包，触发超时
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify(out))
        })
      })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const saved = { base: config.WX_API_BASE, id: config.WX_APPID, secret: config.WX_APPSECRET, t: config.WX_SEC_TIMEOUT_MS }
      config.WX_API_BASE = `http://127.0.0.1:${srv.address().port}`
      config.WX_APPID = 'wx_test'
      config.WX_APPSECRET = 'secret'
      config.WX_SEC_TIMEOUT_MS = 300
      moderation._resetToken()
      try {
        await fn(calls)
      } finally {
        Object.assign(config, { WX_API_BASE: saved.base, WX_APPID: saved.id, WX_APPSECRET: saved.secret, WX_SEC_TIMEOUT_MS: saved.t })
        moderation._resetToken()
        srv.close()
      }
    }
    const wxHandler = (suggest, { tokenErrOnce = false } = {}) => (url, body, calls) => {
      if (url.startsWith('/cgi-bin/stable_token')) {
        calls.token++
        return { access_token: 'tok' + calls.token, expires_in: 7200 }
      }
      calls.check++
      calls.bodies.push(body)
      if (tokenErrOnce && calls.check === 1) return { errcode: 40001, errmsg: 'invalid credential' }
      return { errcode: 0, errmsg: 'ok', result: { suggest, label: suggest === 'pass' ? 100 : 20002 } }
    }
    const ITEMS = [{ field: 'resume', text: '五年后端开发经验', scene: 'profile' }]

    await testAsync('未配置微信：只查本地词库，放行', async () => {
      const r = await moderation.checkTexts(ITEMS, { owner: 'd:dev12345678' })
      assert.deepEqual(r, { ok: true, wechatChecked: false })
    })
    await testAsync('本地词库命中：直接拦截，不调微信', () =>
      withFakeWx(wxHandler('pass'), async (calls) => {
        const r = await moderation.checkTexts([{ field: 'jd', text: '血腥画面', scene: 'profile' }], { owner: 'o:oid' })
        assert.equal(r.blocked, true)
        assert.equal(r.source, 'local')
        assert.equal(calls.check, 0)
      }))
    await testAsync('微信 pass → 放行，送检带 openid / version 2 / scene', () =>
      withFakeWx(wxHandler('pass'), async (calls) => {
        const r = await moderation.checkTexts(ITEMS, { owner: 'o:oid' })
        assert.deepEqual(r, { ok: true, wechatChecked: true })
        assert.deepEqual(calls.bodies[0], { content: '五年后端开发经验', version: 2, scene: 1, openid: 'oid' })
      }))
    await testAsync('微信 risky → 拦截', () =>
      withFakeWx(wxHandler('risky'), async () => {
        const r = await moderation.checkTexts(ITEMS, { owner: 'o:oid' })
        assert.equal(r.blocked, true)
        assert.equal(r.source, 'wechat')
      }))
    await testAsync('微信 review → 放行（只记日志）', () =>
      withFakeWx(wxHandler('review'), async () => {
        assert.equal((await moderation.checkTexts(ITEMS, { owner: 'o:oid' })).ok, true)
      }))
    await testAsync('微信超时 → unavailable（调用方判提交失败）', () =>
      withFakeWx((url, body, calls) => (url.startsWith('/cgi-bin') ? { access_token: 't', expires_in: 7200 } : 'HANG'), async () => {
        const r = await moderation.checkTexts(ITEMS, { owner: 'o:oid' })
        assert.equal(r.unavailable, true)
      }))
    await testAsync('微信报错（非 token 问题）→ unavailable', () =>
      withFakeWx((url) => (url.startsWith('/cgi-bin') ? { access_token: 't', expires_in: 7200 } : { errcode: 45009, errmsg: 'limit' }), async () => {
        assert.equal((await moderation.checkTexts(ITEMS, { owner: 'o:oid' })).unavailable, true)
      }))
    await testAsync('access_token 失效 → 强制刷新后重试一次成功', () =>
      withFakeWx(wxHandler('pass', { tokenErrOnce: true }), async (calls) => {
        assert.equal((await moderation.checkTexts(ITEMS, { owner: 'o:oid' })).ok, true)
        assert.equal(calls.token, 2)
        assert.equal(calls.check, 2)
      }))
    await testAsync('access_token 进程内缓存（第二次不再取 token）', () =>
      withFakeWx(wxHandler('pass'), async (calls) => {
        await moderation.checkTexts(ITEMS, { owner: 'o:oid' })
        await moderation.checkTexts(ITEMS, { owner: 'o:oid' })
        assert.equal(calls.token, 1)
      }))
    await testAsync('配了微信但会话没有 openid → unavailable', () =>
      withFakeWx(wxHandler('pass'), async (calls) => {
        assert.equal((await moderation.checkTexts(ITEMS, { owner: 'd:dev12345678' })).unavailable, true)
        assert.equal(calls.check, 0)
      }))
    await testAsync('长文本分段送检，任一段 risky 即拦截', () =>
      withFakeWx((url, body, calls) => {
        if (url.startsWith('/cgi-bin')) return { access_token: 't', expires_in: 7200 }
        calls.check++
        return { errcode: 0, result: { suggest: body.content.includes('X') ? 'risky' : 'pass', label: 20001 } }
      }, async (calls) => {
        const text = 'a'.repeat(1900) + '\n' + 'b'.repeat(1900) + '\nX'
        const r = await moderation.checkTexts([{ field: 'resume', text, scene: 'profile' }], { owner: 'o:oid' })
        assert.equal(r.blocked, true)
        assert.equal(calls.check, 2)
      }))
    await testAsync('skipWechat：只查本地', () =>
      withFakeWx(wxHandler('risky'), async (calls) => {
        assert.deepEqual(await moderation.checkTexts(ITEMS, { owner: 'o:oid', skipWechat: true }), { ok: true, wechatChecked: false })
        assert.equal(calls.check, 0)
      }))

    // 起一个本地假 LLM，验证重试策略
    const withFakeLLM = async (status, fn) => {
      let hits = 0
      const srv = http.createServer((req, res) => {
        hits++
        req.resume()
        res.writeHead(status, { 'Content-Type': 'application/json' })
        res.end(status === 200 ? JSON.stringify({ choices: [{ message: { content: 'no json here' } }] }) : '{}')
      })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const saved = { base: config.LLM_API_BASE, key: config.LLM_API_KEY, retries: config.LLM_RETRIES }
      config.LLM_API_BASE = `http://127.0.0.1:${srv.address().port}`
      config.LLM_API_KEY = 'test'
      config.LLM_RETRIES = 2
      try {
        await fn(() => hits)
      } finally {
        config.LLM_API_BASE = saved.base
        config.LLM_API_KEY = saved.key
        config.LLM_RETRIES = saved.retries
        srv.close()
      }
    }
    await testAsync('LLM 401 不重试（key 错重试也没用）', () =>
      withFakeLLM(401, async (hits) => {
        await assert.rejects(llm.chat({ system: 's', user: 'u' }), /LLM_HTTP_401/)
        assert.equal(hits(), 1)
      })
    )
    await testAsync('LLM 传输错误不被内容层重试叠加（5xx 共 3 次而非 9 次）', () =>
      withFakeLLM(503, async (hits) => {
        await assert.rejects(llm.withShapeRetry(() => llm.chatJSON({ system: 's', user: 'u' }), 2), /LLM_HTTP_503/)
        assert.equal(hits(), 3)
      })
    )
    await testAsync('内容层错误（JSON 抠不出来）会重试', () =>
      withFakeLLM(200, async (hits) => {
        await assert.rejects(llm.withShapeRetry(() => llm.chatJSON({ system: 's', user: 'u' }), 2), /LLM_JSON_NOT_FOUND/)
        assert.equal(hits(), 3)
      })
    )
    await testAsync('超过 deadline 直接放弃，不发请求', () =>
      withFakeLLM(200, async (hits) => {
        await assert.rejects(llm.chat({ system: 's', user: 'u', deadline: Date.now() - 1 }), /LLM_DEADLINE/)
        assert.equal(hits(), 0)
      })
    )

    // ---- 判定批次独立：部分失败不拖垮整份报告 ----
    const { judgeRequirements } = require(S('judge'))
    const mkReqs = (n) => Array.from({ length: n }, (_, i) => ({ id: 'R' + (i + 1), text: '要求' + (i + 1), category: 'skills', weight: 1 }))
    const judgeSpans = [{ id: 'S1', section: 'skills', text: '会 Java' }]
    const withJudgeLLM = async (failWhen, fn) => {
      const srv = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const user = JSON.parse(body).messages[1].content
          if (failWhen(user)) {
            res.writeHead(400)
            return res.end('{}')
          }
          const ids = [...user.matchAll(/^(R\d+) \[/gm)].map((m) => m[1])
          const content = JSON.stringify({ judgments: ids.map((id) => ({ req_id: id, verdict: 'miss', quote: '', quote_id: '', reason: 'x' })) })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        })
      })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const saved = { base: config.LLM_API_BASE, key: config.LLM_API_KEY, mock: config.LLM_MOCK }
      Object.assign(config, { LLM_API_BASE: `http://127.0.0.1:${srv.address().port}`, LLM_API_KEY: 'test', LLM_MOCK: false })
      try {
        await fn()
      } finally {
        Object.assign(config, { LLM_API_BASE: saved.base, LLM_API_KEY: saved.key, LLM_MOCK: saved.mock })
        srv.close()
      }
    }
    await testAsync('判定：1 个批次失败只影响该批，其余正常返回', () =>
      withJudgeLLM((u) => u.includes('R9 ['), async () => {
        const r = await judgeRequirements(judgeSpans, mkReqs(10), new Map())
        assert.equal(r.judgments.length, 8)
        assert.deepEqual(r.failedReqIds, ['R9', 'R10'])
        const v = verifyJudgments(mkReqs(10), judgeSpans, r.judgments, [], r.failedReqIds)
        assert.ok(v[8].flags.includes('judge_failed') && v[8].verdict === 'unclear')
      })
    )
    await testAsync('判定单独用 LLM_JUDGE_MODEL，拆解仍用主模型', async () => {
      const seen = []
      const srv = http.createServer((req, res) => {
        let body = ''
        req.on('data', (c) => (body += c))
        req.on('end', () => {
          const b = JSON.parse(body)
          const user = b.messages[1].content
          const kind = user.includes('<job_description>') ? 'split' : 'judge'
          seen.push(kind + ':' + b.model)
          const content = kind === 'split'
            ? JSON.stringify({ requirements: [{ text: '会 Java', jd_quote: '会 Java', category: 'skills', weight: 1 }] })
            : JSON.stringify({ judgments: [{ req_id: 'R1', verdict: 'miss', quote: '', quote_id: '', reason: 'x' }] })
          res.writeHead(200, { 'Content-Type': 'application/json' })
          res.end(JSON.stringify({ choices: [{ message: { content } }] }))
        })
      })
      await new Promise((r) => srv.listen(0, '127.0.0.1', r))
      const keys = ['LLM_API_BASE', 'LLM_API_KEY', 'LLM_MOCK', 'LLM_MODEL', 'LLM_JUDGE_MODEL']
      const saved = Object.fromEntries(keys.map((k) => [k, config[k]]))
      Object.assign(config, {
        LLM_API_BASE: `http://127.0.0.1:${srv.address().port}`, LLM_API_KEY: 'test', LLM_MOCK: false,
        LLM_MODEL: 'small-model', LLM_JUDGE_MODEL: 'big-model'
      })
      try {
        await runPipeline('工作经历\n会 Java 开发，三年经验，负责后端服务', '岗位要求：会 Java')
        assert.deepEqual(seen, ['split:small-model', 'judge:big-model'])
        // 不设判定模型 → 回落到主模型
        seen.length = 0
        config.LLM_JUDGE_MODEL = ''
        await runPipeline('工作经历\n会 Java 开发，三年经验，负责后端服务', '岗位要求：会 Java')
        assert.deepEqual(seen, ['split:small-model', 'judge:small-model'])
      } finally {
        Object.assign(config, saved)
        srv.close()
      }
    })
    await testAsync('判定：失败比例过高时整份失败（报告已无参考价值）', () =>
      withJudgeLLM((u) => u.includes('R1 ['), async () => {
        await assert.rejects(judgeRequirements(judgeSpans, mkReqs(10), new Map()))
      })
    )

    const resumeText = fs.readFileSync(path.join(ROOT, 'examples', 'resume.txt'), 'utf8')
    const jdText = fs.readFileSync(path.join(ROOT, 'examples', 'jd.txt'), 'utf8')

    const result = await runPipeline(resumeText, jdText)

    test('拆出 ≥3 条要求', () => assert.ok(result.requirements.length >= 3))
    test('每条要求的 jd_quote 都在 JD 原文中', () => {
      for (const r of result.requirements) assert.ok(jdText.includes(r.jdQuote), `${r.id} quote 不在 JD: ${r.jdQuote}`)
    })
    test('判定条数与要求一致', () => assert.equal(result.judgments.length, result.requirements.length))
    test('每条 hit/partial 的引用都能在简历中逐字找到（护城河不漏）', () => {
      for (const j of result.judgments) {
        if (j.verdict === 'hit' || j.verdict === 'partial') {
          assert.ok(j.quote, `${j.reqId} 无引用`)
          assert.ok(j.quoteId.startsWith('S'), `${j.reqId} quote_id 异常`)
          assert.ok(resumeText.includes(j.quote), `${j.reqId} 引用不在原文: ${j.quote}`)
        }
      }
    })
    test('联系方式已被脱敏，不进模型上下文', () => {
      const leaked = result.judgments.some((j) => j.quote.includes('13812345678') || j.quote.includes('zhangsan@example.com'))
      assert.ok(!leaked)
      const spansLeak = JSON.stringify(result.spans)
      assert.ok(!spansLeak.includes('13812345678') && !spansLeak.includes('zhangsan@example.com'))
    })
    test('分数 0~100', () => assert.ok(result.score.overall >= 0 && result.score.overall <= 100))
    test('一句话结论存在', () => assert.ok(result.conclusion && result.conclusion.length >= 8))
    test('spans 已留存（引用上下文弹层数据源）', () => {
      assert.ok(Array.isArray(result.spans) && result.spans.length === result.spanCount)
      assert.ok(result.spans.every((s) => s.id && s.text))
    })

    const again = await runPipeline(resumeText, jdText)
    test('全链路确定性（两次同分同结论）', () => {
      assert.equal(again.score.overall, result.score.overall)
      assert.equal(again.conclusion, result.conclusion)
    })

    await testAsync('JD 拆解缓存：命中时跳过拆解，结果一致', async () => {
      const store = new Map()
      const cache = { get: (k) => store.get(k) || null, set: (k, v) => store.set(k, v) }
      const first = await runPipeline(resumeText, jdText, { jdCache: cache })
      assert.equal(first.jdCacheHit, false)
      assert.equal(store.size, 1)
      // 往缓存里塞一个可识别的结果，证明第二次确实用的是缓存
      const marked = store.get(jdText).slice(0, 2)
      store.set(jdText, marked)
      const second = await runPipeline(resumeText, jdText, { jdCache: cache })
      assert.equal(second.jdCacheHit, true)
      assert.equal(second.requirements.length, 2)
    })
    await testAsync('进度回调按真实阶段触发', async () => {
      const stages = []
      await runPipeline(resumeText, jdText, { onStage: (st) => stages.push(st) })
      assert.deepEqual(stages, ['split', 'judge', 'score'])
    })

    const rewrites = await proposeRewrites(result.requirements, result.judgments)
    test('改写建议可生成且 improve 原句可溯源', () => {
      for (const r of rewrites) {
        if (r.type === 'improve') {
          const j = result.judgments.find((x) => x.reqId === r.reqId)
          assert.ok(j && quoteMatches(r.original, j.quote))
        }
      }
    })

    console.log('\n== 结果速览 ==')
    console.log(`  片段数: ${result.spanCount}`)
    console.log(`  要求数: ${result.requirements.length}（拒收 ${result.rejectionCount} 条）`)
    const byVerdict = {}
    for (const j of result.judgments) byVerdict[j.verdict] = (byVerdict[j.verdict] || 0) + 1
    console.log(`  判定分布: ${JSON.stringify(byVerdict)}`)
    console.log(`  总分: ${result.score.overall}${result.score.capped ? '（触发硬门槛封顶）' : ''}`)
    console.log(`  结论: ${result.conclusion}`)
    console.log(`  雷达: ${result.score.radar.map((r) => `${r.category}=${r.value}`).join(' ')}`)
    console.log(`  改写建议: ${rewrites.length} 条`)

    console.log(`\n结果：${passed} 通过，${failed} 失败`)
    process.exit(failed > 0 ? 1 : 0)
  })().catch((e) => {
    console.error('集成测试崩溃：', e)
    process.exit(1)
  })
