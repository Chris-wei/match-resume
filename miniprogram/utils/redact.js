// 步骤①：客户端脱敏——邮箱/手机/身份证在离开手机之前就被替换，
// 模型永远看不到真实值（服务端还有一道同样的兜底）。
// 不用 lookbehind，兼容低版本基础库。

const PATTERNS = [
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]'],
  [/(\D|^)(\d{17}[\dXx])(?!\d)/g, '$1[ID]'],
  [/(\D|^)((?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4})(?!\d)/g, '$1[PHONE]'],
  [/(\+[\d\s().-]{8,17}\d)/g, '[PHONE]']
]

function redact(text) {
  let t = String(text || '')
  for (const item of PATTERNS) t = t.replace(item[0], item[1])
  return t
}

module.exports = { redact }
