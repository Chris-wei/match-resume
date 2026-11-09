const api = require('../../utils/api')
const { formatDate, scoreLevel } = require('../../utils/format')

Page({
  data: {
    quotaLeft: null,
    quotaLimit: null,
    quotaUnlimited: false,
    reports: [],
    sampleRadar: [
      { label: '技能', value: 82, count: 5 },
      { label: '经验', value: 64, count: 3 },
      { label: '项目', value: 70, count: 4 },
      { label: '学历', value: 100, count: 1 },
      { label: '加分项', value: 45, count: 2 }
    ]
  },
  onShow() {
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
  goAnalyze() {
    wx.navigateTo({ url: '/pages/analyze/analyze' })
  },
  goReport(e) {
    wx.navigateTo({ url: '/pages/report/report?id=' + e.currentTarget.dataset.id })
  },
  goLegal() {
    wx.navigateTo({ url: '/pages/legal/legal' })
  }
})
