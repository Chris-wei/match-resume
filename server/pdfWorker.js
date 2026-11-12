// PDF 解析 worker：在独立线程里跑 pdfjs，主线程不会被大文件/恶意文件卡死，
// 超时或爆内存时由主线程直接 terminate。
const { parentPort, workerData } = require('worker_threads')
const { pageToLines } = require('./pdfLayout')

const MIN_TEXT_LEN = 100 // 少于 100 字视为扫描件
const MAX_PAGES = 10

async function run(buf) {
  let pdfjsLib
  try {
    pdfjsLib = require('pdfjs-dist/legacy/build/pdf.js')
  } catch (e) {
    console.error('pdfjs load failed:', e && e.message)
    return {
      ok: false,
      reason: 'unavailable',
      message: 'PDF 解析暂时不可用，请把简历文字直接粘贴到输入框'
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
    return { ok: false, reason: 'invalid', message: '这个 PDF 打不开，可能已加密或损坏。请把简历文字直接粘贴到输入框' }
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
      return { ok: false, reason: 'scan', message: '这是扫描件，里面没有可选中的文字。请把简历文字直接粘贴到输入框' }
    }
    return { ok: true, text, pages: doc.numPages }
  } catch (e) {
    return { ok: false, reason: 'invalid', message: '这份 PDF 暂时读不出来。请把简历文字直接粘贴到输入框' }
  } finally {
    doc.destroy().catch(() => {})
  }
}

run(Buffer.from(workerData.buf))
  .then((r) => parentPort.postMessage(r))
  .catch(() => parentPort.postMessage({ ok: false, reason: 'invalid', message: '这份 PDF 暂时读不出来。请把简历文字直接粘贴到输入框' }))
