// 提示词版本：server/prompts/ 下每个文件内容的 sha256 前 8 位。
// 报告（后台展示）与评测结果文件（scripts/eval.js）共用，两边的版本号能直接对上。

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const PROMPTS_DIR = path.join(__dirname, 'prompts')

/** { 文件名: 8 位哈希 }，按文件名排序 */
function promptVersions(dir = PROMPTS_DIR) {
  const out = {}
  for (const f of fs.readdirSync(dir).sort()) {
    out[f] = crypto.createHash('sha256').update(fs.readFileSync(path.join(dir, f))).digest('hex').slice(0, 8)
  }
  return out
}

/**
 * 后台的"版本"标签：判定模型 + 拆解/判定两个提示词（这两个决定诊断结果；改写提示词不参与）。
 * 存量报告没有 meta → '未记录'
 */
function versionTag(meta) {
  if (!meta || !meta.prompts) return '未记录'
  return `${meta.judgeModel}|jd-split@${meta.prompts['jd-split.txt']}|judge@${meta.prompts['judge.txt']}`
}

module.exports = { promptVersions, versionTag }
