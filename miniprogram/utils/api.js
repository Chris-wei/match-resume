// 本地分析服务的 HTTP 封装：会话管理（token）、统一错误映射。
// 业务错误约定：HTTP 200 + {ok:false, code, message}

const config = require('../config')

const ERROR_TEXT = {
  QUOTA_EXCEEDED: '今日免费分析次数已用完，明天再来',
  RATE_LIMITED: '操作太频繁，请 10 分钟后再试',
  IP_LIMITED: '当前网络今日次数已用完，换个网络或明天再来',
  GLOBAL_LIMITED: '今日全站分析次数已达上限，明天再来',
  COPY_LIMIT: '今天的复制次数已用完，明天再来',
  PDF_LIMIT: '今天的 PDF 解析次数已用完。请把简历文字直接粘贴到输入框',
  BAD_IDENTITY: '无法建立会话，请重新进入小程序',
  ANALYZE_FAILED: '分析失败，本次不消耗免费次数，请重试',
  BUSY: '上一份报告还在分析中，请稍候再提交',
  JOB_NOT_FOUND: '分析任务已失效，请重新提交（未完成的任务不消耗次数）',
  POLL_TIMEOUT: '分析时间比预期长，稍后可在首页「我的报告」查看结果',
  EXPIRED: '报告已过期（保留 30 天）',
  NOT_FOUND: '报告不存在或已被删除',
  INVALID_INPUT: '输入内容不符合要求',
  TOO_LARGE: '文件超过 5MB，请压缩后再试，或把简历文字直接粘贴到输入框',
  CONTENT_BLOCKED: '提交内容包含违规信息，请修改后再试',
  MODERATION_UNAVAILABLE: '内容安全检查暂时不可用，请稍后再试（本次不消耗次数）',
  NETWORK: '连不上分析服务，请检查网络后稍后再试'
}

function friendlyError(e) {
  return (e && ERROR_TEXT[e.code]) || (e && e.message) || '出错了，请稍后再试'
}

function rawRequest(method, path, data, token, timeout) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: config.API_BASE + path,
      method,
      data,
      timeout: timeout || 60000,
      header: Object.assign(
        { 'content-type': 'application/json' },
        token ? { Authorization: 'Bearer ' + token } : {}
      ),
      success: (res) => {
        const r = res.data
        if (res.statusCode >= 200 && res.statusCode < 300 && r && r.ok === true) {
          resolve(r)
          return
        }
        const err = new Error((r && r.message) || `请求失败 (${res.statusCode})`)
        err.code = r && r.code
        err.statusCode = res.statusCode
        reject(err)
      },
      fail: () => reject(Object.assign(new Error(ERROR_TEXT.NETWORK), { code: 'NETWORK' }))
    })
  })
}

function loginCode() {
  return new Promise((resolve) => {
    wx.login({
      success: (r) => resolve(r.code || ''),
      fail: () => resolve('')
    })
  })
}

function createSession() {
  let deviceId = wx.getStorageSync('deviceId')
  if (!deviceId) {
    deviceId = 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12)
    wx.setStorageSync('deviceId', deviceId)
  }
  return loginCode().then((code) => rawRequest('POST', '/api/session', { deviceId, code }, null, 15000)).then((r) => {
    wx.setStorageSync('sessionToken', r.token)
    return r.token
  })
}

let sessionPromise = null

function ensureSession() {
  const token = wx.getStorageSync('sessionToken')
  if (token) return Promise.resolve(token)
  if (!sessionPromise) {
    sessionPromise = createSession().finally(() => {
      sessionPromise = null
    })
  }
  return sessionPromise
}

function callWithToken(method, path, data, { loading = true, timeout } = {}) {
  if (loading) wx.showLoading({ title: '处理中…', mask: true })
  const attempt = (token) =>
    rawRequest(method, path, data, token, timeout).catch((e) => {
      // token 失效（服务端换了签名密钥/数据被清/过期）→ 重建会话重试一次。
      // 只在存储里仍是这个失效 token 时才清：并发请求同时 401 时，
      // 先恢复的请求已经存好了新 token，后到的不能把它删掉
      if (e.statusCode === 401) {
        if (wx.getStorageSync('sessionToken') === token) wx.removeStorageSync('sessionToken')
        return ensureSession().then((t) => rawRequest(method, path, data, t, timeout))
      }
      throw e
    })
  return ensureSession()
    .then(attempt)
    .then(
      (r) => {
        if (loading) wx.hideLoading()
        return r
      },
      (e) => {
        if (loading) wx.hideLoading()
        throw e
      }
    )
}

const call = (path, data, opts) => callWithToken('POST', path, data, opts)
const get = (path, opts) => callWithToken('GET', path, undefined, opts)
const del = (path, opts) => callWithToken('DELETE', path, undefined, opts)

/**
 * 轮询分析任务直到结束。返回 { promise, cancel }。
 *   onUpdate(job)：每次拿到状态都回调（用于展示真实进度）
 *   网络抖动：连续失败 maxNetErrors 次才放弃；总时长超过 timeout 视为超时
 */
function pollJob(jobId, { onUpdate, interval = 1200, timeout = 150000, maxNetErrors = 5 } = {}) {
  let cancelled = false
  let timer = null
  const startedAt = Date.now()
  const promise = new Promise((resolve, reject) => {
    let netErrors = 0
    const tick = () => {
      if (cancelled) return
      get('/api/job/' + jobId, { loading: false, timeout: 15000 })
        .then((job) => {
          if (cancelled) return
          netErrors = 0
          if (onUpdate) onUpdate(job)
          if (job.status === 'done') return resolve(job)
          if (job.status === 'failed') {
            const err = new Error(job.message || ERROR_TEXT.ANALYZE_FAILED)
            err.code = job.code
            return reject(err)
          }
          schedule()
        })
        .catch((e) => {
          if (cancelled) return
          if (e.code === 'NETWORK' && ++netErrors < maxNetErrors) return schedule()
          reject(e)
        })
    }
    const schedule = () => {
      if (Date.now() - startedAt > timeout) {
        return reject(Object.assign(new Error(ERROR_TEXT.POLL_TIMEOUT), { code: 'POLL_TIMEOUT' }))
      }
      timer = setTimeout(tick, interval)
    }
    tick()
  })
  return {
    promise,
    cancel() {
      cancelled = true
      if (timer) clearTimeout(timer)
    }
  }
}

module.exports = { call, get, del, ensureSession, friendlyError, pollJob }
