// PDF 解析 worker：在独立线程里跑 pdfjs，主线程不会被大文件/恶意文件卡死，
// 超时或爆内存时由主线程直接 terminate。
const { parentPort, workerData } = require('worker_threads')

const MIN_TEXT_LEN = 100 // 少于 100 字视为扫描件
const MAX_PAGES = 10

/** 按 y 坐标把页面 text items 聚成行、按 x 排序，避免双栏/分段把行拆碎。 */
function pageToLines(textContent) {
  const buckets = new Map()
  for (const item of textContent.items) {
    if (!item.str || !item.str.trim()) continue
    const t = item.transform
    const key = String(Math.round(t[5] / 3)) // y 轴 3pt 容差聚行
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key).push({ x: t[4], s: item.str })
  }
  const keys = [...buckets.keys()].sort((a, b) => Number(b) - Number(a))
  return keys.map((k) => {
    const parts = buckets.get(k).sort((a, b) => a.x - b.x)
    return parts.map((p) => p.s).join(' ').replace(/\s+/g, ' ').trim()
  })
}

async function run(buf) {
  let pdfjsLib
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js')
  } catch (e) {
    const notInstalled = e && e.code === 'MODULE_NOT_FOUND' && /pdfjs-dist/.test(e.message)
    console.error('pdfjs load failed:', e && e.message)
    return {
      ok: false,
      reason: 'unavailable',
      message: notInstalled
        ? '服务端未安装 pdfjs-dist（在 server/ 下执行 npm install），请直接粘贴文本'
        : 'PDF 解析组件加载失败（需 Node 18+），请直接粘贴文本'
    }
  }
  let doc
  try {
    doc = await pdfjsLib.getDocument({
      data: new Uint8Array(buf),
      // 安全加固：禁止 pdfjs 用 eval/new Function 编译字体（CVE-2024-4367 的利用路径），
      // 只提取文本也用不到字体渲染
      isEvalSupported: false,
      disableFontFace: true,
      useSystemFonts: false
    }).promise
  } catch {
    return { ok: false, reason: 'invalid', message: '文件无法解析（可能已加密或损坏），请粘贴简历文本' }
  }
  try {
    const lines = []
    const pages = Math.min(doc.numPages, MAX_PAGES)
    for (let i = 1; i <= pages; i++) {
      const page = await doc.getPage(i)
      const content = await page.getTextContent()
      lines.push(...pageToLines(content))
      page.cleanup()
    }
    const text = lines.filter(Boolean).join('\n').replace(/[ \t]+/g, ' ').trim()
    if (text.length < MIN_TEXT_LEN) {
      return { ok: false, reason: 'scan', message: '检测到扫描件（无文字层），请直接粘贴简历文本' }
    }
    return { ok: true, text, pages: doc.numPages }
  } catch (e) {
    return { ok: false, reason: 'invalid', message: '文件解析失败，请粘贴简历文本' }
  } finally {
    doc.destroy().catch(() => {})
  }
}

run(Buffer.from(workerData.buf))
  .then((r) => parentPort.postMessage(r))
  .catch(() => parentPort.postMessage({ ok: false, reason: 'invalid', message: '文件解析失败，请粘贴简历文本' }))
