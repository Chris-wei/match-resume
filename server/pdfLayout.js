// 把 pdf.js 的文字块排成阅读顺序。
// 单栏、窄表、公司|日期、三栏：竖缝不够清楚时，保持按行从左到右拼接。
// 左右栏之间有一条够宽、且两侧都像正文栏的竖缝时，先读完左栏再读右栏。
// 横跨竖缝的通栏行（姓名、章节标题）留在原来的上下位置。

const MIN_GUTTER = 24 // 窄于这个的空隙当字距，不当栏间距
const MIN_COL = 140 // 窄于这个的一侧当日期/等级，不当正文栏
const MIN_SIDE = 3 // 每一侧至少这么多行，才认定是一栏
const BIN = 4
const MAX_SPAN = 2000 // 超过正常页宽就放弃分栏，避免按坐标跨度分配大数组
const MAX_BINS = Math.ceil(MAX_SPAN / BIN) + 2
const BANNER = 0.7 // 宽到接近整页的行是通栏，不参与找缝
const TOL = BIN

function estimateWidth(str, font) {
  let w = 0
  for (const ch of str) w += ch.charCodeAt(0) > 255 ? font : font * 0.5
  return w || font
}

function collectItems(textContent) {
  const items = []
  const list = (textContent && textContent.items) || []
  for (const item of list) {
    if (!item.str || !item.str.trim() || !item.transform) continue
    const t = item.transform
    const font = Math.hypot(t[0], t[1]) || Math.hypot(t[2], t[3]) || 10
    const given = Number(item.width)
    items.push({
      x: t[4],
      y: t[5],
      w: given > 0 ? given : estimateWidth(item.str, font),
      s: item.str,
      yKey: Math.round(t[5] / 3)
    })
  }
  return items
}

function bucketLines(items) {
  const buckets = new Map()
  for (const it of items) {
    if (!buckets.has(it.yKey)) buckets.set(it.yKey, [])
    buckets.get(it.yKey).push(it)
  }
  return [...buckets.keys()]
    .sort((a, b) => b - a)
    .map((yKey) => ({ yKey, parts: buckets.get(yKey).sort((a, b) => a.x - b.x) }))
}

function joinParts(parts) {
  return parts.map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim()
}

function boundsOf(parts) {
  let minX = Infinity
  let maxX = -Infinity
  for (const p of parts) {
    minX = Math.min(minX, p.x)
    maxX = Math.max(maxX, p.x + p.w)
  }
  return { minX, maxX, span: maxX - minX }
}

// 统计一条候选竖缝左右两侧的行数和实际文字宽度。
function columnStats(lines, x0, x1, span) {
  let leftMin = Infinity
  let leftMax = -Infinity
  let rightMin = Infinity
  let rightMax = -Infinity
  let leftLines = 0
  let rightLines = 0
  for (const line of lines) {
    let hasL = false
    let hasR = false
    for (const p of line.parts) {
      if (p.w >= span * BANNER) continue
      const rightEdge = p.x + p.w
      if (rightEdge <= x0 + TOL) {
        hasL = true
        leftMin = Math.min(leftMin, p.x)
        leftMax = Math.max(leftMax, rightEdge)
      } else if (p.x >= x1 - TOL) {
        hasR = true
        rightMin = Math.min(rightMin, p.x)
        rightMax = Math.max(rightMax, rightEdge)
      }
    }
    if (hasL) leftLines++
    if (hasR) rightLines++
  }
  if (leftMax < leftMin || rightMax < rightMin) return null
  return { leftLines, rightLines, leftWidth: leftMax - leftMin, rightWidth: rightMax - rightMin }
}

function detectGutter(lines) {
  const parts = lines.flatMap((l) => l.parts)
  if (parts.length < 6) return null
  const { minX, maxX, span } = boundsOf(parts)
  if (!Number.isFinite(span) || span > MAX_SPAN || span < MIN_COL * 2 + MIN_GUTTER) return null

  const bins = Math.ceil(span / BIN) + 2
  if (!Number.isFinite(bins) || bins > MAX_BINS) return null
  const occ = new Array(bins).fill(0)
  const usable = []
  for (const line of lines) {
    const seen = new Uint8Array(bins)
    let any = false
    for (const p of line.parts) {
      if (p.w >= span * BANNER) continue
      any = true
      let a = Math.floor((p.x - minX) / BIN)
      let b = Math.floor((p.x + p.w - minX) / BIN)
      if (a < 0) a = 0
      if (b >= bins) b = bins - 1
      for (let i = a; i <= b; i++) seen[i] = 1
    }
    if (!any) continue
    usable.push(line)
    for (let i = 0; i < bins; i++) occ[i] += seen[i]
  }

  const runs = []
  let i = 0
  while (i < bins) {
    if (occ[i] !== 0) {
      i++
      continue
    }
    const start = i
    while (i < bins && occ[i] === 0) i++
    const end = i
    // 贴着页面左缘或右缘的空白是页边，不是栏间距
    if (start === 0 || end >= bins) continue
    const x0 = minX + start * BIN
    const x1 = minX + end * BIN
    const width = x1 - x0
    if (width < MIN_GUTTER) continue
    const side = columnStats(usable, x0, x1, span)
    if (!side) continue
    if (side.leftLines < MIN_SIDE || side.rightLines < MIN_SIDE) continue
    if (side.leftWidth < MIN_COL || side.rightWidth < MIN_COL) continue
    // 缝比两侧文字都宽时，多半是「公司……日期」这种悬挂字段
    if (width > Math.min(side.leftWidth, side.rightWidth)) continue
    runs.push({ x0, x1 })
  }
  if (runs.length !== 1) return null
  return runs[0]
}

function classifyLine(line, gutter) {
  const left = []
  const right = []
  const cross = []
  for (const p of line.parts) {
    const rightEdge = p.x + p.w
    if (rightEdge <= gutter.x0 + TOL) left.push(p)
    else if (p.x >= gutter.x1 - TOL) right.push(p)
    else cross.push(p)
  }
  if (cross.length || (!left.length && !right.length)) {
    return [{ kind: 'span', yKey: line.yKey, parts: line.parts }]
  }
  if (left.length && right.length) {
    return [
      { kind: 'left', yKey: line.yKey, parts: left },
      { kind: 'right', yKey: line.yKey, parts: right }
    ]
  }
  if (left.length) return [{ kind: 'left', yKey: line.yKey, parts: left }]
  return [{ kind: 'right', yKey: line.yKey, parts: right }]
}

function widthOf(frags) {
  let minX = Infinity
  let maxX = -Infinity
  for (const f of frags) {
    for (const p of f.parts) {
      minX = Math.min(minX, p.x)
      maxX = Math.max(maxX, p.x + p.w)
    }
  }
  return maxX < minX ? 0 : maxX - minX
}

// 这一段不够成栏时，按原来的 y 顺序把同一行拼回去。
function rejoin(band) {
  const byY = new Map()
  const order = []
  for (const f of band) {
    if (!byY.has(f.yKey)) {
      byY.set(f.yKey, [])
      order.push(f.yKey)
    }
    byY.get(f.yKey).push(...f.parts)
  }
  return order.map((y) => joinParts(byY.get(y).sort((a, b) => a.x - b.x)))
}

function emitBand(band) {
  const left = band.filter((f) => f.kind === 'left')
  const right = band.filter((f) => f.kind === 'right')
  if (
    left.length >= MIN_SIDE &&
    right.length >= MIN_SIDE &&
    widthOf(left) >= MIN_COL &&
    widthOf(right) >= MIN_COL
  ) {
    return [...left, ...right].map((f) => joinParts(f.parts))
  }
  return rejoin(band)
}

function orderColumns(lines, gutter) {
  const out = []
  let band = []
  const flush = () => {
    if (!band.length) return
    out.push(...emitBand(band))
    band = []
  }
  for (const line of lines) {
    const frags = classifyLine(line, gutter)
    for (const f of frags) {
      if (f.kind === 'span') {
        flush()
        out.push(joinParts(f.parts))
      } else {
        band.push(f)
      }
    }
  }
  flush()
  return out
}

function pageToLines(textContent) {
  const items = collectItems(textContent)
  if (!items.length) return []
  const lines = bucketLines(items)
  const gutter = detectGutter(lines)
  if (!gutter) return lines.map((l) => joinParts(l.parts))
  return orderColumns(lines, gutter)
}

module.exports = { pageToLines }
