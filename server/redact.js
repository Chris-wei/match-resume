// 服务端兜底脱敏（小程序端也会先脱一次，这里是双保险）。
// 联系方式与证件号对匹配毫无用处，绝不能发给模型厂商（PIPL 最小化原则）。
// 注意：不用 lookbehind，保证同一份代码在小程序端也能跑。

const PATTERNS = [
  // 邮箱
  [/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[EMAIL]'],
  // 大陆身份证：17 位数字 + 数字/X（用捕获组代替 lookbehind）
  [/(\D|^)(\d{17}[\dXx])(?!\d)/g, '$1[ID]'],
  // 大陆手机号，可带 +86 与分隔符
  [/(\D|^)((?:\+?86[\s-]?)?1[3-9]\d[\s-]?\d{4}[\s-]?\d{4})(?!\d)/g, '$1[PHONE]'],
  // 国际号码：+ 开头 8-15 位数字带分隔符
  [/(\+[\d\s().-]{8,17}\d)/g, '[PHONE]']
]

function redact(text) {
  let t = String(text || '')
  for (const [re, label] of PATTERNS) t = t.replace(re, label)
  return t
}

// 姓名：对匹配毫无用处，却是最直接的身份标识。只处理两种高置信形态，宁漏勿误伤：
//   1. 「姓名：张三」/「Name: John Smith」字段
//   2. 简历开头 header 区第一行整行就是一个名字（2-4 个汉字，或 2-3 个首字母大写的英文词）
const NAME_FIELD = /^((?:姓\s*名|name)\s*[:：]\s*)([^\s|｜,，/]{1,30}(?: [A-Za-z][\w'-]*){0,2})/i
const CJK_NAME_LINE = /^[\u4e00-\u9fa5]{1,2}[\u4e00-\u9fa5·]{1,4}$/
const LATIN_NAME_LINE = /^[A-Z][a-z'-]+(?: [A-Z][a-z'-]+){1,2}$/

function redactName(text, isFirstHeader) {
  if (NAME_FIELD.test(text)) return text.replace(NAME_FIELD, '$1[NAME]')
  if (isFirstHeader && (CJK_NAME_LINE.test(text) || LATIN_NAME_LINE.test(text)) && text.length <= 40) return '[NAME]'
  return text
}

function redactSpans(spans) {
  let firstHeaderSeen = false
  return spans.map((s) => {
    const isFirstHeader = s.section === 'header' && !firstHeaderSeen
    if (s.section === 'header') firstHeaderSeen = true
    return { ...s, text: redactName(redact(s.text), isFirstHeader) }
  })
}

module.exports = { redact, redactSpans, redactName }
