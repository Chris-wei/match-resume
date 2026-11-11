// 分享：目标是拉朋友来自己测，所以落地页一律是首页，不带任何报告内容
const HOME = '/pages/index/index'
const DEFAULT_TITLE = '你的简历和目标岗位匹配几分？30 秒看清差在哪'

/** 发给朋友；有分数时用"你猜你多少分"的钩子 */
function appMessage(score) {
  const hasScore = typeof score === 'number' && !Number.isNaN(score)
  return {
    title: hasScore ? `我的简历匹配 ${score} 分，你猜你的多少分？` : DEFAULT_TITLE,
    path: HOME
  }
}

module.exports = { appMessage, DEFAULT_TITLE }
