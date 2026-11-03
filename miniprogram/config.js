// 小程序端配置
module.exports = {
  // 本地分析服务地址。开发者工具需在「详情 → 本地设置」勾选
  // 「不校验合法域名、web-view（业务域名）、TLS 版本以及 HTTPS 证书」才能访问 localhost
  API_BASE: 'http://127.0.0.1:8787',

  // 是否启用 PDF 上传入口（依赖服务端 pdfjs-dist）
  PDF_UPLOAD_ENABLED: true,

  // 输入上限：首屏默认值；进入分析页后以服务端 /api/quota 下发的为准
  MAX_RESUME_CHARS: 4000,
  MAX_JD_CHARS: 2000
}
