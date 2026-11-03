// 文本归一化与逐字引用匹配（移植自 resume-matcher src/text.ts）。
// 所有「引用是否真的在原文里」的判断都走这里，规则唯一。

/** 归一化：全角半角、大小写、花引号、空白。 */
function normalize(s) {
  return String(s || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
}

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u

/**
 * 分词：拉丁文按单词；CJK 连续串按字符二元组（"负责后端" → 负责/责后/后端）。
 */
function tokenize(s) {
  const words = normalize(s).match(/[\p{L}\p{N}+#.]+/gu) || []
  const out = []
  for (const w of words) {
    const word = w.replace(/\.+$/, '')
    if (!word) continue
    if (!CJK.test(word)) {
      out.push(word)
      continue
    }
    const pieces =
      word.match(
        /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[^\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu
      ) || []
    for (const piece of pieces) {
      if (!CJK.test(piece) || piece.length === 1) {
        out.push(piece)
        continue
      }
      for (let i = 0; i < piece.length - 1; i++) out.push(piece.slice(i, i + 2))
    }
  }
  return out
}

/**
 * quote 是否逐字出现在 source 中（归一化后），
 * 或 ≥minRatio 的 token 命中——容忍模型抄写时的小标点/大小写漂移，但绝不接受改写。
 */
function quoteMatches(quote, source, minRatio) {
  const ratio = minRatio == null ? 0.9 : minRatio
  const q = normalize(quote)
  if (!q) return false
  if (normalize(source).includes(q)) return true
  const qTokens = tokenize(quote)
  if (qTokens.length < 3) return false
  const sTokens = new Set(tokenize(source))
  const hits = qTokens.filter((t) => sTokens.has(t)).length
  return hits / qTokens.length >= ratio
}

/** 单字符归一化，规则与 normalize 一致（不含空白折叠，由调用方处理）。 */
function normalizeChar(ch) {
  return ch
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‛]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[‐-―]/g, '-')
}

/** 归一化并记录"归一化串第 k 个字符 ← 原串下标"的映射，用于把命中位置还原回原文。 */
function normalizeWithMap(s) {
  const src = String(s || '')
  let out = ''
  const map = []
  let pendingSpace = -1
  for (let i = 0; i < src.length; ) {
    const cp = src.codePointAt(i)
    const ch = String.fromCodePoint(cp)
    const piece = normalizeChar(ch)
    if (/^\s+$/.test(piece) || piece === '') {
      if (/^\s+$/.test(piece) && out && pendingSpace < 0) pendingSpace = i
    } else {
      if (pendingSpace >= 0) {
        out += ' '
        map.push(pendingSpace)
        pendingSpace = -1
      }
      for (const c of piece) {
        out += c
        map.push(i)
      }
    }
    i += ch.length
  }
  return { out, map }
}

/** 把 source 按行/句切成片段（用于模糊命中时找"最像的那一句"）。 */
function fragmentsOf(source) {
  return String(source || '')
    .split(/[\n。；;！!？?]/)
    .map((x) => x.trim())
    .filter(Boolean)
}

/**
 * 定位引用在原文中的真实文本：
 *   - 归一化后逐字命中 → { text: 原文中对应的那段（原样切出）, exact: true }
 *   - 只是 token 比例命中 → { text: 原文中最相似的整句, exact: false }
 *   - 都不满足 → null
 * 报告里展示的永远是从原文切出来的文字，而不是模型抄写的版本。
 */
function locateQuote(quote, source, minRatio) {
  if (!quoteMatches(quote, source, minRatio)) return null
  const q = normalizeWithMap(quote).out.trim()
  const { out, map } = normalizeWithMap(source)
  const idx = q ? out.indexOf(q) : -1
  if (idx >= 0) {
    const src = String(source)
    const start = map[idx]
    const lastStart = map[idx + q.length - 1]
    const lastCp = src.codePointAt(lastStart)
    const end = lastStart + String.fromCodePoint(lastCp).length
    return { text: src.slice(start, end), exact: true }
  }
  const qTokens = tokenize(quote)
  let best = null
  let bestHits = -1
  for (const frag of fragmentsOf(source)) {
    const fTokens = new Set(tokenize(frag))
    const hits = qTokens.filter((t) => fTokens.has(t)).length
    if (hits > bestHits) {
      best = frag
      bestHits = hits
    }
  }
  return { text: best || String(source).trim(), exact: false }
}

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** 整词匹配，兼容 "c++"、"c#"、"node.js"；"java" 不会匹配 "javascript"。 */
function containsTerm(text, term) {
  const re = new RegExp(
    `(?<![\\p{Script=Latin}\\p{N}])${escapeRegex(normalize(term))}(?![\\p{Script=Latin}\\p{N}+#])`,
    'u'
  )
  return re.test(normalize(text))
}

module.exports = { normalize, tokenize, quoteMatches, locateQuote, containsTerm, escapeRegex }
