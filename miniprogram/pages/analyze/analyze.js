const config = require('../../config')
const api = require('../../utils/api')
const { redact } = require('../../utils/redact')
const { validateResume, validateJD } = require('../../utils/validate')

// 进度步骤与服务端任务阶段（job.stage）的对应关系
const STEPS = [
  { key: 'split', title: '拆解 JD 的每一条要求' },
  { key: 'judge', title: '逐条核对简历里的证据' },
  { key: 'score', title: '计算匹配分与结论' }
]
const STAGE_INDEX = { queued: 0, split: 0, judge: 1, score: 2, done: 3 }

function stepsFor(stage) {
  const cur = STAGE_INDEX[stage] != null ? STAGE_INDEX[stage] : 0
  return STEPS.map((s, i) => ({ ...s, state: i < cur ? 'done' : i === cur ? 'active' : 'todo' }))
}

/** 把报告暂存给报告页，免得它再请求一次 */
function stashReport(report) {
  if (!report) return
  const g = getApp().globalData
  g.reportCache = g.reportCache || {}
  g.reportCache[report.reportId] = report
}

Page({
  data: {
    resume: '',
    jd: '',
    maxResume: config.MAX_RESUME_CHARS,
    maxJD: config.MAX_JD_CHARS,
    pdfEnabled: config.PDF_UPLOAD_ENABLED,
    pdfBusy: false,
    quotaLeft: null,
    quotaLimit: null,
    agreed: false,
    showAgree: false,
    analyzing: false,
    overlay: false, // 任一弹层显示中（原生 textarea 需要让位）
    steps: stepsFor('queued'),
    elapsed: 0
  },
  poller: null,
  elapsedTimer: null,

  onLoad() {
    const agreed = wx.getStorageSync('agreedLegal') === '1'
    this.setData({ agreed, showAgree: !agreed, overlay: !agreed })
  },
  onShow() {
    api
      .get('/api/quota', { loading: false })
      .then((r) => {
        const patch = { quotaLeft: r.analyze.remaining, quotaLimit: r.analyze.limit }
        // 输入上限以服务端为准（本地 config 只是首屏默认值）
        if (r.input) {
          patch.maxResume = r.input.maxResumeChars
          patch.maxJD = r.input.maxJDChars
        }
        this.setData(patch)
      })
      .catch(() => {})
  },
  onUnload() {
    // 离开页面只停止轮询；服务端任务继续跑，完成后出现在首页「我的报告」
    this.stopProgress()
  },

  onResumeInput(e) {
    this.setData({ resume: e.detail.value })
  },
  onJDInput(e) {
    this.setData({ jd: e.detail.value })
  },

  pasteFromClipboard(e) {
    const field = e.currentTarget.dataset.field
    const max = field === 'resume' ? this.data.maxResume : this.data.maxJD
    wx.getClipboardData({
      success: (r) => {
        const text = String(r.data || '').trim()
        if (!text) {
          wx.showToast({ title: '剪贴板是空的', icon: 'none' })
          return
        }
        this.setData({ [field]: text.slice(0, max) })
        // 微信读剪贴板会弹系统提示「xxx 读取了你的剪切板内容」（文案过长会折行溢出），
        // 立刻用自己的短提示覆盖它
        if (text.length > max) {
          wx.showToast({ title: `粘贴成功，已截取前 ${max} 字`, icon: 'none' })
        } else {
          wx.showToast({ title: '粘贴成功', icon: 'success' })
        }
      }
    })
  },
  clearField(e) {
    this.setData({ [e.currentTarget.dataset.field]: '' })
  },

  // ---- 隐私确认 ----
  checkAgree(e) {
    this.setData({ agreed: e.detail.value.length > 0 })
  },
  confirmAgree() {
    if (!this.data.agreed) {
      wx.showToast({ title: '请先勾选同意', icon: 'none' })
      return
    }
    wx.setStorageSync('agreedLegal', '1')
    this.setData({ showAgree: false, overlay: false })
  },
  goLegal() {
    wx.navigateTo({ url: '/pages/legal/legal' })
  },

  // ---- PDF 上传：读取为 base64 直传本地服务，解析结果必须回填确认 ----
  choosePdf() {
    if (this.data.pdfBusy) return
    wx.chooseMessageFile({
      count: 1,
      type: 'file',
      extension: ['pdf'],
      success: (res) => {
        const file = res.tempFiles[0]
        if (!file) return
        if (file.size > 5 * 1024 * 1024) {
          wx.showToast({ title: '文件超过 5MB，请压缩后重试', icon: 'none' })
          return
        }
        this.setData({ pdfBusy: true })
        wx.showLoading({ title: '解析 PDF 中…', mask: true })
        const done = () => {
          wx.hideLoading()
          this.setData({ pdfBusy: false })
        }
        wx.getFileSystemManager().readFile({
          filePath: file.path,
          encoding: 'base64',
          success: (r) => {
            api
              .call('/api/extract-pdf', { dataBase64: r.data, name: file.name || 'resume.pdf' }, { loading: false, timeout: 30000 })
              .then((resp) => {
                done()
                const result = resp.result || {}
                if (result.ok && result.text) {
                  const v = validateResume(result.text, this.data.maxResume)
                  this.setData({ resume: v.text || result.text.slice(0, this.data.maxResume) })
                  wx.showToast({ title: `已提取 ${result.text.length} 字，请核对后分析`, icon: 'none', duration: 2500 })
                } else {
                  // result.ok=false 的 message 自带降级引导（扫描件/加密损坏），只提示不报错
                  wx.showToast({ title: result.message || '解析失败，请直接粘贴文本', icon: 'none', duration: 2500 })
                }
              })
              .catch((e) => {
                done()
                wx.showToast({ title: api.friendlyError(e), icon: 'none' })
              })
          },
          fail: () => {
            done()
            wx.showToast({ title: '读取文件失败', icon: 'none' })
          }
        })
      }
    })
  },

  // ---- 提交分析：提交任务 → 轮询真实进度 → 跳报告页 ----
  startAnalyze() {
    if (this.data.analyzing) return
    if (this.data.quotaLeft === 0) {
      wx.showToast({ title: '今日免费次数已用完，明天再来', icon: 'none' })
      return
    }
    const rv = validateResume(this.data.resume, this.data.maxResume)
    if (!rv.ok) {
      wx.showToast({ title: rv.error, icon: 'none' })
      return
    }
    const jv = validateJD(this.data.jd, this.data.maxJD)
    if (!jv.ok) {
      wx.showToast({ title: jv.error, icon: 'none' })
      return
    }
    if (rv.truncated || jv.truncated) {
      wx.showToast({ title: '内容超长，已自动截断', icon: 'none' })
    }

    this.startProgress()
    api
      .call(
        '/api/analyze',
        { resumeText: redact(rv.text), jdText: jv.text }, // 离开手机前先脱敏
        { loading: false, timeout: 20000 }
      )
      .then((r) => {
        // 同一份简历 + JD 之前分析过：直接打开那份报告，不扣次数
        if (r.status === 'done') {
          if (r.cached) wx.showToast({ title: '相同内容已分析过，已为你打开', icon: 'none' })
          return { report: r.report, reportId: r.reportId }
        }
        this.setData({ steps: stepsFor(r.stage) })
        this.poller = api.pollJob(r.jobId, {
          onUpdate: (job) => this.setData({ steps: stepsFor(job.stage) })
        })
        return this.poller.promise
      })
      .then((job) => {
        this.stopProgress()
        stashReport(job.report)
        wx.redirectTo({ url: '/pages/report/report?id=' + job.reportId })
      })
      .catch((e) => {
        this.stopProgress()
        if (e && e.code === 'POLL_TIMEOUT') {
          wx.showModal({
            title: '还在分析中',
            content: api.friendlyError(e),
            showCancel: false,
            confirmText: '回首页',
            success: () => wx.reLaunch({ url: '/pages/index/index' })
          })
          return
        }
        wx.showModal({ title: '分析失败', content: api.friendlyError(e), showCancel: false })
      })
  },

  startProgress() {
    const startedAt = Date.now()
    this.setData({ analyzing: true, overlay: true, steps: stepsFor('queued'), elapsed: 0 })
    this.elapsedTimer = setInterval(() => {
      this.setData({ elapsed: Math.round((Date.now() - startedAt) / 1000) })
    }, 1000)
  },
  stopProgress() {
    if (this.elapsedTimer) {
      clearInterval(this.elapsedTimer)
      this.elapsedTimer = null
    }
    if (this.poller) {
      this.poller.cancel()
      this.poller = null
    }
    if (this.data.analyzing) this.setData({ analyzing: false, overlay: this.data.showAgree })
  }
})
