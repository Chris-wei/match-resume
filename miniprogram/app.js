const api = require('./utils/api')

App({
  onLaunch() {
    // 预热会话：拿 token（配了 AppSecret 时升级为 openid 身份，风控更准）
    api.ensureSession().catch(() => {})
  },
  globalData: {}
})
