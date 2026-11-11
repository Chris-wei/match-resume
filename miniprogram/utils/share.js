// 分享：目标是拉朋友来自己测，所以落地页一律是首页，不带任何报告内容
const HOME = '/pages/index/index'
const DEFAULT_TITLE = '你的简历和目标岗位匹配几分？30 秒看清差在哪'

/**
 * 打开「发送给朋友」+「分享到朋友圈」两个菜单（页面还需实现 onShareTimeline）。
 * 只在首页用：朋友圈打开的是"当前页面"（无法指定 path），且是不能登录的单页模式，
 * 报告页、分析页从朋友圈进来都用不了，所以只让首页上朋友圈。
 */
function enableShareMenu() {
  wx.showShareMenu({ withShareTicket: false, menus: ['shareAppMessage', 'shareTimeline'] })
}

/** 发给朋友；有分数时用"你猜你多少分"的钩子 */
function appMessage(score) {
  const hasScore = typeof score === 'number' && !Number.isNaN(score)
  return {
    title: hasScore ? `我的简历匹配 ${score} 分，你猜你的多少分？` : DEFAULT_TITLE,
    path: HOME
  }
}

/** 朋友圈：只在首页启用，标题不带个人分数 */
function timeline() {
  return { title: DEFAULT_TITLE, query: '' }
}

module.exports = { enableShareMenu, appMessage, timeline, DEFAULT_TITLE }
