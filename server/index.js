// 本地开发服务：零依赖 Node http 服务器。
// 启动：cd server && npm install（只为 pdfjs-dist）&& node index.js
//       或项目根目录 npm start
//
// 接口一览（业务错误统一 200 + {ok:false, code, message}，便于小程序端统一处理）：
//   GET    /api/health
//   POST   /api/session          {deviceId, code?} → {token, kind}
//   GET    /api/quota            → 今日余量（分析/复制）+ 输入上限
//   POST   /api/analyze          {resumeText, jdText} → {status:'running', jobId} | {status:'done', reportId, report, cached}
//   GET    /api/job/:id          → {status, stage, reportId, report?}（前端轮询）
//   GET    /api/reports          → 我的报告列表
//   GET    /api/report/:id       → 报告全文（含 rewritesStatus：pending/done/failed/none）
//   DELETE /api/report/:id       → 删除
//   POST   /api/report/:id/copy  {index} → 计一次复制（每日限 3 条，同一条不重复计）
//   POST   /api/feedback         {reportId, q1, q2, comment} → 反馈
//   POST   /api/extract-pdf      {dataBase64} → {result:{ok, text|message}}

const http = require('http')
const config = require('./config')
const db = require('./db')
const jobs = require('./jobs')
const { issueToken, verifyToken, identityFor, ipHashOf, bearerToken } = require('./auth')
const limits = require('./limits')
const { runPipeline } = require('./core')
const { proposeRewrites } = require('./rewrite')
const { redact } = require('./redact')
const { normalize } = require('./text')
const { extractFromBuffer } = require('./pdfExtract')

const DAY_MS = 86400e3

function send(res, status, obj) {
  const body = JSON.stringify(obj)
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

const fail = (code, message) => ({ ok: false, code, message })

function readBody(req, cap) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    let tooLarge = false
    req.on('data', (c) => {
      if (tooLarge) return
      size += c.length
      if (size > cap) {
        // 不在这里 destroy：先让调用方把 413 发出去（响应头带 Connection: close），
        // 否则客户端只会看到连接被重置
        tooLarge = true
        chunks.length = 0
        reject(new Error('BODY_TOO_LARGE'))
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (tooLarge) return
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {})
      } catch {
        reject(new Error('BAD_JSON'))
      }
    })
    req.on('error', reject)
  })
}

function auth(req) {
  const sub = verifyToken(bearerToken(req))
  if (!sub) return null
  return { owner: sub, ipHash: ipHashOf(req) }
}

function reportView(doc) {
  // 免费版：全部内容直接下发（裁剪点收口在服务端，将来分层只改这里）
  const { owner, inputHash, ...view } = doc
  return view
}

const VALID_FB = {
  q1: ['accurate', 'partial', 'inaccurate'],
  q2: ['problems', 'rewrites', 'none']
}

// ---------------- 缓存键 ----------------
const { judgeModel } = require('./judge')

// 报告缓存键要包含判定模型：换了判定模型，同一输入应重新分析而不是复用旧报告
const modelTag = () => (config.LLM_MOCK ? 'mock' : `${config.LLM_MODEL}|judge=${judgeModel()}`)
// JD 拆解只用主模型，缓存键不受判定模型影响（换判定模型不必作废 JD 缓存）
const splitModelTag = () => (config.LLM_MOCK ? 'mock' : config.LLM_MODEL)

/** 同一份（脱敏后）简历 + JD + 模型 → 同一份报告。空白差异不算不同输入。 */
function inputHashOf(resume, jd) {
  return db.sha256([modelTag(), normalize(resume), normalize(jd)].join('\u0000'))
}

const jdCache = {
  key: (jdText) => db.sha256(splitModelTag() + '\u0000' + normalize(jdText)),
  get(jdText) {
    return db.getJdCache(this.key(jdText))
  },
  set(jdText, reqs) {
    db.setJdCache(this.key(jdText), reqs)
  }
}

// ---------------- 分析任务 ----------------

async function runAnalyzeJob(job, { resume, jd, owner, usageId, inputHash }) {
  const startedAt = Date.now()
  // 主报告的总时限：超时即失败并退还次数，前端轮询一定能看到终态
  const deadline = startedAt + config.ANALYZE_DEADLINE_MS

  let pipeline
  try {
    pipeline = await runPipeline(resume, jd, {
      deadline,
      jdCache,
      onStage: (stage) => jobs.update(job, { stage })
    })
  } catch (e) {
    db.removeUsage(usageId)
    console.error('pipeline failed:', e.message, config.LLM_MOCK ? '' : '(LLM=' + modelTag() + ')')
    jobs.update(job, { status: 'failed', code: 'ANALYZE_FAILED', message: '分析失败，请稍后重试（本次不消耗免费次数）' })
    return
  }

  const now = Date.now()
  const needRewrites = pipeline.judgments.some((j) => j.verdict === 'partial' || j.verdict === 'miss')
  const doc = {
    reportId: db.newId('r'),
    owner,
    inputHash,
    createdAt: now,
    expiresAt: now + config.REPORT_TTL_DAYS * DAY_MS,
    mock: config.LLM_MOCK,
    score: pipeline.score,
    conclusion: pipeline.conclusion,
    requirements: pipeline.requirements,
    judgments: pipeline.judgments,
    rewrites: [],
    // 改写建议在主报告返回后后台生成，前端看到 pending 会轮询
    rewritesStatus: needRewrites ? 'pending' : 'none',
    spans: pipeline.spans, // 脱敏后的简历行，供"引用点击看上下文"
    spanCount: pipeline.spanCount,
    rejectionCount: pipeline.rejectionCount,
    judgeFailedCount: pipeline.judgeFailedCount,
    jdCacheHit: pipeline.jdCacheHit,
    durationMs: now - startedAt
  }
  db.insertReport(doc)
  db.confirmUsage(usageId)
  jobs.update(job, { status: 'done', stage: 'done', reportId: doc.reportId })

  if (needRewrites) generateRewrites(doc)
}

async function generateRewrites(doc) {
  let patch
  try {
    const rewrites = await proposeRewrites(doc.requirements, doc.judgments, {
      deadline: Date.now() + config.REWRITE_DEADLINE_MS
    })
    patch = { rewrites, rewritesStatus: 'done' }
  } catch (e) {
    console.warn('rewrite failed (主报告不受影响):', e.message)
    patch = { rewritesStatus: 'failed' }
  }
  // 用户可能在生成期间删了报告，updateReport 会返回 false，忽略即可
  db.updateReport(doc.reportId, doc.owner, patch)
}

// ---------------- 路由 ----------------

const routes = {
  'GET /api/health': async (req, res) => {
    send(res, 200, {
      ok: true,
      mock: config.LLM_MOCK,
      model: config.LLM_MOCK ? 'mock' : config.LLM_MODEL,
      judgeModel: config.LLM_MOCK ? 'mock' : judgeModel()
    })
  },

  'POST /api/session': async (req, res, ctx) => {
    const identity = await identityFor(ctx.body)
    if (!identity) return send(res, 200, fail('BAD_IDENTITY', '无法建立会话，请重新进入小程序'))
    send(res, 200, { ok: true, token: issueToken(identity.sub), kind: identity.kind })
  },

  'GET /api/quota': async (req, res, ctx) => {
    send(res, 200, {
      ok: true,
      ...limits.quotaInfo(db, ctx.owner, ctx.ipHash),
      // 输入上限以服务端为准，小程序端据此同步，避免两边配置漂移
      input: { maxResumeChars: config.MAX_RESUME_CHARS, maxJDChars: config.MAX_JD_CHARS }
    })
  },

  'POST /api/analyze': async (req, res, ctx) => {
    const b = ctx.body
    const resumeRaw = String(b.resumeText || '').trim()
    const jdText = String(b.jdText || '').trim()
    if (resumeRaw.length < config.MIN_RESUME_CHARS) {
      return send(res, 200, fail('INVALID_INPUT', `简历内容太短，至少 ${config.MIN_RESUME_CHARS} 字`))
    }
    if (jdText.length < config.MIN_JD_CHARS) {
      return send(res, 200, fail('INVALID_INPUT', `JD 内容太短，至少 ${config.MIN_JD_CHARS} 字`))
    }
    const resume = redact(resumeRaw.slice(0, config.MAX_RESUME_CHARS))
    const jd = jdText.slice(0, config.MAX_JD_CHARS)
    const inputHash = inputHashOf(resume, jd)

    // ① 同一输入已有报告 → 直接复用：不扣次数、不花 API 费，分数也和上次一致
    const existing = db.findReportByInput(ctx.owner, inputHash)
    if (existing) {
      // 上次改写建议没生成出来 → 借这次提交再补一次（不扣次数）
      if (existing.rewritesStatus === 'failed') {
        existing.rewritesStatus = 'pending'
        generateRewrites(existing)
      }
      return send(res, 200, { ok: true, status: 'done', cached: true, reportId: existing.reportId, report: reportView(existing) })
    }

    // ② 同一身份已有任务在跑：同一输入就接着轮询它（连点/重进页面），不同输入请稍候
    const running = jobs.runningFor(ctx.owner)
    if (running) {
      if (running.inputHash === inputHash) return send(res, 200, { ok: true, ...jobs.view(running) })
      return send(res, 200, fail('BUSY', '上一份报告还在分析中，请稍候再提交'))
    }

    // ③ 风控：检查通过后立即"预占"一次额度（同步完成，中间没有 await），
    // 并发请求看到的计数已包含这次；分析失败再退还，保证"失败不扣次数"
    const now = Date.now()
    const lim = limits.checkAnalyze(db, ctx.owner, ctx.ipHash, now)
    if (!lim.ok) return send(res, 200, lim)
    const usageId = db.recordUsage('analyze', ctx.owner, ctx.ipHash, now, { pending: true })

    const job = jobs.create(ctx.owner, inputHash)
    runAnalyzeJob(job, { resume, jd, owner: ctx.owner, usageId, inputHash }).catch((e) => {
      // runAnalyzeJob 内部已兜底，这里只防意外
      console.error('job crashed:', e)
      db.removeUsage(usageId)
      jobs.update(job, { status: 'failed', code: 'ANALYZE_FAILED', message: '分析失败，请稍后重试（本次不消耗免费次数）' })
    })
    send(res, 200, { ok: true, ...jobs.view(job) })
  },

  'GET /api/job/:id': async (req, res, ctx) => {
    const job = jobs.get(ctx.params.id, ctx.owner)
    if (!job) return send(res, 200, fail('JOB_NOT_FOUND', '分析任务已失效，请重新提交（未完成的任务不消耗次数）'))
    const out = { ok: true, ...jobs.view(job) }
    // 完成时把报告一起带回，报告页不用再请求一次
    if (job.status === 'done') {
      const doc = db.getReport(job.reportId)
      if (doc && doc.owner === ctx.owner) out.report = reportView(doc)
    }
    send(res, 200, out)
  },

  'GET /api/reports': async (req, res, ctx) => {
    const list = db.reportsByOwner(ctx.owner).map((r) => ({
      reportId: r.reportId,
      overall: r.score ? r.score.overall : 0,
      conclusion: r.conclusion || '',
      createdAt: r.createdAt
    }))
    send(res, 200, { ok: true, reports: list })
  },

  'GET /api/report/:id': async (req, res, ctx) => {
    const doc = db.getReport(ctx.params.id)
    if (!doc || doc.owner !== ctx.owner) return send(res, 200, fail('NOT_FOUND', '报告不存在或已被删除'))
    if (doc.expiresAt < Date.now()) return send(res, 200, fail('EXPIRED', '报告已过期（保留 30 天）'))
    send(res, 200, { ok: true, report: reportView(doc) })
  },

  'DELETE /api/report/:id': async (req, res, ctx) => {
    const removed = db.removeReport(ctx.params.id, ctx.owner)
    if (!removed) return send(res, 200, fail('NOT_FOUND', '报告不存在或已被删除'))
    send(res, 200, { ok: true })
  },

  'POST /api/report/:id/copy': async (req, res, ctx) => {
    const doc = db.getReport(ctx.params.id)
    if (!doc || doc.owner !== ctx.owner) return send(res, 200, fail('NOT_FOUND', '报告不存在或已被删除'))
    const idx = Number(ctx.body.index)
    if (!Array.isArray(doc.rewrites) || !Number.isInteger(idx) || idx < 0 || idx >= doc.rewrites.length) {
      return send(res, 200, fail('BAD_INDEX', '改写建议不存在'))
    }
    // 同一份报告的同一条改写句，今天已经复制过 → 不重复计数
    const ref = `${doc.reportId}#${idx}`
    if (db.countUsage({ kind: 'copy', owner: ctx.owner, ref }, limits.dayStart(Date.now())) > 0) {
      const q = limits.quotaInfo(db, ctx.owner, ctx.ipHash)
      return send(res, 200, { ok: true, remaining: q.copies.remaining, limit: q.copies.limit, repeated: true })
    }
    const check = limits.checkCopy(db, ctx.owner)
    if (!check.ok) return send(res, 200, check)
    db.recordUsage('copy', ctx.owner, ctx.ipHash, Date.now(), { ref })
    send(res, 200, { ok: true, remaining: check.remaining, limit: check.limit })
  },

  'POST /api/feedback': async (req, res, ctx) => {
    const b = ctx.body
    const reportId = String(b.reportId || '')
    const doc = db.getReport(reportId)
    if (!doc || doc.owner !== ctx.owner) return send(res, 200, fail('NOT_FOUND', '报告不存在或已被删除'))
    const q1 = b.q1
    const q2 = b.q2 || 'none'
    if (!VALID_FB.q1.includes(q1)) return send(res, 200, fail('BAD_FEEDBACK', '反馈第 1 题选项无效'))
    if (!VALID_FB.q2.includes(q2)) return send(res, 200, fail('BAD_FEEDBACK', '反馈第 2 题选项无效'))
    const comment = typeof b.comment === 'string' ? b.comment.trim().slice(0, 300) : ''
    db.upsertFeedback({ owner: ctx.owner, reportId, q1, q2, comment, createdAt: Date.now() })
    send(res, 200, { ok: true })
  },

  'POST /api/extract-pdf': async (req, res, ctx) => {
    const data = String(ctx.body.dataBase64 || '')
    if (!data) return send(res, 200, fail('INVALID_INPUT', '缺少文件内容'))
    const buf = Buffer.from(data, 'base64')
    if (buf.length > config.MAX_PDF_BYTES) {
      return send(res, 200, fail('TOO_LARGE', '文件超过 5MB，请压缩后重试'))
    }
    if (buf.subarray(0, 5).toString('latin1') !== '%PDF-') {
      return send(res, 200, fail('INVALID_INPUT', '不是有效的 PDF 文件，请直接粘贴简历文本'))
    }
    const lim = limits.checkPdf(db, ctx.owner)
    if (!lim.ok) return send(res, 200, lim)
    db.recordUsage('pdf', ctx.owner, ctx.ipHash, Date.now())
    // 解析结果的 ok:false（扫描件/加密）是正常降级，放在 result 里，不当作接口错误
    const result = await extractFromBuffer(buf)
    send(res, 200, { ok: true, result })
  }
}

const BODY_CAP_DEFAULT = 1 * 1024 * 1024
const BODY_CAP_LARGE = 7 * 1024 * 1024 // extract-pdf：5MB 文件的 base64 约 6.7MB

// 动态路由：/api/report/:id、/api/report/:id/copy、/api/job/:id
const DYNAMIC = [
  [/^\/api\/report\/([\w-]+)$/, '/api/report/:id'],
  [/^\/api\/report\/([\w-]+)\/copy$/, '/api/report/:id/copy'],
  [/^\/api\/job\/([\w-]+)$/, '/api/job/:id']
]

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  const routeKey = `${req.method} ${url.pathname}`
  console.log(`${new Date().toISOString()} ${routeKey}`)

  try {
    let handler = routes[routeKey]
    let params = {}
    if (!handler) {
      for (const [re, pattern] of DYNAMIC) {
        const m = url.pathname.match(re)
        if (m) {
          params = { id: m[1] }
          handler = routes[`${req.method} ${pattern}`] || null
          break
        }
      }
    }
    if (!handler) return send(res, 404, fail('NOT_FOUND', '接口不存在'))

    let ctx = { params, body: {} }
    if (req.method === 'POST') {
      const isPdf = url.pathname === '/api/extract-pdf'
      ctx.body = await readBody(req, isPdf ? BODY_CAP_LARGE : BODY_CAP_DEFAULT)
    } else if (req.method !== 'GET' && req.method !== 'DELETE') {
      return send(res, 405, fail('BAD_METHOD', '不支持的请求方法'))
    }

    // 需要登录态的接口（session 与 health 除外）
    const openPaths = ['/api/health', '/api/session']
    if (!openPaths.includes(url.pathname)) {
      const a = auth(req)
      if (!a) return send(res, 401, fail('UNAUTHORIZED', '会话已过期，请重试'))
      ctx = { ...ctx, ...a }
    }

    await handler(req, res, ctx)
  } catch (e) {
    if (e.message === 'BODY_TOO_LARGE') {
      res.setHeader('Connection', 'close')
      send(res, 413, fail('BODY_TOO_LARGE', '请求内容过大'))
      res.on('finish', () => req.destroy())
      return
    }
    if (e.message === 'BAD_JSON') return send(res, 400, fail('BAD_JSON', '请求数据格式错误'))
    console.error('server error:', e)
    send(res, 500, fail('INTERNAL', '服务开小差了，请稍后再试'))
  }
})

// ---------------- 启动 ----------------
// 清理过期数据 + 上次中途退出留下的半成品状态
const pruned = db.prune(Date.now())
if (pruned > 0) console.log(`启动清理：删除 ${pruned} 份过期报告`)
const released = db.releasePendingUsage()
if (released > 0) console.log(`启动清理：退还 ${released} 次未完成分析的预占额度`)
for (const r of db.data.reports) {
  if (r.rewritesStatus === 'pending') r.rewritesStatus = 'failed' // 生成改写的进程已经不在了
}
db.save()
setInterval(() => db.prune(Date.now()), DAY_MS).unref()
setInterval(() => jobs.sweep(), 60e3).unref()

const nodeMajor = Number(process.versions.node.split('.')[0])
if (nodeMajor < 18) {
  console.warn(`⚠ 当前 Node ${process.versions.node}：pdfjs-dist 需要 Node 18+，PDF 上传将不可用（粘贴文本不受影响）`)
}

server.listen(config.PORT, () => {
  console.log(`AI 简历分析服务已启动: http://127.0.0.1:${config.PORT}`)
  if (config.LLM_MOCK) {
    console.log('⚠ 当前为 MOCK 模式（未配置 LLM_API_KEY 或 LLM_MOCK=1），用启发式规则代替模型')
  } else {
    console.log(`模型: ${config.LLM_MODEL}（拆解/改写） + ${judgeModel()}（判定） @ ${config.LLM_API_BASE}`)
  }
  if (!config.WX_APPID) {
    console.log('⚠ 未配置 WX_APPID/WX_APPSECRET，身份用设备 ID 兜底（风控含 IP 限制）')
  }
})
