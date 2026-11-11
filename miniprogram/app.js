const api = require('./utils/api')
const { isSinglePage } = require('./utils/share')

App({
  onLaunch() {
    // 预热会话：拿 token（配了 AppSecret 时升级为 openid 身份，风控更准）
    // 朋友圈单页模式下不能登录，跳过
    if (!isSinglePage()) api.ensureSession().catch(() => {})
  },
  globalData: {}
})
