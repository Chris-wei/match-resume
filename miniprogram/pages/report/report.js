const api = require('../../utils/api')
const { formatDate, scoreLevel, LEVEL_COLOR, VERDICT_TEXT, CATEGORY_TEXT } = require('../../utils/format')

// 列表默认按"最该处理的在前"排序：缺失 → 部分 → 待核对 → 满足
const VERDICT_ORDER = { miss: 0, partial: 1, unclear: 2, hit: 3 }
const STAT_DEFS = [
  { key: 'hit', label: '满足' },
  { key: 'partial', label: '部分' },
  { key: 'miss', label: '缺失' },
  { key: 'unclear', label: '待核对' }
]

/** 去掉空白和标点后比较：「有 A、B 经验；」与「有A、B经验」视为同一句 */
function sameText(a, b) {
  const strip = (x) => String(x || '').replace(/[\s，。；;,.、：:！!？?「」“”"'（）()【】]/g, '').toLowerCase()
  return strip(a) === strip(b)
}

const REWRITE_POLL_MS = 2000
const REWRITE_POLL_MAX = 40 // 约 80 秒，与服务端改写时限匹配

Page({
  data: {
    loading: true,
    errorText: '',
    reportId: '',
    report: null,
    level: 'mid',
    scoreColor: LEVEL_COLOR.mid,
    radarData: [],
    judgments: [],
    visibleJudgments: [],
    stats: [],
    tabs: [],
    filter: 'all',
    rewrites: [],
    rewritesStatus: 'none',
    copiesLeft: null,
    copyLimit: null,
    // 引用上下文弹层
    context: { visible: false, title: '', spanId: '', lines: [] },
    // 反馈弹层
    feedback: { visible: false, q1: '', q2: '', comment: '', submitted: false },
    fbQ1: [
      { value: 'accurate', label: '挺准的' },
      { value: 'partial', label: '部分准' },
      { value: 'inaccurate', label: '不准' }
    ],
    fbQ2: [
      { value: 'problems', label: '逐条判定' },
      { value: 'rewrites', label: '改写建议' },
      { value: 'none', label: '都一般' }
    ]
  },
  rewritePollTimer: null,
  rewritePolls: 0,

  onLoad(options) {
    const reportId = options.id || ''
    this.setData({ reportId })
    // 分析页刚拿到的报告直接用，省一次请求
    const cache = getApp().globalData.reportCache
    if (cache && cache[reportId]) {
      this.render(cache[reportId])
      delete cache[reportId]
    } else {
      this.load()
    }
    this.loadQuota()
  },

  onUnload() {
    this.stopRewritePoll()
  },

  noop() {},

  load() {
    this.setData({ loading: true, errorText: '' })
    api
      .get('/api/report/' + this.data.reportId, { loading: false })
      .then((r) => this.render(r.report))
      .catch((e) => this.setData({ loading: false, errorText: api.friendlyError(e) }))
  },

  loadQuota() {
    api
      .get('/api/quota', { loading: false })
      .then((r) => this.setData({ copiesLeft: r.copies.remaining, copyLimit: r.copies.limit }))
      .catch(() => {})
  },

  render(report) {
    const reqById = {}
    for (const r of report.requirements || []) {
      reqById[r.id] = {
        ...r,
        categoryText: CATEGORY_TEXT[r.category] || r.category,
        // JD 原文和要求标题实质相同（只差标点/空格）时不重复展示
        showJdQuote: !!r.jdQuote && !sameText(r.jdQuote, r.text)
      }
    }
    const radarData = ((report.score && report.score.radar) || []).map((x) => ({
      label: CATEGORY_TEXT[x.category] || x.category,
      value: x.value,
      count: x.count
    }))
    const judgments = (report.judgments || [])
      .map((j, i) => ({
        ...j,
        order: i,
        // 模型抄写有漂移、展示的是整行原文 → 提示用户这条是"近似引用"
        fuzzy: (j.flags || []).indexOf('fuzzy_quote') >= 0,
        verdictText: VERDICT_TEXT[j.verdict] || j.verdict,
        req: reqById[j.reqId] || { text: j.reqId, categoryText: '', weight: 1 }
      }))
      .sort((a, b) => (VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]) || a.order - b.order)

    const counts = { hit: 0, partial: 0, miss: 0, unclear: 0 }
    for (const j of judgments) if (counts[j.verdict] != null) counts[j.verdict]++
    const stats = STAT_DEFS.map((s) => ({ ...s, count: counts[s.key] }))
    const tabs = [{ key: 'all', label: '全部', count: null }].concat(
      [STAT_DEFS[2], STAT_DEFS[1], STAT_DEFS[3], STAT_DEFS[0]]
        .filter((s) => counts[s.key] > 0)
        .map((s) => ({ ...s, count: counts[s.key] }))
    )

    const overall = report.score ? report.score.overall : 0
    const level = scoreLevel(overall)
    this.setData({
      loading: false,
      report: {
        ...report,
        createdAtText: report.createdAt ? formatDate(report.createdAt) : ''
      },
      level,
      scoreColor: LEVEL_COLOR[level],
      radarData,
      judgments,
      stats,
      tabs,
      visibleJudgments: this.applyFilter(judgments, this.data.filter)
    })
    this.renderRewrites(report)
  },

  renderRewrites(report) {
    const reqText = {}
    for (const r of report.requirements || []) reqText[r.id] = r.text
    const status = report.rewritesStatus || 'done' // 老报告没有该字段：改写是同步生成的
    this.setData({
      rewritesStatus: status,
      rewrites: (report.rewrites || []).map((x) => ({ ...x, reqText: reqText[x.reqId] || '', copied: false }))
    })
    if (status === 'pending') this.startRewritePoll()
    else this.stopRewritePoll()
  },

  // ---- 改写建议后台生成：轮询直到出结果 ----
  startRewritePoll() {
    if (this.rewritePollTimer) return
    this.rewritePollTimer = setTimeout(() => {
      this.rewritePollTimer = null
      if (++this.rewritePolls > REWRITE_POLL_MAX) {
        this.setData({ rewritesStatus: 'failed' })
        return
      }
      api
        .get('/api/report/' + this.data.reportId, { loading: false })
        .then((r) => this.renderRewrites(r.report))
        .catch(() => this.startRewritePoll())
    }, REWRITE_POLL_MS)
  },
  stopRewritePoll() {
    if (this.rewritePollTimer) {
      clearTimeout(this.rewritePollTimer)
      this.rewritePollTimer = null
    }
  },

  // ---- 筛选 ----
  applyFilter(list, filter) {
    return filter === 'all' ? list : list.filter((j) => j.verdict === filter)
  },
  onFilter(e) {
    const key = e.currentTarget.dataset.key
    // 再点一次已选中的统计块 → 取消筛选
    const filter = key === this.data.filter && key !== 'all' ? 'all' : key
    this.setData({ filter, visibleJudgments: this.applyFilter(this.data.judgments, filter) })
  },

  // ---- 引用点击 → 弹出该片段在简历原文中的上下文（前后各 2 行）----
  onQuoteTap(e) {
    const spanId = e.currentTarget.dataset.id
    const spans = (this.data.report && this.data.report.spans) || []
    const i = spans.findIndex((s) => s.id === spanId)
    if (i < 0) return
    const lines = spans.slice(Math.max(0, i - 2), i + 3).map((s) => ({ id: s.id, text: s.text }))
    this.setData({ context: { visible: true, title: '简历原文上下文', spanId, lines } })
  },
  closeContext() {
    this.setData({ 'context.visible': false })
  },

  // ---- 改写句复制（服务端限每人每天 N 条，同一条重复复制不计）----
  copyRewrite(e) {
    const idx = e.currentTarget.dataset.index
    const item = this.data.rewrites[idx]
    if (!item) return
    if (this.data.copiesLeft === 0 && !item.copied) {
      wx.showToast({ title: `今天已复制 ${this.data.copyLimit} 条，明天再来`, icon: 'none' })
      return
    }
    api
      .call('/api/report/' + this.data.reportId + '/copy', { index: idx }, { loading: false })
      .then((r) => {
        this.setData({ copiesLeft: r.remaining, ['rewrites[' + idx + '].copied']: true })
        wx.setClipboardData({
          data: item.rewrite,
          success: () => wx.showToast({ title: '已复制', icon: 'success' })
        })
      })
      .catch((err) => wx.showToast({ title: api.friendlyError(err), icon: 'none' }))
  },

  // ---- 反馈 ----
  openFeedback() {
    this.setData({
      'feedback.visible': true,
      'feedback.submitted': wx.getStorageSync('fb_' + this.data.reportId) === '1'
    })
  },
  closeFeedback() {
    this.setData({ 'feedback.visible': false })
  },
  onFbPick(e) {
    const { q, value } = e.currentTarget.dataset
    this.setData({ ['feedback.' + q]: value })
  },
  onFbComment(e) {
    this.setData({ 'feedback.comment': e.detail.value })
  },
  submitFeedback() {
    const f = this.data.feedback
    if (!f.q1) {
      wx.showToast({ title: '请先选择报告准不准', icon: 'none' })
      return
    }
    api
      .call('/api/feedback', {
        reportId: this.data.reportId,
        q1: f.q1,
        q2: f.q2 || 'none',
        comment: f.comment || ''
      })
      .then(() => {
        wx.setStorageSync('fb_' + this.data.reportId, '1')
        this.setData({ 'feedback.visible': false, 'feedback.submitted': true })
        wx.showToast({ title: '感谢反馈！', icon: 'success' })
      })
      .catch((err) => wx.showToast({ title: api.friendlyError(err), icon: 'none' }))
  },

  // ---- 删除报告 ----
  deleteReport() {
    wx.showModal({
      title: '删除这份报告？',
      content: '删除后不可恢复（不会恢复今日分析次数）',
      confirmColor: '#e5484d',
      success: (res) => {
        if (!res.confirm) return
        this.stopRewritePoll()
        api
          .del('/api/report/' + this.data.reportId)
          .then(() => {
            wx.showToast({ title: '已删除', icon: 'success' })
            setTimeout(() => wx.navigateBack({ fail: () => wx.reLaunch({ url: '/pages/index/index' }) }), 600)
          })
          .catch((err) => wx.showToast({ title: api.friendlyError(err), icon: 'none' }))
      }
    })
  },

  goHome() {
    wx.reLaunch({ url: '/pages/index/index' })
  },
  goAnalyze() {
    wx.navigateTo({ url: '/pages/analyze/analyze', fail: () => wx.redirectTo({ url: '/pages/analyze/analyze' }) })
  },

  onShareAppMessage() {
    const score = this.data.report && this.data.report.score ? this.data.report.score.overall : '--'
    return { title: `我的简历匹配 ${score} 分，你猜你的多少分？`, path: '/pages/index/index' }
  }
})
