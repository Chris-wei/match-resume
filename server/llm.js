// OpenAI 兼容的 LLM 客户端（零依赖，Node 内置 https）。
// 一家模型 + 一个地域（设计文档 §0），支持任意 /chat/completions 协议厂商。
// 重试分两层、各管各的，不再相乘：
//   - 传输层（网络 / 超时 / 429 / 5xx）：chat() 内部按 LLM_RETRIES 重试；其余 4xx（key 错、参数错）不重试
//   - 内容层（JSON 抠不出来 / 结构不对）：调用方用 withShapeRetry() 重试；传输层错误直接上抛，不再叠加
// 所有调用都可带 deadline（绝对时间戳），超时即放弃，保证整次分析在客户端超时前结束。

const https = require('https')
const http = require('http')
const { URL } = require('url')
const config = require('./config')

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function transportError(message, retryable) {
  const e = new Error(message)
  e.transport = true
  e.retryable = retryable
  return e
}

function requestOnce(urlStr, apiKey, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlStr)
    const mod = url.protocol === 'http:' ? http : https
    const payload = JSON.stringify(body)
    const req = mod.request(
      {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'http:' ? 80 : 443),
        path: url.pathname + url.search,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Content-Length': Buffer.byteLength(payload)
        },
        timeout: timeoutMs
      },
      (res) => {
        let data = ''
        res.setEncoding('utf8')
        res.on('data', (d) => (data += d))
        res.on('end', () => {
          if (res.statusCode >= 500 || res.statusCode === 429) {
            reject(transportError(`LLM_HTTP_${res.statusCode}`, true))
            return
          }
          if (res.statusCode >= 400) {
            // 401/403/400 等：重试也不会好，直接失败
            reject(transportError(`LLM_HTTP_${res.statusCode}: ${data.slice(0, 300)}`, false))
            return
          }
          try {
            const json = JSON.parse(data)
            const content = json.choices && json.choices[0] && json.choices[0].message
              ? json.choices[0].message.content
              : ''
            if (!content) {
              reject(transportError('LLM_EMPTY_CONTENT', true))
              return
            }
            resolve(content)
          } catch (e) {
            reject(transportError('LLM_BAD_RESPONSE', true))
          }
        })
      }
    )
    req.on('timeout', () => {
      req.destroy(transportError('LLM_TIMEOUT', true))
    })
    req.on('error', (e) => {
      if (!e.transport) {
        e.transport = true
        e.retryable = true
      }
      reject(e)
    })
    req.write(payload)
    req.end()
  })
}

/** 从模型回复里抠出 JSON：容忍 ```json 围栏和前后废话。 */
function extractJSON(content) {
  let s = String(content).trim()
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '')
  const start = s.indexOf('{')
  const end = s.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) throw new Error('LLM_JSON_NOT_FOUND')
  return JSON.parse(s.slice(start, end + 1))
}

function remainingMs(deadline) {
  return deadline ? deadline - Date.now() : Infinity
}

function checkDeadline(deadline) {
  if (remainingMs(deadline) <= 0) throw transportError('LLM_DEADLINE', false)
}

async function chat({ system, user, maxTokens, deadline, model }) {
  if (!config.LLM_API_KEY) throw transportError('LLM_NOT_CONFIGURED', false)
  const body = {
    model: model || config.LLM_MODEL,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.1,
    max_tokens: maxTokens || 3000
  }
  const url = config.LLM_API_BASE.replace(/\/$/, '') + '/chat/completions'

  let lastErr
  for (let attempt = 0; attempt <= config.LLM_RETRIES; attempt++) {
    checkDeadline(deadline)
    const timeout = Math.min(config.LLM_TIMEOUT_MS, remainingMs(deadline))
    try {
      return await requestOnce(url, config.LLM_API_KEY, body, timeout)
    } catch (e) {
      lastErr = e
      if (e.retryable === false) throw e
      const backoff = 800 * (attempt + 1)
      if (attempt < config.LLM_RETRIES) {
        if (remainingMs(deadline) <= backoff) break
        await sleep(backoff)
      }
    }
  }
  throw lastErr
}

async function chatJSON(opts) {
  const content = await chat(opts)
  return extractJSON(content)
}

/**
 * 内容层重试：fn 抛出的传输层错误（已在 chat 内重试过）直接上抛，
 * 只有 JSON/结构错误才重来，最多 retries 次。
 */
async function withShapeRetry(fn, retries, fallbackMessage) {
  let lastErr
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await fn()
    } catch (e) {
      if (e && e.transport) throw e
      lastErr = e
    }
  }
  throw lastErr || new Error(fallbackMessage || 'LLM_SHAPE_FAILED')
}

module.exports = { chat, chatJSON, extractJSON, withShapeRetry, remainingMs }
