// 内测白名单的存取与校验（纯函数，db/cfg 注入，可单测）。
//   - 存储：db.json 的 settings.limitWhitelist（随限流计数一起落盘）
//   - 运行时：写 config.LIMIT_WHITELIST（limits.isWhitelisted 每次调用都读它，改完立即生效）
//   - 语义：首次升级（库里没有该字段）用 env LIMIT_WHITELIST 作种子；之后一律以库为准，
//     再改 env 也不生效——避免"改了 env 怎么没效果"的困惑，后台页面是唯一日常入口。
//   - 只认 openid：设备 ID 由客户端自报、可随意伪造，不能作为豁免限次的凭据。
//     条目统一存成不带前缀的 openid 原串；输入时允许带 o: 前缀（自动去掉），d: 前缀直接拒绝。

const config = require('./config')

// openid 是 [\w-] 字符；允许带 o: 前缀（入库前去掉）
const ENTRY_RE = /^(?:o:)?[\w-]{8,64}$/
const MAX_ENTRIES = 50

/**
 * 把用户输入拆成合法条目。分隔符：中英文逗号、空白。
 * 返回 { entries, invalid }：合法去重后的条目（已去掉 o: 前缀）+ 非法原文（让调用方整批拒绝并提示）。
 */
function normalizeEntries(input) {
  const raw = String(input || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean)
  const entries = []
  const invalid = []
  for (const e of raw) {
    if (!ENTRY_RE.test(e)) {
      if (!invalid.includes(e)) invalid.push(e)
      continue
    }
    const id = e.replace(/^o:/, '')
    if (!entries.includes(id)) entries.push(id)
  }
  return { entries, invalid }
}

function apply(db, entries, cfg = config) {
  cfg.LIMIT_WHITELIST = entries
  db.data.settings.limitWhitelist = entries
  db.save()
}

/** 合并后的列表（去重），不落盘：调用方据此先判上限再提交。 */
function mergedWith(entries, cfg = config) {
  const merged = cfg.LIMIT_WHITELIST.slice()
  for (const e of entries) if (!merged.includes(e)) merged.push(e)
  return merged
}

/** 添加（去重）。返回合并后的完整列表。 */
function addEntries(db, entries, cfg = config) {
  const merged = mergedWith(entries, cfg)
  apply(db, merged, cfg)
  return merged
}

/** 删除：目标去掉 o: 前缀后精确匹配（条目入库时已统一去前缀）。返回删除后的完整列表。 */
function removeEntries(db, targets, cfg = config) {
  const t = [].concat(targets).map((s) => String(s).trim().replace(/^o:/, '')).filter(Boolean)
  const merged = cfg.LIMIT_WHITELIST.filter((e) => !t.includes(e))
  apply(db, merged, cfg)
  return merged
}

/**
 * 启动时调用：库里有 settings.limitWhitelist 就以库为准覆盖 config；
 * 没有该字段（老库首次升级）用 env 解析出的列表作种子并入库。
 * 两种来源都会规范化：去 o: 前缀、丢弃 d: 条目与非法条目（旧版本允许存 deviceId）。
 * 返回 { entries, seeded }。
 */
function init(db, cfg = config) {
  if (!db.data.settings) db.data.settings = {}
  const stored = db.data.settings.limitWhitelist
  const seeded = !Array.isArray(stored)
  const source = (seeded ? cfg.LIMIT_WHITELIST || [] : stored).map(String)
  const { entries, invalid } = normalizeEntries(source.join(','))
  if (invalid.length) {
    console.warn(`${seeded ? 'LIMIT_WHITELIST' : '库里的内测白名单'}有不合法或非 openid 的条目，已忽略：${invalid.join('、')}`)
  }
  const changed = seeded || entries.length !== stored.length || entries.some((e, i) => e !== stored[i])
  if (changed) apply(db, entries, cfg)
  else cfg.LIMIT_WHITELIST = entries
  return { entries, seeded }
}

module.exports = { normalizeEntries, mergedWith, addEntries, removeEntries, init, ENTRY_RE, MAX_ENTRIES }
