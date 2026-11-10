// 小程序端配置。开发者工具走本机服务；真机预览、体验版、正式版走线上。
function apiBase() {
  try {
    const info = typeof wx.getDeviceInfo === 'function' ? wx.getDeviceInfo() : wx.getSystemInfoSync()
    if (info && info.platform === 'devtools') return 'http://127.0.0.1:8787'
  } catch (e) {}
  return 'https://api.apeanut.cn'
}

module.exports = {
  API_BASE: apiBase(),

  // 是否启用 PDF 上传入口（依赖服务端 pdfjs-dist）
  PDF_UPLOAD_ENABLED: true,

  // 输入上限：首屏默认值；进入分析页后以服务端 /api/quota 下发的为准
  MAX_RESUME_CHARS: 4000,
  MAX_JD_CHARS: 2000
}
