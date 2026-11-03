// PDF 文本提取（上传优先、失败降级粘贴，设计文档附录 C.3）。
// 真正的解析在 pdfWorker.js 的独立线程里：带超时 + 内存上限，
// 恶意/超大 PDF 不会阻塞主线程上其他用户的请求。

const path = require('path')
const { Worker } = require('worker_threads')
const config = require('./config')

const WORKER_FILE = path.join(__dirname, 'pdfWorker.js')

function extractFromBuffer(buf, { timeoutMs = config.PDF_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let settled = false
    const done = (r) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      worker.terminate().catch(() => {})
      resolve(r)
    }
    const worker = new Worker(WORKER_FILE, {
      workerData: { buf },
      resourceLimits: { maxOldGenerationSizeMb: 256 }
    })
    const timer = setTimeout(
      () => done({ ok: false, reason: 'timeout', message: '文件解析超时（可能过于复杂），请直接粘贴简历文本' }),
      timeoutMs
    )
    worker.once('message', done)
    worker.once('error', (e) => {
      console.error('pdf worker error:', e && e.message)
      done({ ok: false, reason: 'invalid', message: '文件解析失败，请粘贴简历文本' })
    })
    worker.once('exit', () => done({ ok: false, reason: 'invalid', message: '文件解析失败，请粘贴简历文本' }))
  })
}

module.exports = { extractFromBuffer }
