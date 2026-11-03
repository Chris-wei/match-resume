// 服务端配置：端口、风控、输入上限、LLM。环境变量可覆盖。

function intEnv(name, fallback) {
  const v = parseInt(process.env[name], 10)
  return Number.isFinite(v) ? v : fallback
}

module.exports = {
  PORT: intEnv('PORT', 8787),
  DATA_DIR: process.env.DATA_DIR || require('path').join(__dirname, '..', 'data'),

  // ---- 身份与会话 ----
  SESSION_TTL_DAYS: intEnv('SESSION_TTL_DAYS', 30),
  // 配置了 AppID/AppSecret 就用 openid 做身份（风控更强）；不配则退化为设备 ID
  WX_APPID: process.env.WX_APPID || '',
  WX_APPSECRET: process.env.WX_APPSECRET || '',
  // 只有部署在反向代理（nginx 等）后面时才信任 X-Real-IP / X-Forwarded-For，
  // 否则这两个头可被客户端随意伪造，IP 限制形同虚设
  TRUST_PROXY: process.env.TRUST_PROXY === '1',

  // ---- 风控（设计文档 §6：个人 MVP 够用即可）----
  // 每个身份（openid 或设备 ID）每天可分析次数
  ANALYZE_PER_IDENTITY_PER_DAY: intEnv('ANALYZE_PER_IDENTITY_PER_DAY', 3),
  // 每个身份 10 分钟内最多发起次数（防脚本连刷）
  ANALYZE_PER_IDENTITY_PER_10MIN: intEnv('ANALYZE_PER_IDENTITY_PER_10MIN', 3),
  // 每个 IP 的限制（设备 ID 可被随意换，IP 是第二道闸）
  ANALYZE_PER_IP_PER_DAY: intEnv('ANALYZE_PER_IP_PER_DAY', 10),
  ANALYZE_PER_IP_PER_10MIN: intEnv('ANALYZE_PER_IP_PER_10MIN', 5),
  // 全站每天总上限（防 API 费失控）
  GLOBAL_DAILY_CAP: intEnv('GLOBAL_DAILY_CAP', 200),
  // 改写句复制：每人每天 3 条（为后续分层留口子）
  COPY_PER_IDENTITY_PER_DAY: intEnv('COPY_PER_IDENTITY_PER_DAY', 3),
  // PDF 解析：CPU 密集，单独限次
  PDF_PER_IDENTITY_PER_10MIN: intEnv('PDF_PER_IDENTITY_PER_10MIN', 5),
  PDF_PER_IDENTITY_PER_DAY: intEnv('PDF_PER_IDENTITY_PER_DAY', 20),
  PDF_TIMEOUT_MS: 15000,

  // ---- 输入上限 ----
  MAX_RESUME_CHARS: intEnv('MAX_RESUME_CHARS', 4000),
  MIN_RESUME_CHARS: 50,
  MAX_JD_CHARS: intEnv('MAX_JD_CHARS', 2000),
  MIN_JD_CHARS: 20,
  MAX_PDF_BYTES: 5 * 1024 * 1024,

  // ---- 数据保留 ----
  REPORT_TTL_DAYS: intEnv('REPORT_TTL_DAYS', 30),
  RECORD_TTL_DAYS: 90,
  // JD 拆解缓存保留天数（同一份 JD 复用拆解结果）
  JD_CACHE_TTL_DAYS: intEnv('JD_CACHE_TTL_DAYS', 7),

  // ---- 检索与判定 ----
  TOP_K: 6,
  JUDGE_BATCH_SIZE: 8,
  MAX_REQUIREMENTS: 25,
  MAX_JUDGMENT_RETRY: 2,

  // ---- 打分参数（确定性）----
  STATUS_SCORE: { hit: 1, partial: 0.55, unclear: 0.15, miss: 0 },
  CATEGORY_FACTOR: {
    skills: 1,
    experience: 1,
    projects: 1,
    education: 0.9,
    keywords: 0.8
  },
  RADAR_CATEGORIES: ['skills', 'experience', 'projects', 'education', 'keywords'],
  HARD_GATE_CAP: 60,
  HARD_GATE_MIN_YEARS: 3,

  // ---- LLM（OpenAI 兼容协议；承诺不拿请求数据训练的厂商）----
  LLM_API_BASE: process.env.LLM_API_BASE || 'https://open.bigmodel.cn/api/paas/v4',
  LLM_API_KEY: process.env.LLM_API_KEY || '',
  // 默认智谱免费的 GLM-4.7-Flash（仅限 1 并发，适合联调）；上线建议千问 qwen-plus，见 README
  LLM_MODEL: process.env.LLM_MODEL || 'glm-4.7-flash',
  // 判定（逐条核对 + 逐字引用）单独用的模型：这一步最吃能力，小模型容易改写原句导致引用被拒、条目被灰掉。
  // 不设则沿用 LLM_MODEL。同一家厂商、同一个 key（设计文档 §0：一家模型 + 一个地域）
  LLM_JUDGE_MODEL: process.env.LLM_JUDGE_MODEL || '',
  LLM_TIMEOUT_MS: 45000,
  LLM_RETRIES: 2,
  // 主报告（拆解+判定+打分）的总时限：超时即失败并退还次数。
  // 小程序端轮询上限比它长，保证客户端一定能看到最终状态
  ANALYZE_DEADLINE_MS: intEnv('ANALYZE_DEADLINE_MS', 75000),
  // 改写建议在主报告返回后后台生成，单独的时限
  REWRITE_DEADLINE_MS: intEnv('REWRITE_DEADLINE_MS', 60000),
  // 判定批次失败比例超过它就整份失败（少量失败的条目标"待核对"，不让用户整份重来）
  JUDGE_MAX_FAILED_RATIO: 0.34,
  // 分析任务在内存中保留多久（供客户端轮询）
  JOB_TTL_MS: 10 * 60e3,
  // 未配 key 或 LLM_MOCK=1 时走启发式 mock（联调/测试不花钱）
  LLM_MOCK: process.env.LLM_MOCK === '1' || !process.env.LLM_API_KEY
}
