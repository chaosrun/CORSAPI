// 统一入口：兼容 Cloudflare Workers 和 Pages Functions
export default {
  async fetch(request, env, ctx) {
    // Pages Functions 中 KV 需要从 env 中获取
    if (env && env.KV && typeof globalThis.KV === 'undefined') {
      globalThis.KV = env.KV
    }

    const servicePath = normalizeServicePath(env && env.SERVICE_PATH)
    const cacheTtl = normalizeCacheTtl(env && env.CACHE_TTL_SECONDS)
    return handleRequest(request, { servicePath, cacheTtl })
  }
}

// 常量配置（避免重复创建）
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
}

const EXCLUDE_HEADERS = new Set([
  'content-encoding', 'content-length', 'transfer-encoding',
  'connection', 'keep-alive', 'set-cookie', 'set-cookie2'
])

const JSON_SOURCES = {
  'jin18': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jin18.json',
  'jingjian': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/jingjian.json',
  'full': 'https://raw.githubusercontent.com/hafrey1/LunaTV-config/refs/heads/main/LunaTV-config.json'
}

const FORMAT_CONFIG = {
  '0': { proxy: false, base58: false },
  'raw': { proxy: false, base58: false },
  '1': { proxy: true, base58: false },
  'proxy': { proxy: true, base58: false },
  '2': { proxy: false, base58: true },
  'base58': { proxy: false, base58: true },
  '3': { proxy: true, base58: true },
  'proxy-base58': { proxy: true, base58: true }
}

const DEFAULT_CACHE_TTL_SECONDS = 1800
const MIN_CACHE_TTL_SECONDS = 60

function normalizeServicePath(value) {
  if (!value) return ''
  return String(value).trim().replace(/^\/+|\/+$/g, '')
}

function normalizeCacheTtl(value) {
  const ttl = Number(value)
  return Number.isInteger(ttl) && ttl >= MIN_CACHE_TTL_SECONDS
    ? ttl
    : DEFAULT_CACHE_TTL_SECONDS
}

// Base58 编码函数
const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58Encode(obj) {
  const str = JSON.stringify(obj)
  const bytes = new TextEncoder().encode(str)

  let intVal = 0n
  for (let b of bytes) {
    intVal = (intVal << 8n) + BigInt(b)
  }

  let result = ''
  while (intVal > 0n) {
    const mod = intVal % 58n
    result = BASE58_ALPHABET[Number(mod)] + result
    intVal = intVal / 58n
  }

  for (let b of bytes) {
    if (b === 0) result = BASE58_ALPHABET[0] + result
    else break
  }

  return result
}

// 🔑 从 URL 中提取唯一标识符（用于生成唯一路径）
function extractSourceId(apiUrl) {
  try {
    const url = new URL(apiUrl)
    const hostname = url.hostname

    // 提取主域名作为标识符（去掉子域名和 TLD）
    // 例如：caiji.maotaizy.cc → maotai
    //       iqiyizyapi.com → iqiyi
    //       api.maoyanapi.top → maoyan
    const parts = hostname.split('.')

    // 如果是 caiji.xxx.com 或 api.xxx.com 格式，取倒数第二部分
    if (parts.length >= 3 && (parts[0] === 'caiji' || parts[0] === 'api' || parts[0] === 'cj' || parts[0] === 'www')) {
      return parts[parts.length - 2].toLowerCase().replace(/[^a-z0-9]/g, '')
    }

    // 否则取第一部分（去掉 zyapi/zy 等后缀）
    let name = parts[0].toLowerCase()
    name = name.replace(/zyapi$/, '').replace(/zy$/, '').replace(/api$/, '')
    return name.replace(/[^a-z0-9]/g, '') || 'source'
  } catch {
    // URL 解析失败，使用随机标识
    return 'source' + Math.random().toString(36).substr(2, 6)
  }
}

// JSON api 字段前缀替换（改进版：为每个源生成唯一路径）
function addOrReplacePrefix(obj, newPrefix) {
  if (typeof obj !== 'object' || obj === null) return obj
  if (Array.isArray(obj)) return obj.map(item => addOrReplacePrefix(item, newPrefix))
  const newObj = {}
  for (const key in obj) {
    if (key === 'api' && typeof obj[key] === 'string') {
      let apiUrl = obj[key]

      // 去掉旧的代理前缀（如果有）
      const urlIndex = apiUrl.indexOf('?url=')
      if (urlIndex !== -1) apiUrl = apiUrl.slice(urlIndex + 5)

      // 🔑 关键修改：为每个源生成唯一的路径
      if (!apiUrl.startsWith(newPrefix)) {
        const sourceId = extractSourceId(apiUrl)

        // 从 newPrefix 中提取 origin 和基础路径
        // 例如：https://xx.fn0.qzz.io/?url= → https://xx.fn0.qzz.io/p/iqiyi?url=
        const baseUrl = newPrefix.replace(/\/?\?url=$/, '') // 去掉结尾的 /?url= 或 ?url=
        apiUrl = `${baseUrl}/p/${sourceId}?url=${apiUrl}`
      }

      newObj[key] = apiUrl
    } else {
      newObj[key] = addOrReplacePrefix(obj[key], newPrefix)
    }
  }
  return newObj
}

// ---------- 安全版：KV 缓存 ----------
async function getCachedJSON(url, cacheTtl = DEFAULT_CACHE_TTL_SECONDS) {
  const kvAvailable = typeof KV !== 'undefined' && KV && typeof KV.get === 'function'

  if (kvAvailable) {
    const cacheKey = 'CACHE_' + url
    const cached = await KV.get(cacheKey)
    if (cached) {
      try {
        return JSON.parse(cached)
      } catch (e) {
        await KV.delete(cacheKey)
      }
    }
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    const data = await res.json()
    await KV.put(cacheKey, JSON.stringify(data), { expirationTtl: cacheTtl })
    return data
  } else {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Fetch failed: ${res.status}`)
    return await res.json()
  }
}

// ---------- 安全版：错误日志 ----------
async function logError(type, info) {
  // 保留错误输出，便于调试
  console.error('[ERROR]', type, info)

  // 禁止写入 KV
  return
}

// ---------- 主逻辑 ----------
async function handleRequest(request, options = {}) {
  const servicePath = options.servicePath || ''
  const cacheTtl = options.cacheTtl || DEFAULT_CACHE_TTL_SECONDS
  const basePath = servicePath ? `/${servicePath}` : ''

  let reqUrl = new URL(request.url)
  let pathname = reqUrl.pathname

  if (servicePath) {
    if (pathname !== basePath && !pathname.startsWith(basePath + '/')) {
      return new Response('Not Found', { status: 404, headers: CORS_HEADERS })
    }
    pathname = pathname.slice(basePath.length) || '/'
    reqUrl.pathname = pathname
    request = new Request(reqUrl.toString(), request)
    reqUrl = new URL(request.url)
  }

  // 快速处理 OPTIONS 请求
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  const targetUrlParam = reqUrl.searchParams.get('url')
  const formatParam = reqUrl.searchParams.get('format')
  const prefixParam = reqUrl.searchParams.get('prefix')
  const sourceParam = reqUrl.searchParams.get('source')

  const currentOrigin = reqUrl.origin
  const publicOrigin = currentOrigin + basePath
  const defaultPrefix = publicOrigin + '/?url='

  // 🩺 健康检查（最常见的性能检查，提前处理）
  if (pathname === '/health') {
    return new Response('OK', { status: 200, headers: CORS_HEADERS })
  }

  // 🔑 新增：处理源专属路径 /p/{sourceId}?url=...
  // 这样可以让 TVBox 认为每个源是不同的域名/路径
  if (pathname.startsWith('/p/') && targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // 通用代理请求处理（兼容旧的 /?url=... 格式）
  if (targetUrlParam) {
    return handleProxyRequest(request, targetUrlParam, currentOrigin)
  }

  // JSON 格式输出处理
  if (formatParam !== null) {
    return handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, cacheTtl)
  }

  // 返回首页文档
  return handleHomePage(publicOrigin, defaultPrefix)
}

// ---------- 代理请求处理子模块 ----------
async function handleProxyRequest(request, targetUrlParam, currentOrigin) {
  // 🚨 防止递归调用自身
  if (targetUrlParam.startsWith(currentOrigin)) {
    return errorResponse('Loop detected: self-fetch blocked', { url: targetUrlParam }, 400)
  }

  // 🚨 防止无效 URL
  if (!/^https?:\/\//i.test(targetUrlParam)) {
    return errorResponse('Invalid target URL', { url: targetUrlParam }, 400)
  }

  let fullTargetUrl = targetUrlParam
  // 🔑 修复：只提取 url= 参数的值，不要包含后续的 & 参数
  const urlMatch = request.url.match(/[?&]url=([^&]+)/)
  if (urlMatch) fullTargetUrl = decodeURIComponent(urlMatch[1])

  // 🔑 关键修复：提取并传递额外的 query 参数（如 ac=list, ac=detail 等）
  const reqUrl = new URL(request.url)
  const extraParams = new URLSearchParams()

  // 遍历所有 query 参数，把除了 url 之外的参数都加到目标 URL
  for (const [key, value] of reqUrl.searchParams) {
    if (key !== 'url') {
      extraParams.append(key, value)
    }
  }

  let targetURL
  try {
    targetURL = new URL(fullTargetUrl)

    // 🔑 将额外参数追加到目标 URL
    for (const [key, value] of extraParams) {
      targetURL.searchParams.append(key, value)
    }
  } catch {
    await logError('proxy', { message: 'Invalid URL', url: fullTargetUrl })
    return errorResponse('Invalid URL', { url: fullTargetUrl }, 400)
  }

  try {
    const proxyRequest = new Request(targetURL.toString(), {
      method: request.method,
      headers: request.headers,
      body: request.method !== 'GET' && request.method !== 'HEAD'
        ? await request.arrayBuffer()
        : undefined,
    })

    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 9000)
    const response = await fetch(proxyRequest, { signal: controller.signal })
    clearTimeout(timeoutId)

    const responseHeaders = new Headers(CORS_HEADERS)
    for (const [key, value] of response.headers) {
      if (!EXCLUDE_HEADERS.has(key.toLowerCase())) {
        responseHeaders.set(key, value)
      }
    }

    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: responseHeaders
    })
  } catch (err) {
    await logError('proxy', { message: err.message || '代理请求失败', url: fullTargetUrl })
    return errorResponse('Proxy Error', {
      message: err.message || '代理请求失败',
      target: fullTargetUrl,
      timestamp: new Date().toISOString()
    }, 502)
  }
}

// ---------- JSON 格式输出处理子模块 ----------
async function handleFormatRequest(formatParam, sourceParam, prefixParam, defaultPrefix, cacheTtl = DEFAULT_CACHE_TTL_SECONDS) {
  try {
    const config = FORMAT_CONFIG[formatParam]
    if (!config) {
      return errorResponse('Invalid format parameter', { format: formatParam }, 400)
    }

    const selectedSource = JSON_SOURCES[sourceParam] || JSON_SOURCES['full']
    const data = await getCachedJSON(selectedSource, cacheTtl)

    const newData = config.proxy
      ? addOrReplacePrefix(data, prefixParam || defaultPrefix)
      : data

    if (config.base58) {
      const encoded = base58Encode(newData)
      return new Response(encoded, {
        headers: { 'Content-Type': 'text/plain;charset=UTF-8', ...CORS_HEADERS },
      })
    } else {
      return new Response(JSON.stringify(newData), {
        headers: { 'Content-Type': 'application/json;charset=UTF-8', ...CORS_HEADERS },
      })
    }
  } catch (err) {
    await logError('json', { message: err.message })
    return errorResponse(err.message, {}, 500)
  }
}

// ---------- 首页文档处理 ----------
async function handleHomePage(publicOrigin, defaultPrefix) {
  const escapeHtml = value => String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

  const subscriptionSources = [
    { key: 'jin18', title: '精简版（jin18）' },
    { key: 'jingjian', title: '精简版+成人（jingjian）' },
    { key: 'full', title: '完整版（full，默认）' }
  ]
  const subscriptionFormats = [
    { value: '0', label: '原始 JSON' },
    { value: '1', label: '中转代理 JSON' },
    { value: '2', label: '原始 Base58' },
    { value: '3', label: '中转 Base58' }
  ]
  const subscriptionSections = subscriptionSources.map(source => `
    <div class="section">
      <h3>📦 ${source.title}</h3>
      ${subscriptionFormats.map(format => {
        const url = `${publicOrigin}?format=${format.value}&source=${source.key}`
        return `<div class="copy-row">
          <span>${format.label}</span>
          <code class="copyable">${escapeHtml(url)}</code>
          <button class="copy-btn" type="button">复制</button>
        </div>`
      }).join('')}
    </div>`).join('')
  const escapedPublicOrigin = escapeHtml(publicOrigin)
  const escapedDefaultPrefix = escapeHtml(defaultPrefix)

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>CORSAPI - API 中转代理服务</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Arial, sans-serif;
      max-width: 900px;
      margin: 0 auto;
      padding: 40px 20px;
      line-height: 1.8;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      min-height: 100vh;
    }
    .container {
      background: white;
      border-radius: 12px;
      padding: 40px;
      box-shadow: 0 20px 60px rgba(0,0,0,0.3);
    }
    h1 { color: #667eea; margin-bottom: 10px; font-size: 2.5em; }
    .subtitle { color: #666; margin-bottom: 30px; font-size: 1.1em; }
    h2 {
      color: #333;
      margin-top: 35px;
      margin-bottom: 15px;
      padding-bottom: 8px;
      border-bottom: 2px solid #667eea;
    }
    code {
      background: #f4f4f4;
      padding: 3px 8px;
      border-radius: 4px;
      font-size: 0.9em;
      color: #d63384;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    pre {
      background: #2d2d2d;
      color: #f8f8f2;
      padding: 20px;
      border-radius: 8px;
      overflow-x: auto;
      margin: 15px 0;
      font-family: 'Consolas', 'Monaco', monospace;
    }
    .example {
      background: #e8f5e9;
      padding: 20px;
      border-left: 4px solid #4caf50;
      margin: 20px 0;
      border-radius: 4px;
    }
    ul { margin: 15px 0; padding-left: 25px; }
    li { margin: 10px 0; }
    .badge {
      display: inline-block;
      padding: 4px 10px;
      background: #667eea;
      color: white;
      border-radius: 12px;
      font-size: 0.85em;
      margin-left: 8px;
    }
    .section {
      background: #f9fafb;
      border: 1px solid #e5e7eb;
      border-radius: 8px;
      padding: 20px;
      margin: 20px 0;
    }
    .section h3 {
      margin-bottom: 14px;
      color: #333;
      font-size: 1.1em;
    }
    table {
      width: 100%;
      border-collapse: collapse;
      margin: 15px 0;
      background: white;
    }
    td {
      padding: 12px;
      border: 1px solid #e5e7eb;
      vertical-align: top;
    }
    td:first-child {
      width: 22%;
      min-width: 110px;
      font-weight: 700;
      background: #f4f4f4;
      color: #333;
    }
    .copy-row {
      display: grid;
      grid-template-columns: 130px minmax(0, 1fr) auto;
      gap: 10px;
      align-items: center;
      margin: 10px 0;
    }
    .copy-row span {
      color: #333;
      font-weight: 600;
    }
    .copyable {
      overflow-wrap: anywhere;
      word-break: break-word;
    }
    .copy-btn {
      border: 0;
      border-radius: 6px;
      background: #667eea;
      color: white;
      cursor: pointer;
      font-size: 0.9em;
      line-height: 1;
      padding: 10px 14px;
      min-width: 74px;
    }
    .copy-btn:hover { background: #5568d3; }
    .footer {
      margin-top: 40px;
      padding-top: 20px;
      border-top: 1px solid #eee;
      color: #666;
      font-size: 0.9em;
      text-align: center;
    }
    .footer a { color: #667eea; text-decoration: none; }
    .footer a:hover { text-decoration: underline; }
    .status {
      display: inline-block;
      width: 8px;
      height: 8px;
      background: #4caf50;
      border-radius: 50%;
      margin-right: 6px;
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }
    @media (max-width: 640px) {
      body { padding: 20px 12px; }
      .container { padding: 24px; }
      h1 { font-size: 2em; }
      .copy-row { grid-template-columns: 1fr; }
      .copy-btn { width: 100%; }
    }
  </style>
</head>
<body>
  <div class="container">
    <h1>🔄 CORSAPI</h1>
    <p class="subtitle"><span class="status"></span>API 中转代理服务正在运行</p>

    <p>基于 Cloudflare Workers 的通用 API 中转代理服务，用于加速和转发 API 请求。</p>

    <h2>📖 基本用法</h2>
    <p>在 API 请求前添加代理地址和 <code>?url=</code> 参数：</p>
    <pre>${escapedDefaultPrefix}https://api.example.com/endpoint</pre>

    <div class="example">
      <strong>示例：代理一个 API 请求</strong><br><br>
      原始请求：<code>https://api.example.com/data?id=123</code><br>
      通过代理：<code>${escapedPublicOrigin}/?url=https://api.example.com/data&amp;id=123</code>
    </div>

    <h2>🚀 高级用法</h2>
    <p>使用专属路径避免缓存冲突（推荐）：</p>
    <pre>${escapedPublicOrigin}/p/source1?url=https://api1.example.com/endpoint</pre>
    <p>为不同 API 源使用不同路径标识符（如 <code>/p/source1</code>、<code>/p/source2</code>），可以：</p>
    <ul>
      <li>避免不同源之间的缓存冲突</li>
      <li>提高客户端兼容性</li>
      <li>更好的请求管理</li>
    </ul>

    <h2>🔧 参数转发</h2>
    <p>所有额外的 query 参数都会自动转发到目标 API：</p>
    <div class="example">
      <strong>参数自动转发示例</strong><br><br>
      请求：<code>${escapedPublicOrigin}/?url=https://api.example.com/list&amp;page=1&amp;limit=10</code><br>
      转发：<code>https://api.example.com/list?page=1&limit=10</code>
    </div>

    <h2>📺 配置订阅</h2>
    <p>支持直接输出 LunaTV/TVBox 可用配置，并可选择是否添加代理前缀或转换为 Base58。</p>
    <div class="section">
      <table>
        <tr>
          <td>format</td>
          <td>
            <code>0</code> 或 <code>raw</code> = 原始 JSON<br>
            <code>1</code> 或 <code>proxy</code> = 添加代理前缀<br>
            <code>2</code> 或 <code>base58</code> = 原始 Base58 编码<br>
            <code>3</code> 或 <code>proxy-base58</code> = 代理 Base58 编码
          </td>
        </tr>
        <tr>
          <td>source</td>
          <td>
            <code>jin18</code> = 精简版<br>
            <code>jingjian</code> = 精简版+成人<br>
            <code>full</code> = 完整版（默认）
          </td>
        </tr>
        <tr>
          <td>prefix</td>
          <td>自定义代理前缀，仅在 <code>format=1</code> 或 <code>format=3</code> 时生效。默认值：<code>${escapedDefaultPrefix}</code></td>
        </tr>
      </table>
    </div>
    ${subscriptionSections}

    <h2>✨ 功能特性</h2>
    <ul>
      <li>✅ 支持所有 HTTP 方法（GET、POST、PUT、DELETE 等）</li>
      <li>✅ 自动转发请求头和请求体</li>
      <li>✅ 完整的 CORS 支持</li>
      <li>✅ 超时保护<span class="badge">9秒</span></li>
      <li>✅ 自动参数转发</li>
      <li>✅ 防止递归调用</li>
      <li>✅ 可选的 KV 缓存支持</li>
    </ul>

    <h2>🏥 健康检查</h2>
    <p>访问 <code>/health</code> 端点检查服务状态：</p>
    <pre>${escapedPublicOrigin}/health</pre>

    <div class="footer">
      <p>
        项目地址：<a href="https://github.com/SzeMeng76/CORSAPI" target="_blank">SzeMeng76/CORSAPI</a><br>
        <small>基于 <a href="https://github.com/hafrey1/LunaTV-config" target="_blank">hafrey1/LunaTV-config</a> 二次开发</small>
      </p>
      <p>Powered by Cloudflare Workers</p>
    </div>
  </div>
  <script>
    document.querySelectorAll('.copy-btn').forEach(btn => {
      btn.addEventListener('click', async () => {
        const code = btn.parentElement.querySelector('.copyable');
        if (!code) return;
        const originalText = btn.innerText;
        try {
          await navigator.clipboard.writeText(code.innerText);
          btn.innerText = '已复制';
        } catch (err) {
          btn.innerText = '复制失败';
        }
        setTimeout(() => {
          btn.innerText = originalText;
        }, 1500);
      });
    });
  </script>
</body>
</html>`

  return new Response(html, {
    status: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8', ...CORS_HEADERS }
  })
}

// ---------- 统一错误响应处理 ----------
function errorResponse(error, data = {}, status = 400) {
  return new Response(JSON.stringify({ error, ...data }), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS_HEADERS }
  })
}
