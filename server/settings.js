// 后台可在线调整的运行参数（纯函数，db/cfg 注入，可单测）。
//   - 存储：db.json 的 settings.<field>（与内测白名单同一套落盘机制）
//   - 运行时：写 config.<CONFIG_KEY>。limits.js 等每次调用都读 config，
//     改完立即生效，无需重启
//   - 语义：与白名单一致——env / 默认值只在首次初始化作种子；库里存了合法值之后
//     一律以库为准，改 env 不再生效。库里存的值非法（手改坏文件）则回退为种子并修复
// 加新参数：在 KEYS 里登记一项即可，后台「运行参数」卡片会自动出现。

const config = require('./config')

const KEYS = [
  {
    field: 'analyzePerIdentityPerDay', // settings 里的字段名（也是后台 API 用的 key）
    configKey: 'ANALYZE_PER_IDENTITY_PER_DAY', // 运行时生效的 config 键
    label: '每身份每日分析次数',
    min: 1,
    // 不超过每 IP 每日上限：IP 日限照样生效，超过它的身份日限没有意义，还会让客户端显示的剩余次数失真
    max: (cfg) => Math.min(100, cfg.ANALYZE_PER_IP_PER_DAY || 100),
    maxHint: (cfg) => (cfg.ANALYZE_PER_IP_PER_DAY < 100 ? '（不能超过每 IP 每日上限 ANALYZE_PER_IP_PER_DAY，需要更大请先调 env）' : '')
  }
]

function maxOf(k, cfg) {
  return typeof k.max === 'function' ? k.max(cfg) : k.max
}

function clamp(k, v, cfg) {
  const n = Number.isInteger(v) ? v : k.min
  return Math.min(maxOf(k, cfg), Math.max(k.min, n))
}

function keyBy(field) {
  return KEYS.find((k) => k.field === field) || null
}

function valid(k, v, cfg) {
  return Number.isInteger(v) && v >= k.min && v <= maxOf(k, cfg)
}

/**
 * 启动时调用：库里有合法值就以库为准覆盖 config；没有（首次升级）或值非法
 * 则把 config 当前值种入库。返回 { seeded, applied }（字段名数组）。
 */
function init(db, cfg = config) {
  const seeded = []
  const applied = []
  for (const k of KEYS) {
    const cur = db.data.settings ? db.data.settings[k.field] : undefined
    if (valid(k, cur, cfg)) {
      cfg[k.configKey] = cur
      applied.push(k.field)
    } else {
      // 种子（env/默认值）本身也可能越界：先夹到合法范围再入库，否则每次启动都会判非法重种
      const seed = cfg[k.configKey]
      if (!valid(k, seed, cfg)) {
        cfg[k.configKey] = clamp(k, seed, cfg)
        console.warn(`运行参数 ${k.configKey}=${JSON.stringify(seed)} 超出范围 ${k.min}~${maxOf(k, cfg)}，按 ${cfg[k.configKey]} 处理`)
      }
      if (cur !== undefined) console.warn(`运行参数 ${k.field} 的存量值非法（${JSON.stringify(cur)}），已重置为 ${cfg[k.configKey]}`)
      if (!db.data.settings) db.data.settings = {}
      db.data.settings[k.field] = cfg[k.configKey]
      seeded.push(k.field)
    }
  }
  if (seeded.length) db.save()
  return { seeded, applied }
}

/** 设置一个参数。返回 { ok, value } 或 { ok:false, code, message }。 */
function setValue(db, field, value, cfg = config) {
  const k = keyBy(field)
  if (!k) return { ok: false, code: 'BAD_FIELD', message: '未知参数' }
  const n = typeof value === 'number' ? value : parseInt(String(value).trim(), 10)
  if (!valid(k, n, cfg)) {
    const max = maxOf(k, cfg)
    const why = k.maxHint && Number.isInteger(n) && n > max ? k.maxHint(cfg) : ''
    return { ok: false, code: 'BAD_VALUE', message: `${k.label}需为 ${k.min}~${max} 的整数${why}` }
  }
  cfg[k.configKey] = n
  if (!db.data.settings) db.data.settings = {}
  db.data.settings[k.field] = n
  db.save()
  return { ok: true, value: n }
}

/** 后台列表用：当前值与取值范围。 */
function list(cfg = config) {
  return KEYS.map((k) => ({ field: k.field, label: k.label, value: cfg[k.configKey], min: k.min, max: maxOf(k, cfg) }))
}

module.exports = { init, setValue, list, KEYS }
