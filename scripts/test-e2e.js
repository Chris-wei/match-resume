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

async function startServer(extraEnv, opts = {}) {
  const port = await freePort()
  const dataDir = opts.dataDir || fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-e2e-'))
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
    dataDir,
    stop() {
      child.kill()
      if (!opts.keepDir) fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }
}

async function session(base, deviceId) {
  const r = await request(base, 'POST', '/api/session', { body: { deviceId } })
  return { Authorization: 'Bearer ' + r.json.token }
}

// 模拟微信接口：code2session 返回 openid = 'oid-' + code；内容安全一律放行
async function startMockWx() {
  const srv = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x')
    let body
    if (url.pathname === '/sns/jscode2session') body = { openid: 'oid-' + url.searchParams.get('js_code') }
    else if (url.pathname === '/cgi-bin/stable_token') body = { access_token: 'tok', expires_in: 7200 }
    else if (url.pathname === '/wxa/msg_sec_check') body = { errcode: 0, result: { suggest: 'pass', label: 100 } }
    else body = { errcode: 404 }
    req.resume()
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    })
  })
  await new Promise((r) => srv.listen(0, '127.0.0.1', r))
  return { base: `http://127.0.0.1:${srv.address().port}`, close: () => srv.close() }
}

async function wxSession(base, code) {
  const r = await request(base, 'POST', '/api/session', { body: { code } })
  assert.equal(r.json.kind, 'openid')
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

async function adminLogin(base, password, username) {
  const body = username === undefined ? { password } : { username, password }
  const r = await request(base, 'POST', '/admin/api/login', { body })
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

    await testAsync('配置 ADMIN_USERNAME：账号与密码都匹配才能登录', async () => {
      const E = await startServer({ ADMIN_PASSWORD: 'test-admin', ADMIN_USERNAME: 'boss' })
      try {
        assert.equal((await request(E.base, 'GET', '/admin/api/config')).json.usernameRequired, true)
        // 账号错、密码对 → 拒绝，提示不泄露哪一半不对
        const wu = await adminLogin(E.base, 'test-admin', 'nobody')
        assert.equal(wu.r.json.code, 'BAD_PASSWORD')
        assert.equal(wu.r.json.message, '账号或密码错误')
        // 密码错、账号对 → 拒绝（此时已失败 2 次，未到 5 次锁定线）
        assert.equal((await adminLogin(E.base, 'wrong', 'boss')).r.json.code, 'BAD_PASSWORD')
        // 旧客户端只发密码不带账号 → 拒绝
        assert.equal((await adminLogin(E.base, 'test-admin')).r.json.code, 'BAD_PASSWORD')
        // 账号+密码都对 → 发会话，cookie 能访问后台接口
        const ok = await adminLogin(E.base, 'test-admin', 'boss')
        assert.equal(ok.r.json.ok, true)
        const r = await request(E.base, 'GET', '/admin/api/summary', { headers: { Cookie: ok.cookie } })
        assert.equal(r.status, 200)
      } finally {
        E.stop()
      }
    })
    await testAsync('仅配密码：config 报 usernameRequired=false，登录请求带上账号字段也被忽略（向后兼容）', async () => {
      const cfg = await request(B.base, 'GET', '/admin/api/config')
      assert.equal(cfg.json.usernameRequired, false)
      assert.equal((await adminLogin(B.base, 'test-admin', 'ignored')).r.json.ok, true)
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

  console.log('\n== 端到端：内测白名单（含后台配置）==')
  // 固定数据目录 + keepDir：最后要重启服务验证白名单持久化
  const WL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-resume-wl-'))
  // 白名单只认 openid：用模拟微信接口拿真实的 openid 会话
  const WX = await startMockWx()
  const WXENV = { WX_APPID: 'wx-test', WX_APPSECRET: 'wx-secret', WX_API_BASE: WX.base }
  const W = await startServer({
    ...WXENV,
    LIMIT_WHITELIST: 'oid-wltester01',
    ADMIN_PASSWORD: 'pw-admin-test',
    // 把 IP 维度上限调高：本用例只验证身份维度的豁免与拦截；
    // 10 分钟窗也调高：窗口限先于日限生效，不调高第 4 次会先看到 RATE_LIMITED（连刷提示），轮不到日限
    ANALYZE_PER_IP_PER_DAY: 100,
    ANALYZE_PER_IP_PER_10MIN: 100,
    ANALYZE_PER_IDENTITY_PER_10MIN: 10
  }, { dataDir: WL_DIR, keepDir: true })
  try {
    await testAsync('白名单 openid：第 4 次分析（超每日 3 次）照常出报告，quota 显示不限次', async () => {
      const auth = await wxSession(W.base, 'wltester01')
      // 每次换简历内容：同输入会直接复用旧报告、不占额度，测不出限流
      for (let i = 0; i < 4; i++) await analyze(W.base, auth, RESUME + `\n补充：参与过内测项目 ${i}。`)
      const q = await request(W.base, 'GET', '/api/quota', { headers: auth })
      assert.equal(q.json.unlimited, true)
      assert.equal(q.json.analyze.remaining, null)
    })
    await testAsync('非白名单 openid：第 4 次被身份日限拒绝', async () => {
      const auth = await wxSession(W.base, 'plaintester1')
      for (let i = 0; i < 3; i++) await analyze(W.base, auth, RESUME + `\n补充：参与过内测项目 ${i}。`)
      const r = await request(W.base, 'POST', '/api/analyze', {
        body: { resumeText: RESUME + '\n补充：参与过内测项目 X。', jdText: JD },
        headers: auth
      })
      assert.equal(r.json.code, 'QUOTA_EXCEEDED')
    })
    await testAsync('health 暴露白名单条数（不暴露条目）', async () => {
      const h = await request(W.base, 'GET', '/api/health')
      assert.equal(h.json.limitWhitelist, 1)
    })
    await testAsync('未登录管理白名单 → 401；登录后 GET 看到 env 种子已入库', async () => {
      const r = await request(W.base, 'GET', '/admin/api/whitelist')
      assert.equal(r.status, 401)
      const adm = await adminLogin(W.base, 'pw-admin-test')
      const g = await request(W.base, 'GET', '/admin/api/whitelist', { headers: { Cookie: adm.cookie } })
      assert.deepEqual(g.json.entries, ['oid-wltester01'])
    })
    await testAsync('后台添加：非法条目整批拒绝；合法条目即时生效（无需重启）', async () => {
      const adm = await adminLogin(W.base, 'pw-admin-test')
      const h = { Cookie: adm.cookie, 'Content-Type': 'application/json' }
      const bad = await request(W.base, 'POST', '/admin/api/whitelist', { headers: h, body: { add: 'oid-newtester1, 坏.条目' } })
      assert.equal(bad.json.code, 'BAD_ENTRY')
      const dev = await request(W.base, 'POST', '/admin/api/whitelist', { headers: h, body: { add: 'd:some-device-123' } })
      assert.equal(dev.json.code, 'BAD_ENTRY') // 设备 ID 不能加白
      const ok = await request(W.base, 'POST', '/admin/api/whitelist', { headers: h, body: { add: 'o:oid-newtester1' } })
      assert.deepEqual(ok.json.entries, ['oid-wltester01', 'oid-newtester1']) // o: 前缀入库时去掉
      const auth = await wxSession(W.base, 'newtester1')
      const q = await request(W.base, 'GET', '/api/quota', { headers: auth })
      assert.equal(q.json.unlimited, true)
    })
    await testAsync('后台移除：立即恢复限次，当日已用次数照算', async () => {
      const adm = await adminLogin(W.base, 'pw-admin-test')
      const h = { Cookie: adm.cookie, 'Content-Type': 'application/json' }
      const r = await request(W.base, 'POST', '/admin/api/whitelist', { headers: h, body: { remove: 'oid-wltester01' } })
      assert.deepEqual(r.json.entries, ['oid-newtester1'])
      const auth = await wxSession(W.base, 'wltester01')
      const q = await request(W.base, 'GET', '/api/quota', { headers: auth })
      assert.equal(q.json.unlimited, false)
      assert.equal(q.json.analyze.remaining, 0) // 本用例开头已分析 4 次，超过每日 3 次
    })
    await testAsync('运行参数：未登录 401；登录后 GET 到默认值 3', async () => {
      const r = await request(W.base, 'GET', '/admin/api/settings')
      assert.equal(r.status, 401)
      const adm = await adminLogin(W.base, 'pw-admin-test')
      const g = await request(W.base, 'GET', '/admin/api/settings', { headers: { Cookie: adm.cookie } })
      assert.equal(g.json.settings.find((x) => x.field === 'analyzePerIdentityPerDay').value, 3)
    })
    await testAsync('运行参数：改成 2 后立即生效（第 3 次被日限拒）；非法值被拒', async () => {
      const adm = await adminLogin(W.base, 'pw-admin-test')
      const h = { Cookie: adm.cookie, 'Content-Type': 'application/json' }
      const bad = await request(W.base, 'POST', '/admin/api/settings', { headers: h, body: { field: 'analyzePerIdentityPerDay', value: 101 } })
      assert.equal(bad.json.code, 'BAD_VALUE')
      const ok = await request(W.base, 'POST', '/admin/api/settings', { headers: h, body: { field: 'analyzePerIdentityPerDay', value: 2 } })
      assert.equal(ok.json.settings.find((x) => x.field === 'analyzePerIdentityPerDay').value, 2)
      const auth = await wxSession(W.base, 'limit2tester')
      await analyze(W.base, auth, RESUME + '\n补充：参与过限次验证项目 A。')
      await analyze(W.base, auth, RESUME + '\n补充：参与过限次验证项目 B。')
      const r3 = await request(W.base, 'POST', '/api/analyze', {
        body: { resumeText: RESUME + '\n补充：参与过限次验证项目 C。', jdText: JD },
        headers: auth
      })
      assert.equal(r3.json.code, 'QUOTA_EXCEEDED')
      // 留成 5：重启用例要验证运行参数也随库恢复（默认值是 3，5 才能证明来自库）
      const set5 = await request(W.base, 'POST', '/admin/api/settings', { headers: h, body: { field: 'analyzePerIdentityPerDay', value: 5 } })
      assert.equal(set5.json.settings.find((x) => x.field === 'analyzePerIdentityPerDay').value, 5)
    })
    await testAsync('重启后白名单与运行参数都在：以库为准，env 未配也生效', async () => {
      W.stop()
      const W2 = await startServer({ ...WXENV, ANALYZE_PER_IP_PER_DAY: 100, ANALYZE_PER_IP_PER_10MIN: 100 }, { dataDir: WL_DIR })
      try {
        const auth = await wxSession(W2.base, 'newtester1')
        const q = await request(W2.base, 'GET', '/api/quota', { headers: auth })
        assert.equal(q.json.unlimited, true)
        const fresh = await wxSession(W2.base, 'freshtester1')
        const qf = await request(W2.base, 'GET', '/api/quota', { headers: fresh })
        assert.equal(qf.json.analyze.limit, 5) // 运行参数随库恢复（默认 3，上面改成 5）
        const h = await request(W2.base, 'GET', '/api/health')
        assert.equal(h.json.limitWhitelist, 1)
      } finally {
        W2.stop()
      }
    })
  } finally {
    W.stop()
    WX.close()
    fs.rmSync(WL_DIR, { recursive: true, force: true })
  }

  console.log(`\n结果：${passed} 通过，${failed} 失败`)
  process.exit(failed > 0 ? 1 : 0)
})().catch((e) => {
  console.error('端到端测试崩溃：', e)
  process.exit(1)
})
