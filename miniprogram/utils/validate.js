// 输入校验：空内容 / 太短 / 超长截断 / 乱码启发式。
const config = require('../config')

const MIN_RESUME = 50
const MIN_JD = 20

function validateText(text, { min, max, label }) {
  const t = String(text || '').trim()
  if (t.length < min) {
    return { ok: false, error: `${label}太短（至少 ${min} 字），请补全后再试` }
  }
  // 乱码启发式：可打印内容占比过低
  const printable = t.replace(/\s/g, '').length
  if (printable < min * 0.6) {
    return { ok: false, error: `${label}像是乱码或文件内容异常，请直接粘贴文本` }
  }
  if (t.length > max) {
    return { ok: true, text: t.slice(0, max), truncated: true, max }
  }
  return { ok: true, text: t, truncated: false, max }
}

// max 优先用服务端下发的上限（/api/quota 的 input），没有时退回本地默认
function validateResume(text, max) {
  return validateText(text, { min: MIN_RESUME, max: max || config.MAX_RESUME_CHARS, label: '简历内容' })
}

function validateJD(text, max) {
  return validateText(text, { min: MIN_JD, max: max || config.MAX_JD_CHARS, label: '职位描述' })
}

module.exports = { validateResume, validateJD, validateText }
