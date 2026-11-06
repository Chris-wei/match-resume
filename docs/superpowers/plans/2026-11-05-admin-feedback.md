# 网页后台 + 反馈数据留存 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 有反馈的报告长期（脱敏）保留、小程序可逐条标记判错、开发者能在 `/admin` 网页后台看反馈列表与报告诊断详情。

**Architecture:** 数据生命周期（迁移 / 清理 / 用户删除 / 反馈合并）写成操作 `db.data` 的纯函数模块，db.js 只负责调用 + 落盘，便于不碰磁盘单测。后台是同一 Node 服务里的 `/admin` 路由（`server/admin.js`）+ 一个无构建的静态页（`server/admin.html`），查询逻辑放纯函数模块 `server/adminQuery.js`。

**Tech Stack:** Node 18+ 内置模块（零依赖）、微信小程序原生框架、原生 HTML/JS。

**Spec:** `docs/superpowers/specs/2026-11-05-admin-feedback-design.md`（实现者必须先读）

## Global Constraints

- 服务端零依赖（只允许已有的 pdfjs-dist）；后台页面单个 HTML + 原生 JS + 内联 CSS，无构建
- 存储仍是 `data/db.json`（`db.data` 内存为准 + `db.save()` 合并落盘）
- 业务错误沿用 HTTP 200 + `{ok:false, code, message}`；后台未登录返回 HTTP 401
- `ADMIN_PASSWORD` 未设置时 `/admin` 与 `/admin/*` 一律 404
- 后台会话 cookie：HttpOnly、SameSite=Strict、有效期 12 小时、HMAC 签名（复用 `auth.js` 的 `secretKey()`）；`TRUST_PROXY=1` 时加 Secure
- 登录防爆破：同一 IP 10 分钟内失败 5 次 → 锁定 10 分钟
- 判错标记每人每天上限 100 次（`FLAG_PER_IDENTITY_PER_DAY`），限流 usage 记录不带 `ref`
- 提示词版本 = `server/prompts/` 下每个文件 sha256 前 8 位，`{文件名: 哈希}`；后台"版本标签" = `${judgeModel}|jd-split@${h}|judge@${h}`
- 迁移必须在启动时 `db.prune()` 之前执行，且幂等
- 所有文案用中文；小程序新增文案见各任务

## Review Focus

1. **后台渲染用户留言 / 模型理由时被注入 HTML**（留言写 `<img onerror=...>`）→ 必须原样显示为文本。Task 6 加静态检查：`admin.html` 不出现 `innerHTML =`、`insertAdjacentHTML`、`document.write`。
2. **用户删除报告时改写建议还在后台生成** → 生成完成后的 `updateReport` 不能把 `rewrites` 写回已脱敏的报告。Task 2 加测试。
3. **对已过期 / 已被用户删除的报告调用判错接口** → 返回 `NOT_FOUND` / `EXPIRED`，不产生记录。Task 3 加测试。
4. **上线时 db.json 里的旧数据缺新字段**（反馈无 `wrongItems`/`updatedAt`、报告无 `meta`/`retained`、反馈对应的报告早已不存在）→ 迁移补齐，后台列表与详情不报错，显示"未记录"/"报告已不存在"。Task 2、Task 5 加测试。
5. **过期保留的报告仍被同一用户重复提交命中复用** → 断开关联后 `findReportByInput` 不能返回它，用户重新提交会生成新报告。Task 2 加测试。

---

## File Structure

| 文件 | 职责 |
|---|---|
| Create `server/versions.js` | 提示词版本哈希、版本标签（服务端与 eval 共用） |
| Create `server/retention.js` | 纯函数：迁移、清理（过期删除/断开关联）、用户删除（彻底删或脱敏留存） |
| Create `server/feedback.js` | 纯函数：整份反馈合并保存、逐条判错切换、读取某用户的判错条目 |
| Create `server/adminQuery.js` | 纯函数：后台汇总、列表（含筛选分页）、详情 |
| Create `server/admin.js` | 后台路由、登录与会话、防爆破 |
| Create `server/admin.html` | 后台页面 |
| Create `scripts/test-e2e.js` | 起真实服务做 HTTP 端到端 |
| Modify `server/db.js` | 接入上面的纯函数，新增 `migrate()`，`removeReport`/`prune`/反馈函数改为委托 |
| Modify `server/index.js` | 报告写入 `meta`、判错接口、反馈接口改造、`reportView` 带 `wrongItems`、挂载后台、启动先迁移 |
| Modify `server/limits.js`、`server/config.js` | 判错限流、新配置项 |
| Modify `scripts/eval.js` | 改用 `versions.promptVersions()` |
| Modify `miniprogram/pages/report/*`、`miniprogram/pages/legal/*` | 判错按钮、知情提示、隐私政策 |
| Modify `scripts/test-local.js`、`package.json`、`README.md`、`.env.example` | 测试与文档 |

---

### Task 1: 提示词版本 + 报告记录 meta

**Files:**
- Create: `server/versions.js`
- Modify: `server/index.js`（`runAnalyzeJob` 里组装 `doc` 处）、`scripts/eval.js`（删掉本地 `promptVersions`）
- Test: `scripts/test-local.js`

**Interfaces:**
- Produces:
  - `promptVersions(dir = server/prompts) -> { [fileName]: string /* sha256 前 8 位 */ }`，按文件名排序
  - `versionTag(meta) -> string`：`meta` 为空/无 prompts 时返回 `'未记录'`；否则 `${meta.judgeModel}|jd-split@${meta.prompts['jd-split.txt']}|judge@${meta.prompts['judge.txt']}`
  - 报告 doc 新字段 `meta: { model, judgeModel, prompts, mock }`、`retained: false`

- [ ] **Step 1: 写失败测试**（新段落 `== 单测：版本 ==`）

```js
const versions = require(S('versions'))
test('提示词版本：每个文件 8 位哈希，与文件内容一致', () => {
  const v = versions.promptVersions()
  assert.deepEqual(Object.keys(v), ['jd-split.txt', 'judge.txt', 'rewrite.txt'])
  const expect = require('crypto').createHash('sha256').update(fs.readFileSync(S('prompts/judge.txt'))).digest('hex').slice(0, 8)
  assert.equal(v['judge.txt'], expect)
})
test('版本标签', () => {
  assert.equal(versions.versionTag(null), '未记录')
  assert.equal(versions.versionTag({ judgeModel: 'qwen-plus', prompts: { 'jd-split.txt': 'aaaaaaaa', 'judge.txt': 'bbbbbbbb' } }), 'qwen-plus|jd-split@aaaaaaaa|judge@bbbbbbbb')
})
```

- [ ] **Step 2:** `npm test` → 预期 FAIL（`Cannot find module .../versions`）
- [ ] **Step 3:** 实现 `server/versions.js`；`index.js` 启动时算一次 `PROMPT_VERSIONS = promptVersions()`，`runAnalyzeJob` 的 `doc` 加 `meta: { model: config.LLM_MOCK ? 'mock' : config.LLM_MODEL, judgeModel: config.LLM_MOCK ? 'mock' : judgeModel(), prompts: PROMPT_VERSIONS, mock: config.LLM_MOCK }` 和 `retained: false`；`reportView` 不下发 `meta`、`retained`（加进解构排除列表）；`scripts/eval.js` 改为 `require('../server/versions').promptVersions()`
- [ ] **Step 4:** `npm test` → 全部通过；`npm run eval -- --help` 正常输出
- [ ] **Step 5:** Commit `报告记录模型与提示词版本（与评测共用版本哈希）`

---

### Task 2: 数据生命周期（迁移 / 清理 / 用户删除）

**Files:**
- Create: `server/retention.js`
- Modify: `server/db.js`（`removeReport`、`prune` 委托；新增 `migrate`）、`server/index.js`（启动顺序：`db.migrate()` → `db.prune()`）
- Test: `scripts/test-local.js`

**Interfaces:**
- Consumes: 报告字段 `retained`（Task 1）
- Produces（全部只改传入的 `data`，返回值供 db.js 决定是否 `save()`）：
  - `migrate(data) -> number`：变更条数。有反馈记录的报告补 `retained: true`；反馈补 `updatedAt = createdAt`、`wrongItems = []`；旧 `comment` 补跑 `redact()`。再跑一次返回 0
  - `prune(data, now, cfg) -> { removed: number, unlinked: number }`：
    - 报告"过期" = `createdAt <= now - REPORT_TTL_DAYS 天` 或 `expiresAt < now`
    - 过期且 `!retained` → 删除
    - 过期且 `retained` 且 `owner` 非空 → 断开关联：报告 `owner = ''`、`inputHash = ''`；该报告的反馈 `owner = ''`
    - `usage` 照旧按 `RECORD_TTL_DAYS` 清理；**反馈不再清理**；`jdCache` 照旧
  - `deleteReport(data, reportId, owner, now) -> boolean`：不是该 owner 的报告返回 false。
    - `!retained` → 从 `data.reports` 移除
    - `retained` → 脱敏留存：删 `spans`；`rewrites = []`、`rewritesStatus = 'none'`；每条判定 `quote = ''`、`quoteId = ''`；`owner = ''`、`inputHash = ''`；`deletedByUser = true`、`deletedAt = now`；该报告反馈 `owner = ''`；`usage` 中 `ref` 以 `${reportId}#` 开头的记录删掉 `ref` 字段
  - db.js：`db.migrate() -> number`（变更时 save）；`db.removeReport(reportId, owner)`、`db.prune(now)` 签名不变

- [ ] **Step 1: 写失败测试**（`== 单测：数据留存 ==`；用构造的 `data` 对象，不碰磁盘）

```js
const retention = require(S('retention'))
const DAY = 86400e3
const mkData = () => ({
  reports: [
    { reportId: 'rA', owner: 'u1', inputHash: 'h', createdAt: NOW - 40 * DAY, expiresAt: NOW - 10 * DAY, retained: false },
    { reportId: 'rB', owner: 'u1', inputHash: 'h2', createdAt: NOW - 40 * DAY, expiresAt: NOW - 10 * DAY, retained: true,
      spans: [{ id: 'S1', text: '简历行' }], judgments: [{ reqId: 'R1', verdict: 'hit', quote: '简历行', quoteId: 'S1', reason: '理由' }],
      rewrites: [{ original: '简历行' }], rewritesStatus: 'done', requirements: [{ id: 'R1', text: '要求' }] },
    { reportId: 'rC', owner: 'u1', inputHash: 'h3', createdAt: NOW - 1 * DAY, expiresAt: NOW + 29 * DAY, retained: true,
      spans: [{ id: 'S1', text: '简历行' }], judgments: [{ reqId: 'R1', verdict: 'hit', quote: '简历行', quoteId: 'S1', reason: '理由' }],
      rewrites: [{ original: '简历行' }], rewritesStatus: 'done', requirements: [{ id: 'R1', text: '要求' }] }
  ],
  feedback: [
    { owner: 'u1', reportId: 'rB', q1: 'accurate', createdAt: NOW - 30 * DAY },
    { owner: 'u1', reportId: 'rC', q1: 'inaccurate', comment: '我的手机 13812345678', createdAt: NOW - 200 * DAY },
    { owner: 'u9', reportId: 'rGone', q1: 'partial', createdAt: NOW - 100 * DAY }
  ],
  usage: [{ kind: 'copy', owner: 'u1', ref: 'rC#0', createdAt: NOW }],
  jdCache: []
})
const RCFG = { REPORT_TTL_DAYS: 30, RECORD_TTL_DAYS: 90, JD_CACHE_TTL_DAYS: 7 }

test('迁移：补 retained / wrongItems / updatedAt，留言补脱敏，幂等', () => {
  const d = mkData()
  d.reports[1].retained = undefined
  assert.ok(retention.migrate(d) > 0)
  assert.equal(d.reports[1].retained, true)
  assert.ok(d.feedback.every((f) => Array.isArray(f.wrongItems) && f.updatedAt))
  assert.ok(d.feedback[1].comment.includes('[PHONE]'))
  assert.equal(retention.migrate(d), 0)
})
test('清理：过期无反馈删除；过期有反馈保留并断开关联；反馈不清理', () => {
  const d = mkData()
  retention.prune(d, NOW, RCFG)
  assert.deepEqual(d.reports.map((r) => r.reportId), ['rB', 'rC'])
  const rB = d.reports[0]
  assert.equal(rB.owner, '')
  assert.equal(rB.inputHash, '')
  assert.ok(rB.spans.length === 1) // 过期保留不删简历行
  assert.equal(d.feedback.find((f) => f.reportId === 'rB').owner, '')
  assert.equal(d.feedback.length, 3) // 含孤儿反馈 rGone
})
test('用户删除：无反馈的报告彻底删除', () => {
  const d = mkData()
  d.reports[2].retained = false
  assert.ok(retention.deleteReport(d, 'rC', 'u1', NOW))
  assert.ok(!d.reports.some((r) => r.reportId === 'rC'))
})
test('用户删除：有反馈的报告脱敏留存（逐字段）', () => {
  const d = mkData()
  assert.ok(retention.deleteReport(d, 'rC', 'u1', NOW))
  const r = d.reports.find((x) => x.reportId === 'rC')
  assert.equal(r.spans, undefined)
  assert.deepEqual(r.rewrites, [])
  assert.equal(r.judgments[0].quote, '')
  assert.equal(r.judgments[0].quoteId, '')
  assert.equal(r.judgments[0].reason, '理由')
  assert.equal(r.requirements.length, 1)
  assert.equal(r.owner, '')
  assert.equal(r.deletedByUser, true)
  assert.equal(d.feedback.find((f) => f.reportId === 'rC').owner, '')
  assert.equal(d.usage[0].ref, undefined)
})
test('用户删除：不是自己的报告 → false，不改动', () => {
  const d = mkData()
  assert.equal(retention.deleteReport(d, 'rC', 'u2', NOW), false)
  assert.equal(d.reports[2].owner, 'u1')
})
```

Review Focus 2 的测试放在 `scripts/test-e2e.js`（Task 6，删除后改写生成不回写）；Review Focus 5 由上面"清理"测试里的 `owner === ''` 断言覆盖。

- [ ] **Step 2:** `npm test` → FAIL（缺模块）
- [ ] **Step 3:** 实现 `server/retention.js`；db.js 的 `removeReport` / `prune` 改为调用并在有变更时 `save()`；新增 `db.migrate()`；`index.js` 启动处在 `db.prune(Date.now())` 之前调用 `db.migrate()` 并打印 `启动迁移：补齐 N 条记录`（N>0 时）；每日定时器保持只调 `prune`
- [ ] **Step 4:** `npm test` → 全部通过
- [ ] **Step 5:** Commit `有反馈的报告长期保留：过期断开关联、用户删除时脱敏留存，启动先迁移`

---

### Task 3: 反馈合并保存 + 逐条判错接口

**Files:**
- Create: `server/feedback.js`
- Modify: `server/db.js`（`upsertFeedback` 删掉，改为委托下列函数 + save）、`server/limits.js`、`server/config.js`、`server/index.js`
- Test: `scripts/test-local.js`

**Interfaces:**
- Consumes: `retention` 的报告字段约定（Task 2）
- Produces:
  - `saveForm(data, owner, reportId, { q1, q2, comment }, now) -> feedbackDoc`：合并到 `(owner, reportId)` 那条记录（没有就新建 `{ owner, reportId, wrongItems: [], createdAt: now }`），更新 `q1/q2/comment/updatedAt`，**不动 `wrongItems`**；报告置 `retained = true`
  - `setWrong(data, owner, reportId, reqId, wrong, now) -> string[]`（当前 wrongItems 的 reqId 列表）：`wrong=true` 时若不存在则追加 `{ reqId, at: now }`；`false` 时移除；新建记录时 `q1/q2/comment` 为空串；报告置 `retained = true`（取消标记不回退）
  - `wrongIds(data, owner, reportId) -> string[]`
  - db.js 对应：`db.saveFeedbackForm(...)`、`db.setWrongItem(...)`、`db.wrongItemsOf(owner, reportId)`
  - `limits.checkFlag(db, owner, now, cfg) -> {ok} | {ok:false, code:'RATE_LIMITED', message:'操作太频繁，明天再来'}`，计数 `kind: 'flag'`
  - config：`FLAG_PER_IDENTITY_PER_DAY: intEnv('FLAG_PER_IDENTITY_PER_DAY', 100)`
  - 接口 `POST /api/report/:id/flag` body `{ reqId, wrong }` → `{ ok:true, wrongItems }`；错误：报告不存在或非本人 `NOT_FOUND`，过期 `EXPIRED`，reqId 不在 `report.requirements` 里 `BAD_REQ`（message `要求不存在`），`wrong` 非布尔 `INVALID_INPUT`
  - `reportView(doc, owner)` 增加 `wrongItems: db.wrongItemsOf(owner, doc.reportId)`（所有返回报告的地方传 owner）
  - `POST /api/feedback` 改用 `db.saveFeedbackForm`，comment 先 `redact()` 再存（内容安全检查保留原样）

- [ ] **Step 1: 写失败测试**（`== 单测：反馈与判错 ==`）

```js
const fb = require(S('feedback'))
const mkFb = () => ({ reports: [{ reportId: 'r1', owner: 'u1', retained: false, requirements: [{ id: 'R1' }, { id: 'R2' }] }], feedback: [], usage: [] })
test('判错：标记/取消/幂等，并置 retained', () => {
  const d = mkFb()
  assert.deepEqual(fb.setWrong(d, 'u1', 'r1', 'R1', true, NOW), ['R1'])
  assert.deepEqual(fb.setWrong(d, 'u1', 'r1', 'R1', true, NOW), ['R1'])
  assert.deepEqual(fb.setWrong(d, 'u1', 'r1', 'R2', true, NOW), ['R1', 'R2'])
  assert.deepEqual(fb.setWrong(d, 'u1', 'r1', 'R1', false, NOW), ['R2'])
  assert.equal(d.reports[0].retained, true)
  assert.equal(d.feedback.length, 1)
})
test('整份反馈合并保存：不覆盖已有判错', () => {
  const d = mkFb()
  fb.setWrong(d, 'u1', 'r1', 'R1', true, NOW)
  fb.saveForm(d, 'u1', 'r1', { q1: 'inaccurate', q2: 'none', comment: '不准' }, NOW + 1)
  assert.deepEqual(fb.wrongIds(d, 'u1', 'r1'), ['R1'])
  assert.equal(d.feedback[0].q1, 'inaccurate')
  assert.equal(d.feedback[0].updatedAt, NOW + 1)
})
test('判错限流：当日 100 次后拒绝', () => {
  const many = Array.from({ length: 100 }, () => u('flag', 'A', 'ip', NOW - 1000))
  assert.equal(limits.checkFlag(fakeDb(many), 'A', NOW, { FLAG_PER_IDENTITY_PER_DAY: 100 }).code, 'RATE_LIMITED')
  assert.ok(limits.checkFlag(fakeDb(many.slice(1)), 'A', NOW, { FLAG_PER_IDENTITY_PER_DAY: 100 }).ok)
})
```

接口层（NOT_FOUND / EXPIRED / BAD_REQ、`wrongItems` 随报告返回、限流记录无 `ref`）在 Task 6 的 e2e 里覆盖（Review Focus 3）。

- [ ] **Step 2:** `npm test` → FAIL
- [ ] **Step 3:** 实现 `server/feedback.js`、db 委托、`limits.checkFlag`、config、`index.js` 路由（加到 `DYNAMIC`：`[/^\/api\/report\/([\w-]+)\/flag$/, '/api/report/:id/flag']`）；判错成功后 `db.recordUsage('flag', owner, ipHash, now)`（不带 ref）
- [ ] **Step 4:** `npm test` → 全部通过
- [ ] **Step 5:** Commit `逐条判错接口；整份反馈改为合并保存，留言入库前脱敏`

---

### Task 4: 小程序报告页判错按钮 + 知情提示 + 隐私政策

**Files:**
- Modify: `miniprogram/pages/report/report.wxml`（逐条判定 `judge` 块末尾、反馈弹层提交按钮上方）、`report.js`、`report.wxss`、`miniprogram/pages/legal/legal.wxml`、`legal.js`

**Interfaces:**
- Consumes: `POST /api/report/:id/flag`、报告里的 `wrongItems`（Task 3）

**行为与文案（固定）：**
- 每条判定右下角按钮：未标记显示 `判错了？`，已标记显示 `✓ 已标记判错`；`render()` 里用 `report.wrongItems` 给每条加 `wrong: boolean`
- 点击 → 乐观更新按钮 → `api.call('/api/report/' + id + '/flag', { reqId, wrong })`（不显示 loading）→ 失败时恢复并 `wx.showToast({ title: api.friendlyError(e), icon: 'none' })`；成功后用返回的 `wrongItems` 重算
- 每台设备首次点击（本地存储键 `flag_consent` 不存在）先 `wx.showModal`：title `标记这条判错？`，content `标记后这份报告会被保留，用于改进分析质量；删除报告时会清除简历内容。`，confirmText `确定标记`；确认后 `wx.setStorageSync('flag_consent', '1')` 再提交；取消则不变
- 反馈弹层"提交反馈"按钮上方一行小字：`提交后这份报告将被保留，用于改进分析质量（删除时会清除简历内容）`
- 隐私政策 §4 在"报告保留 30 天后自动删除"后补：`你提交过反馈或标记过判错的报告不受 30 天限制，会被长期保留用于改进分析质量：保留期间不再与你的身份关联；你删除这类报告时，我们会清除其中的简历内容，仅保留分析结论、判定理由和你的反馈。`；§5 删除说明同步修改；`legal.js` 生效日期改 `2026-11-05`（若已是该日期则不变）

- [ ] **Step 1:** 实现以上改动（按钮样式：小号、次要色、右对齐，不抢判定内容的视觉焦点）
- [ ] **Step 2:** 验证：`node -e "require('./miniprogram/pages/report/report.js')"` 不适用（依赖小程序全局），改为在微信开发者工具编译无报错；若当前环境无法打开开发者工具，至少确认 wxml 标签闭合：`node -e` 用正则统计 `<view`/`</view>` 数量相等，并在最终报告里注明"小程序 UI 未在开发者工具中实测"
- [ ] **Step 3:** Commit `报告页逐条"判错了？"按钮与知情确认；隐私政策补充反馈报告的保留规则`

---

### Task 5: 后台查询（纯函数）

**Files:**
- Create: `server/adminQuery.js`
- Test: `scripts/test-local.js`

**Interfaces:**
- Consumes: `versions.versionTag`（Task 1）、反馈/报告字段（Task 2、3）
- Produces:
  - `reportStatus(report, now) -> 'ok' | 'expired' | 'deleted' | 'missing'`（`missing` = 报告不存在；`deleted` 优先于 `expired`）
  - `summary(data, now) -> { total, last7d, q1: { accurate, partial, inaccurate, none }, wrongItems }`（q1 按全部反馈统计，`none` = 未填；`wrongItems` = 所有反馈的判错条目总数）
  - `list(data, { q1, hasWrong, hasComment, version, page }, now) -> { rows, total, page, pageSize: 50, versions: string[] }`：一行一份反馈记录（= 一份报告），按 `updatedAt || createdAt` 倒序。`q1` 取值 `all|accurate|partial|inaccurate|none`。每行：`{ reportId, updatedAt, q1, q2, comment, wrongCount, score, conclusion, status, version }`（`score`/`conclusion` 报告不存在时为 null）。`versions` 为全部数据里出现过的版本标签去重排序
  - `detail(data, reportId, now) -> null | { status, report, feedback }`：`report` 为报告对象去掉 `owner`、`inputHash` 后的副本，附加 `versionTag`；`feedback` 为该报告的反馈记录去掉 `owner`（可能为 null）；报告不存在但有反馈时返回 `{ status: 'missing', report: null, feedback }`

- [ ] **Step 1: 写失败测试**（`== 单测：后台查询 ==`；复用 Task 2 的 `mkData()` 并在 `rC` 上加 `meta`）

```js
const aq = require(S('adminQuery'))
test('后台列表：一行一份报告、按更新时间倒序、状态与版本', () => {
  const d = mkData()
  retention.migrate(d)
  d.reports[2].meta = { judgeModel: 'qwen-plus', prompts: { 'jd-split.txt': 'aaaaaaaa', 'judge.txt': 'bbbbbbbb' } }
  const res = aq.list(d, { q1: 'all', page: 1 }, NOW)
  assert.equal(res.total, 3)
  const byId = Object.fromEntries(res.rows.map((r) => [r.reportId, r]))
  assert.equal(byId.rGone.status, 'missing')
  assert.equal(byId.rGone.score, null)
  assert.equal(byId.rB.status, 'expired')
  assert.equal(byId.rC.version, 'qwen-plus|jd-split@aaaaaaaa|judge@bbbbbbbb')
  assert.equal(byId.rB.version, '未记录')
})
test('后台列表筛选：q1 / 有判错 / 有留言 / 版本', () => {
  const d = mkData()
  retention.migrate(d)
  d.feedback[0].wrongItems = [{ reqId: 'R1', at: NOW }]
  assert.deepEqual(aq.list(d, { q1: 'inaccurate' }, NOW).rows.map((r) => r.reportId), ['rC'])
  assert.deepEqual(aq.list(d, { hasWrong: true }, NOW).rows.map((r) => r.reportId), ['rB'])
  assert.deepEqual(aq.list(d, { hasComment: true }, NOW).rows.map((r) => r.reportId), ['rC'])
  assert.equal(aq.list(d, { version: '未记录' }, NOW).total, 3)
})
test('后台详情：不含 owner / inputHash；已删除报告标 deleted；孤儿反馈 missing', () => {
  const d = mkData()
  retention.migrate(d)
  retention.deleteReport(d, 'rC', 'u1', NOW)
  const det = aq.detail(d, 'rC', NOW)
  assert.equal(det.status, 'deleted')
  assert.equal(det.report.owner, undefined)
  assert.equal(det.report.spans, undefined)
  assert.equal(aq.detail(d, 'rGone', NOW).status, 'missing')
  assert.equal(aq.detail(d, 'nope', NOW), null)
})
test('后台汇总', () => {
  const d = mkData()
  retention.migrate(d)
  const s = aq.summary(d, NOW)
  assert.equal(s.total, 3)
  assert.deepEqual(s.q1, { accurate: 1, partial: 1, inaccurate: 1, none: 0 })
})
```

- [ ] **Step 2:** `npm test` → FAIL
- [ ] **Step 3:** 实现 `server/adminQuery.js`
- [ ] **Step 4:** `npm test` → 全部通过
- [ ] **Step 5:** Commit `后台查询：反馈汇总、列表筛选分页、报告详情`

---

### Task 6: 后台路由 + 登录 + 页面 + 端到端测试

**Files:**
- Create: `server/admin.js`、`server/admin.html`、`scripts/test-e2e.js`
- Modify: `server/index.js`（路由分发：`url.pathname === '/admin' || url.pathname.startsWith('/admin/')` 时交给 `admin.handle`，放在小程序路由与登录校验之前）、`server/config.js`、`package.json`
- Test: `scripts/test-local.js`（静态检查）、`scripts/test-e2e.js`

**Interfaces:**
- Consumes: `adminQuery`（Task 5）、`auth.js` 的密钥（导出 `secretKey`）、`auth.clientIp`
- Produces:
  - `admin.handle(req, res, url) -> Promise<void>`
  - config：`ADMIN_PASSWORD: process.env.ADMIN_PASSWORD || ''`、`ADMIN_SESSION_HOURS: 12`
  - 路由（均 `Cache-Control: no-store`）：
    - `GET /admin` → `admin.html`
    - `POST /admin/api/login` `{ password }` → 成功 `{ok:true}` + `Set-Cookie: admin_session=<token>; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=43200`（`TRUST_PROXY` 时加 `; Secure`）；失败 `{ok:false, code:'BAD_PASSWORD', message:'密码错误'}`；锁定中 `{ok:false, code:'LOCKED', message:'尝试次数过多，请 10 分钟后再试'}`
    - `POST /admin/api/logout` → 清 cookie
    - `GET /admin/api/summary` → `{ok:true, ...summary}`
    - `GET /admin/api/feedback?q1=&hasWrong=1&hasComment=1&version=&page=` → `{ok:true, ...list}`
    - `GET /admin/api/report/:id` → `{ok:true, ...detail}` 或 `NOT_FOUND`
    - 未登录访问 `/admin/api/*`（login 除外）→ HTTP 401 `{ok:false, code:'UNAUTHORIZED', message:'请先登录'}`
  - 会话 token：`base64url(JSON{ kind:'admin', exp }) + '.' + HMAC`，与小程序 token 用不同前缀/kind，小程序 token 不能当后台 cookie 用，反之亦然
  - 防爆破：内存 Map `ipHash -> 失败时间戳[]`，10 分钟窗口 5 次即锁

**页面（`server/admin.html`）：**
- 未登录显示密码框；登录后显示汇总条 + 筛选栏 + 列表；点一行进入详情（同页切换，`location.hash = '#/report/<id>'`，支持浏览器后退）
- 详情布局按 spec §5.3：反馈区置顶 → 总分/结论/雷达数值表 → 逐条判定表（判错条目高亮）→ 诊断元数据 → 简历行（点击判定里的 quoteId 滚动定位）→ 改写建议；`deleted` 显示"用户已删除，简历内容已清除"，`missing` 显示"报告已不存在（仅剩反馈）"
- **所有数据用 `textContent` / `createElement` 渲染**，禁止 `innerHTML =`、`insertAdjacentHTML`、`document.write`

- [ ] **Step 1: 写失败测试**
  - `test-local.js`：

```js
test('后台页面不用 innerHTML 渲染（防留言注入）', () => {
  const html = fs.readFileSync(S('admin.html'), 'utf8')
  assert.ok(!/innerHTML\s*=|insertAdjacentHTML|document\.write/.test(html))
})
```

  - `scripts/test-e2e.js`：写一个 `startServer(env) -> { base, stop() }` 辅助函数，用 `child_process.spawn('node', ['server/index.js'])` 起服务，env：`PORT=<随机空闲端口>`、`DATA_DIR=<os.tmpdir 下新建临时目录>`、`LLM_MOCK=1`、清空 `WX_APPID`/`WX_APPSECRET`，再合并传入的 env；轮询 `/api/health` 至可用；`stop()` kill 进程并删临时目录。共起三个实例：A 不设 `ADMIN_PASSWORD`；B、C 设 `ADMIN_PASSWORD=test-admin`（C 专门测锁定，避免锁住 B）。断言（每条一个 `testAsync`，沿用 test-local 的输出格式与退出码）：
    1. 实例 A：`GET /admin` 与 `POST /admin/api/login` 都是 404
    2. 实例 B：`/admin/api/summary` 未登录 → 401
    3. 实例 C：错误密码 5 次后第 6 次（即使密码正确）→ `LOCKED`
    4. 实例 B：小程序 token 当 `admin_session` cookie → 401
    5. 实例 B：正确登录 → 拿到 cookie，`/admin/api/summary` 返回 `ok:true`
    6. 分析（`examples/resume.txt` + `examples/jd.txt`，轮询 `/api/job/:id` 至 done）→ `POST /api/report/:id/flag {reqId:'R1', wrong:true}` → 返回 `wrongItems:['R1']`；`GET /api/report/:id` 带 `wrongItems`
    7. flag 非法 reqId → `BAD_REQ`；别人的报告（另一个 deviceId 会话）→ `NOT_FOUND`
    8. 提交整份反馈（留言含 `13812345678` 和 `<img src=x onerror=alert(1)>`）→ 后台详情的留言里手机号已是 `[PHONE]`、`<img` 原样作为文本存在（接口层不转义，由页面 textContent 保证）；`wrongItems` 仍是 `['R1']`
    9. 后台列表含这份报告、状态 `ok`、版本为 `mock|jd-split@...|judge@...`
    10. 用户 `DELETE /api/report/:id` → 用户再 GET 得 `NOT_FOUND`；后台详情 `status:'deleted'`，无 `spans`，判定 `quote` 全空，`reason` 保留，反馈仍在
    11. （Review Focus 2）删除发生在改写建议生成前：分析完成后立即删除，等待 2 秒后后台详情 `rewrites` 仍为空数组
    12. （Review Focus 3）对已删除报告 flag → `NOT_FOUND`
  - Review Focus 5（过期保留后同输入重新提交不应命中复用）：e2e 里不好造时间，由 Task 2 的"过期保留后 `owner === ''`"断言覆盖；`findReportByInput` 按 owner 过滤的逻辑不得改动

- [ ] **Step 2:** `node scripts/test-e2e.js` → FAIL（`/admin` 404 等）
- [ ] **Step 3:** 实现 `server/admin.js`、`server/admin.html`、`index.js` 分发、config；`auth.js` 导出 `secretKey`；`package.json` 的 `test` 改为 `node scripts/test-local.js && node scripts/test-e2e.js`
- [ ] **Step 4:** `npm test` → 两个脚本全部通过
- [ ] **Step 5:** 手动冒烟：`ADMIN_PASSWORD=x LLM_MOCK=1 DATA_DIR=<临时目录> node server/index.js`，浏览器打开 `http://127.0.0.1:8787/admin` 登录、看列表、进详情、后退。能用浏览器工具时截图确认；不能时在最终报告里说明
- [ ] **Step 6:** Commit `网页后台：/admin 登录、反馈列表与报告诊断详情；HTTP 端到端测试`

---

### Task 7: 文档 + 收尾

**Files:**
- Modify: `README.md`、`.env.example`

- [ ] **Step 1:** README：新增「网页后台」小节（`ADMIN_PASSWORD` 开启方式、地址、能看什么、未设置即关闭、部署时务必走 HTTPS）、「数据留存」更新（有反馈的报告长期保留/断开关联/删除时脱敏留存，迁移在启动时自动执行）、接口表加 `POST /api/report/:id/flag`、测试数量与 `npm test` 现在包含 e2e、项目结构加新文件；`.env.example` 加注释掉的 `# ADMIN_PASSWORD=`
- [ ] **Step 2:** `npm test` 全部通过；`git status` 干净（除 eval/runs）
- [ ] **Step 3:** Commit `README：网页后台与数据留存说明`
