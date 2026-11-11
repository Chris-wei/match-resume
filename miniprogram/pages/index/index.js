const api = require('../../utils/api')
const { formatDate, scoreLevel } = require('../../utils/format')
const share = require('../../utils/share')

Page({
  data: {
    quotaLeft: null,
    quotaLimit: null,
    quotaUnlimited: false,
    reports: [],
    singlePage: false,
    sampleRadar: [
      { label: '技能', value: 82, count: 5 },
      { label: '经验', value: 64, count: 3 },
      { label: '项目', value: 70, count: 4 },
      { label: '学历', value: 100, count: 1 },
      { label: '加分项', value: 45, count: 2 }
    ]
  },
  onLoad() {
    share.enableShareMenu()
    if (share.isSinglePage()) this.setData({ singlePage: true })
  },
  onShow() {
    if (this.data.singlePage) return // 朋友圈单页模式：无登录态，不请求接口
    this.loadQuota()
    this.loadReports()
  },
  loadQuota() {
    api
      .get('/api/quota', { loading: false })
      .then((r) => this.setData({ quotaLeft: r.analyze.remaining, quotaLimit: r.analyze.limit, quotaUnlimited: r.unlimited === true }))
      .catch(() => {})
  },
  loadReports() {
    api
      .get('/api/reports', { loading: false })
      .then((r) =>
        this.setData({
          reports: (r.reports || []).map((x) => ({
            ...x,
            createdAtText: formatDate(x.createdAt),
            level: scoreLevel(x.overall)
          }))
        })
      )
      .catch(() => {})
  },
  /** 单页模式不能跳转页面，提示用户进入完整小程序 */
  blockedInSinglePage() {
    if (!this.data.singlePage) return false
    wx.showToast({ title: '点击屏幕底部「前往小程序」开始使用', icon: 'none', duration: 2500 })
    return true
  },
  goAnalyze() {
    if (this.blockedInSinglePage()) return
    wx.navigateTo({ url: '/pages/analyze/analyze' })
  },
  goReport(e) {
    wx.navigateTo({ url: '/pages/report/report?id=' + e.currentTarget.dataset.id })
  },
  goLegal() {
    if (this.blockedInSinglePage()) return
    wx.navigateTo({ url: '/pages/legal/legal' })
  },
  onShareAppMessage() {
    return share.appMessage()
  },
  onShareTimeline() {
    return share.timeline()
  }
})
