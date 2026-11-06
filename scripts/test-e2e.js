// HTTP 端到端测试：起真实服务（mock 模型、临时数据目录），走一遍
// 分析 → 逐条判错 → 整份反馈 → 用户删除 → 后台登录查看，验证留存规则与后台鉴权。
// 运行：npm test（在 test-local 之后）或 node scripts/test-e2e.js

const { spawn } = require('child_process')
const fs = require('fs')
const os = require('os')
const path = require('path')
const http = require('http')
const net = require('net')
const assert = require('assert')

const ROOT = path.join(__dirname, '..')
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer()
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address()
      srv.close(() => resolve(port))
    })
    srv.on('error', reject)
  })
}

/** 发请求，返回 { status, headers, json } */
function request(base, method, p, { body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body))
    const req = http.request(base + p, { method, headers: { ...(data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {}), ...headers } }, (res) => {
      let d = ''
      res.setEncoding('utf8')
      res.on('data', (c) => (d += c))
      res.on('end', () => {
        let json = null
        try {
          json = JSON.parse(d)
        } catch {}
        resolve({ status: res.statusCode, headers: res.headers, json, text: d })
      })
    })
    req.on('error', reject)
    req.end(data)
  })
}

async function startServer(extraEnv) {
  const port = await freePort()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-e2e-'))
  const env = {
    ...process.env,
    PORT: String(port),
    DATA_DIR: dataDir,
    LLM_MOCK: '1',
    WX_APPID: '',
    WX_APPSECRET: '',
    ADMIN_PASSWORD: '',
    ...extraEnv
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'index.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (c) => (log += c))
  child.stderr.on('data', (c) => (log += c))
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; i < 50; i++) {
    try {
      const r = await request(base, 'GET', '/api/health')
      if (r.status === 200) break
    } catch {}
    await sleep(100)
  }
  return {
    base,
    log: () => log,
    stop() {
      child.kill()
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

async function session(base, deviceId) {
  const r = await request(base, 'POST', '/api/session', { body: { deviceId } })
  return { Authorization: 'Bearer ' + r.json.token }
}

const RESUME = fs.readFileSync(path.join(ROOT, 'examples', 'resume.txt'), 'utf8')
const JD = fs.readFileSync(path.join(ROOT, 'examples', 'jd.txt'), 'utf8')

async function analyze(base, auth, resumeText = RESUME) {
  const r = await request(base, 'POST', '/api/analyze', { body: { resumeText, jdText: JD }, headers: auth })
  if (r.json.reportId) return r.json.reportId
  for (let i = 0; i < 50; i++) {
    const j = await request(base, 'GET', '/api/job/' + r.json.jobId, { headers: auth })
    if (j.json.status === 'done') return j.json.reportId
    if (j.json.status === 'failed') throw new Error('分析失败：' + j.json.message)
    await sleep(100)
  }
  throw new Error('分析超时')
}

async function adminLogin(base, password) {
  const r = await request(base, 'POST', '/admin/api/login', { body: { password } })
  const set = (r.headers['set-cookie'] || [])[0] || ''
  return { r, cookie: set.split(';')[0] }
}

;(async () => {
  console.log('\n== 端到端：后台开关与鉴权 ==')
  const A = await startServer({})
  const B = await startServer({ ADMIN_PASSWORD: 'test-admin' })
  const C = await startServer({ ADMIN_PASSWORD: 'test-admin' })
  try {
    await testAsync('未设 ADMIN_PASSWORD：/admin 与登录接口都是 404', async () => {
      assert.equal((await request(A.base, 'GET', '/admin')).status, 404)
      assert.equal((await request(A.base, 'POST', '/admin/api/login', { body: { password: 'x' } })).status, 404)
    })
    await testAsync('未登录访问后台接口 → 401', async () => {
      const r = await request(B.base, 'GET', '/admin/api/summary')
      assert.equal(r.status, 401)
      assert.equal(r.json.code, 'UNAUTHORIZED')
    })
    await testAsync('后台页面可访问且不缓存', async () => {
      const r = await request(B.base, 'GET', '/admin')
      assert.equal(r.status, 200)
      assert.ok(/text\/html/.test(r.headers['content-type']))
      assert.equal(r.headers['cache-control'], 'no-store')
    })
    await testAsync('错误密码 5 次后锁定（正确密码也拒绝）', async () => {
      for (let i = 0; i < 5; i++) assert.equal((await adminLogin(C.base, 'wrong')).r.json.code, 'BAD_PASSWORD')
      assert.equal((await adminLogin(C.base, 'test-admin')).r.json.code, 'LOCKED')
    })
    await testAsync('小程序 token 不能当后台 cookie 用', async () => {
      const auth = await session(B.base, 'dtest12345678')
      const token = auth.Authorization.slice(7)
      const r = await request(B.base, 'GET', '/admin/api/summary', { headers: { Cookie: 'admin_session=' + token } })
      assert.equal(r.status, 401)
    })

    await testAsync('并发爆破：同时发 20 次错误密码，最多 5 次得到"密码错误"', async () => {
      const D = await startServer({ ADMIN_PASSWORD: 'test-admin' })
      try {
        // 先把 20 个请求的请求头都发出去，稍后再发 body：所有请求都在第一次失败被记下之前通过锁定检查
        const slowLogin = () =>
          new Promise((resolve, reject) => {
            const body = Buffer.from(JSON.stringify({ password: 'wrong' }))
            const req = http.request(D.base + '/admin/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': body.length } }, (res) => {
              let d = ''
              res.on('data', (c) => (d += c))
              res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(d) }))
            })
            req.on('error', reject)
            req.flushHeaders()
            setTimeout(() => req.end(body), 300)
          })
        const rs = await Promise.all(Array.from({ length: 20 }, slowLogin))
        const bad = rs.filter((x) => x.json.code === 'BAD_PASSWORD').length
        assert.ok(bad <= 5, `BAD_PASSWORD ${bad} 次`)
        assert.ok(rs.every((x) => x.status === 200))
      } finally {
        D.stop()
      }
    })
    await testAsync('删除后再写报告（改写建议生成完成）被拒绝，不写回简历原句', async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-db-'))
      try {
        const script = `
          const db = require(${JSON.stringify(path.join(ROOT, 'server', 'db'))})
          const doc = { reportId: 'r1', owner: 'u1', inputHash: 'h', createdAt: Date.now(), expiresAt: Date.now() + 1e9, retained: false,
            spans: [{ id: 'S1', text: 'secret' }], judgments: [{ reqId: 'R1', verdict: 'hit', quote: 'secret', quoteId: 'S1' }],
            requirements: [{ id: 'R1' }], rewrites: [], rewritesStatus: 'pending' }
          db.insertReport(doc)
          db.setWrongItem('u1', 'r1', 'R1', true)
          db.removeReport('r1', 'u1')
          // generateRewrites 在 await 之后用 doc.owner 写回
          const a = db.updateReport(doc.reportId, doc.owner, { rewrites: [{ original: 'secret' }], rewritesStatus: 'done' })
          const b = db.updateReport('r1', 'u1', { rewrites: [{ original: 'secret' }] })
          console.log(JSON.stringify({ a, b, rewrites: db.getReport('r1').rewrites }))
          db.flush()`
        const out = require('child_process').execFileSync(process.execPath, ['-e', script], { env: { ...process.env, DATA_DIR: dir, LLM_MOCK: '1' } }).toString()
        const r = JSON.parse(out.trim().split('\n').pop())
        assert.equal(r.a, false)
        assert.equal(r.b, false)
        assert.deepEqual(r.rewrites, [])
      } finally {
        fs.rmSync(dir, { recursive: true, force: true })
      }
    })

    let cookie = ''
    await testAsync('正确登录 → HttpOnly cookie，后台接口可用', async () => {
      const { r, cookie: c } = await adminLogin(B.base, 'test-admin')
      assert.equal(r.json.ok, true)
      const set = r.headers['set-cookie'][0]
      assert.ok(/HttpOnly/i.test(set) && /SameSite=Strict/i.test(set) && /Max-Age=43200/.test(set))
      cookie = c
      const s = await request(B.base, 'GET', '/admin/api/summary', { headers: { Cookie: cookie } })
      assert.equal(s.json.ok, true)
    })
    const adm = { Cookie: () => cookie }

    console.log('\n== 端到端：判错 / 反馈 / 删除 / 后台查看 ==')
    const user = await session(B.base, 'duser0000001')
    const other = await session(B.base, 'dother000001')
    let rid = ''
    await testAsync('逐条判错：标记后随报告返回 wrongItems', async () => {
      rid = await analyze(B.base, user)
      const f = await request(B.base, 'POST', `/api/report/${rid}/flag`, { body: { reqId: 'R1', wrong: true }, headers: user })
      assert.deepEqual(f.json, { ok: true, wrongItems: ['R1'] })
      const g = await request(B.base, 'GET', '/api/report/' + rid, { headers: user })
      assert.deepEqual(g.json.report.wrongItems, ['R1'])
      assert.equal(g.json.report.meta, undefined) // 诊断信息不下发给用户
    })
    await testAsync('判错：不存在的要求 → BAD_REQ；别人的报告 → NOT_FOUND', async () => {
      const a = await request(B.base, 'POST', `/api/report/${rid}/flag`, { body: { reqId: 'R99', wrong: true }, headers: user })
      assert.equal(a.json.code, 'BAD_REQ')
      const b = await request(B.base, 'POST', `/api/report/${rid}/flag`, { body: { reqId: 'R1', wrong: true }, headers: other })
      assert.equal(b.json.code, 'NOT_FOUND')
    })
    await testAsync('整份反馈：留言脱敏入库、HTML 原样保存为文本、不覆盖判错', async () => {
      const comment = '电话 13812345678 <img src=x onerror=alert(1)>'
      const r = await request(B.base, 'POST', '/api/feedback', { body: { reportId: rid, q1: 'inaccurate', q2: 'problems', comment }, headers: user })
      assert.equal(r.json.ok, true)
      const d = await request(B.base, 'GET', '/admin/api/report/' + rid, { headers: { Cookie: adm.Cookie() } })
      assert.ok(d.json.feedback.comment.includes('[PHONE]'))
      assert.ok(!d.json.feedback.comment.includes('13812345678'))
      assert.ok(d.json.feedback.comment.includes('<img src=x onerror=alert(1)>'))
      assert.deepEqual(d.json.feedback.wrongItems.map((w) => w.reqId), ['R1'])
      assert.equal(d.json.feedback.owner, undefined)
      assert.equal(d.json.report.owner, undefined)
    })
    await testAsync('后台列表：包含该报告、状态 ok、记录了版本', async () => {
      const l = await request(B.base, 'GET', '/admin/api/feedback?q1=inaccurate&hasWrong=1', { headers: { Cookie: adm.Cookie() } })
      const row = l.json.rows.find((x) => x.reportId === rid)
      assert.ok(row)
      assert.equal(row.status, 'ok')
      assert.ok(/^mock\|jd-split@[0-9a-f]{8}\|judge@[0-9a-f]{8}$/.test(row.version))
      assert.ok(l.json.versions.includes(row.version))
    })
    await testAsync('用户删除有反馈的报告：用户侧消失；后台仅剩判定与反馈，无简历内容', async () => {
      const del = await request(B.base, 'DELETE', '/api/report/' + rid, { headers: user })
      assert.equal(del.json.ok, true)
      assert.equal((await request(B.base, 'GET', '/api/report/' + rid, { headers: user })).json.code, 'NOT_FOUND')
      const d = await request(B.base, 'GET', '/admin/api/report/' + rid, { headers: { Cookie: adm.Cookie() } })
      assert.equal(d.json.status, 'deleted')
      assert.equal(d.json.report.spans, undefined)
      assert.deepEqual(d.json.report.rewrites, [])
      assert.ok(d.json.report.judgments.every((j) => j.quote === '' && j.quoteId === ''))
      assert.ok(d.json.report.judgments.some((j) => j.reason))
      assert.equal(d.json.feedback.q1, 'inaccurate')
    })
    await testAsync('已删除的报告不能再标记判错 → NOT_FOUND', async () => {
      const f = await request(B.base, 'POST', `/api/report/${rid}/flag`, { body: { reqId: 'R1', wrong: false }, headers: user })
      assert.equal(f.json.code, 'NOT_FOUND')
    })
    await testAsync('删除后改写建议的后台生成不会写回已脱敏的报告', async () => {
      const rid2 = await analyze(B.base, user, RESUME + '\n补充：熟悉 Go 语言。')
      await request(B.base, 'POST', `/api/report/${rid2}/flag`, { body: { reqId: 'R1', wrong: true }, headers: user })
      await request(B.base, 'DELETE', '/api/report/' + rid2, { headers: user })
      await sleep(2000)
      const d = await request(B.base, 'GET', '/admin/api/report/' + rid2, { headers: { Cookie: adm.Cookie() } })
      assert.equal(d.json.status, 'deleted')
      assert.deepEqual(d.json.report.rewrites, [])
    })
    await testAsync('未反馈的报告被用户删除：后台也查不到', async () => {
      const rid3 = await analyze(B.base, other)
      await request(B.base, 'DELETE', '/api/report/' + rid3, { headers: other })
      const d = await request(B.base, 'GET', '/admin/api/report/' + rid3, { headers: { Cookie: adm.Cookie() } })
      assert.equal(d.json.code, 'NOT_FOUND')
    })
    await testAsync('退出登录后 cookie 失效', async () => {
      const r = await request(B.base, 'POST', '/admin/api/logout', { headers: { Cookie: adm.Cookie() } })
      assert.ok(/Max-Age=0/.test(r.headers['set-cookie'][0]))
    })
  } finally {
    A.stop()
    B.stop()
    C.stop()
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
})().catch((e) => {
  console.error('端到端测试崩溃：', e)
  process.exit(1)
})
