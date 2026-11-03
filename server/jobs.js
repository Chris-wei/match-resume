// 分析任务（内存态）：POST /api/analyze 立即返回 jobId，前端轮询 GET /api/job/:id 拿真实进度。
// 好处：不再依赖一个 60~90 秒的长连接（手机网络一抖就全白等），进度条也能显示真实阶段。
// 进程重启后任务丢失：客户端轮询拿到 NOT_FOUND 会提示重试；对应的预占额度在启动时退还（db.releasePendingUsage）。

const crypto = require('crypto')
const config = require('./config')

const jobs = new Map()

function create(owner, inputHash) {
  const id = 'j' + crypto.randomBytes(8).toString('hex')
  const now = Date.now()
  const job = { id, owner, inputHash, status: 'running', stage: 'queued', reportId: '', code: '', message: '', createdAt: now, updatedAt: now }
  jobs.set(id, job)
  return job
}

function update(job, patch) {
  Object.assign(job, patch, { updatedAt: Date.now() })
}

function get(id, owner) {
  const job = jobs.get(id)
  return job && job.owner === owner ? job : null
}

/** 该身份正在跑的任务（防止连点/重复提交并发跑多份）。 */
function runningFor(owner) {
  for (const job of jobs.values()) if (job.owner === owner && job.status === 'running') return job
  return null
}

function sweep(now = Date.now()) {
  for (const [id, job] of jobs) if (now - job.updatedAt > config.JOB_TTL_MS && job.status !== 'running') jobs.delete(id)
}

function view(job) {
  return { jobId: job.id, status: job.status, stage: job.stage, reportId: job.reportId, code: job.code, message: job.message }
}

module.exports = { create, update, get, runningFor, sweep, view, _jobs: jobs }
