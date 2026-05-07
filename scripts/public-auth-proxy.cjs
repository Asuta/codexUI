const http = require('node:http')
const crypto = require('node:crypto')

const listenPort = Number.parseInt(process.env.CODEXUI_PUBLIC_PROXY_PORT || '5189', 10)
const targetPort = Number.parseInt(process.env.CODEXUI_TARGET_PORT || '5188', 10)
const password = process.env.CODEXUI_PUBLIC_PASSWORD || ''
const sessionSecret = process.env.CODEXUI_PUBLIC_SESSION_SECRET || crypto.randomBytes(32).toString('hex')
const cookieName = 'codexui_public_session'
const sessionTtlMs = 30 * 24 * 60 * 60 * 1000
const benignSocketErrorCodes = new Set(['ECONNRESET', 'EPIPE', 'ECONNABORTED', 'ERR_STREAM_PREMATURE_CLOSE'])

function isBenignSocketError(error) {
  return error && benignSocketErrorCodes.has(error.code)
}

function logProxyError(context, error) {
  if (isBenignSocketError(error)) {
    console.warn(`${context}: ${error.code}`)
    return
  }
  console.error(`${context}: ${error && error.stack ? error.stack : error}`)
}

function destroyQuietly(stream) {
  if (!stream || stream.destroyed) return
  try {
    stream.destroy()
  } catch {
    // Ignore cleanup errors while handling a broken client/upstream socket.
  }
}

function safeWriteHead(res, statusCode, headers) {
  if (res.headersSent || res.destroyed) return false
  try {
    res.writeHead(statusCode, headers)
    return true
  } catch (error) {
    logProxyError('response writeHead failed', error)
    destroyQuietly(res)
    return false
  }
}

function safeEnd(res, body = '') {
  if (res.destroyed || res.writableEnded) return
  try {
    res.end(body)
  } catch (error) {
    logProxyError('response end failed', error)
    destroyQuietly(res)
  }
}

function safeSocketWrite(socket, chunk) {
  if (!socket || socket.destroyed || !socket.writable) return false
  try {
    socket.write(chunk)
    return true
  } catch (error) {
    logProxyError('socket write failed', error)
    destroyQuietly(socket)
    return false
  }
}

function sendPlainText(res, statusCode, body) {
  if (safeWriteHead(res, statusCode, { 'Content-Type': 'text/plain; charset=utf-8' })) {
    safeEnd(res, body)
  }
}

function parseCookies(header) {
  const cookies = {}
  if (!header) return cookies
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

function sign(value) {
  return crypto.createHmac('sha256', sessionSecret).update(value).digest('hex')
}

function createSessionCookie() {
  const expiresAt = Date.now() + sessionTtlMs
  const nonce = crypto.randomBytes(16).toString('hex')
  const value = `${expiresAt}.${nonce}`
  return `${value}.${sign(value)}`
}

function isValidSession(cookieValue) {
  if (!cookieValue) return false
  const parts = cookieValue.split('.')
  if (parts.length !== 3) return false
  const value = `${parts[0]}.${parts[1]}`
  const expected = sign(value)
  const actual = parts[2]
  if (expected.length !== actual.length) return false
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(actual))) return false
  const expiresAt = Number.parseInt(parts[0], 10)
  return Number.isFinite(expiresAt) && expiresAt > Date.now()
}

function timingSafePasswordEquals(provided) {
  const left = Buffer.from(provided || '')
  const right = Buffer.from(password)
  return left.length === right.length && crypto.timingSafeEqual(left, right)
}

function sendLoginPage(res, failed = false) {
  if (!safeWriteHead(res, 200, { 'Content-Type': 'text/html; charset=utf-8' })) return
  safeEnd(res, `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>CodexUI Login</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;background:#0b0b0f;color:#f4f4f5;display:grid;place-items:center;min-height:100vh;margin:0}
form{width:min(360px,calc(100vw - 32px));background:#18181b;border:1px solid #27272a;border-radius:12px;padding:24px}
h1{font-size:20px;margin:0 0 18px;text-align:center}
label{display:block;color:#a1a1aa;font-size:14px;margin-bottom:8px}
input{width:100%;box-sizing:border-box;background:#09090b;border:1px solid #3f3f46;border-radius:8px;color:white;font-size:16px;padding:10px 12px}
button{width:100%;margin-top:16px;border:0;border-radius:8px;padding:10px 12px;background:#2563eb;color:white;font-weight:600;cursor:pointer}
p{display:${failed ? 'block' : 'none'};color:#f87171;text-align:center;font-size:13px;margin:12px 0 0}
</style>
</head>
<body>
<form method="post" action="/__codexui_public_login">
<h1>CodexUI</h1>
<label for="password">Password</label>
<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
<button type="submit">Sign in</button>
<p>Incorrect password</p>
</form>
</body>
</html>`)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk) => {
      body += chunk
      if (body.length > 8192) {
        reject(new Error('Request body too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function proxyHttp(req, res) {
  const headers = { ...req.headers, host: `localhost:${targetPort}` }
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    method: req.method,
    path: req.url,
    headers,
  }, (upstreamRes) => {
    upstreamRes.on('error', (error) => {
      logProxyError('upstream response error', error)
      destroyQuietly(res)
    })
    if (!safeWriteHead(res, upstreamRes.statusCode || 502, upstreamRes.headers)) {
      destroyQuietly(upstreamRes)
      return
    }
    upstreamRes.pipe(res)
  })
  req.on('aborted', () => destroyQuietly(upstream))
  req.on('error', (error) => {
    logProxyError('client request error', error)
    destroyQuietly(upstream)
  })
  res.on('error', (error) => {
    logProxyError('client response error', error)
    destroyQuietly(upstream)
  })
  res.on('close', () => {
    if (!res.writableEnded) destroyQuietly(upstream)
  })
  upstream.on('error', (error) => {
    logProxyError('upstream request error', error)
    if (!res.headersSent) {
      sendPlainText(res, 502, `CodexUI upstream unavailable: ${error.message}`)
      return
    }
    destroyQuietly(res)
  })
  req.pipe(upstream)
}

function proxyUpgrade(req, socket, head) {
  const upstream = http.request({
    hostname: '127.0.0.1',
    port: targetPort,
    method: req.method,
    path: req.url,
    headers: { ...req.headers, host: `localhost:${targetPort}` },
  })
  upstream.on('upgrade', (upstreamRes, upstreamSocket, upstreamHead) => {
    upstreamSocket.on('error', (error) => {
      logProxyError('upstream upgrade socket error', error)
      destroyQuietly(socket)
    })
    socket.on('error', (error) => {
      logProxyError('client upgrade socket error', error)
      destroyQuietly(upstreamSocket)
    })
    upstreamSocket.on('close', () => destroyQuietly(socket))
    socket.on('close', () => destroyQuietly(upstreamSocket))

    if (!safeSocketWrite(socket, `HTTP/${upstreamRes.httpVersion} ${upstreamRes.statusCode} ${upstreamRes.statusMessage}\r\n`)) {
      destroyQuietly(upstreamSocket)
      return
    }
    for (const [key, value] of Object.entries(upstreamRes.headers)) {
      if (Array.isArray(value)) {
        for (const item of value) safeSocketWrite(socket, `${key}: ${item}\r\n`)
      } else if (value !== undefined) {
        safeSocketWrite(socket, `${key}: ${value}\r\n`)
      }
    }
    safeSocketWrite(socket, '\r\n')
    if (upstreamHead.length) safeSocketWrite(socket, upstreamHead)
    if (head.length) safeSocketWrite(upstreamSocket, head)
    upstreamSocket.pipe(socket)
    socket.pipe(upstreamSocket)
  })
  socket.on('error', (error) => {
    logProxyError('client upgrade socket error', error)
    destroyQuietly(upstream)
  })
  socket.on('close', () => destroyQuietly(upstream))
  upstream.on('error', (error) => {
    logProxyError('upstream upgrade request error', error)
    safeSocketWrite(socket, 'HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n')
    destroyQuietly(socket)
  })
  upstream.end()
}

const server = http.createServer(async (req, res) => {
  if (!password) {
    proxyHttp(req, res)
    return
  }

  const url = new URL(req.url || '/', 'http://localhost')
  if (req.method === 'POST' && url.pathname === '/__codexui_public_login') {
    try {
      const body = await readBody(req)
      const params = new URLSearchParams(body)
      if (!timingSafePasswordEquals(params.get('password') || '')) {
        sendLoginPage(res, true)
        return
      }
      const cookie = createSessionCookie()
      if (!safeWriteHead(res, 302, {
        Location: '/',
        'Set-Cookie': `${cookieName}=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(sessionTtlMs / 1000)}`,
      })) return
      safeEnd(res)
    } catch (error) {
      logProxyError('login request error', error)
      sendPlainText(res, 400, '')
    }
    return
  }

  if (!isValidSession(parseCookies(req.headers.cookie)[cookieName])) {
    sendLoginPage(res)
    return
  }

  proxyHttp(req, res)
})

server.on('upgrade', (req, socket, head) => {
  if (!password || isValidSession(parseCookies(req.headers.cookie)[cookieName])) {
    proxyUpgrade(req, socket, head)
    return
  }
  socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n')
  socket.destroy()
})

server.on('clientError', (error, socket) => {
  logProxyError('server client error', error)
  safeSocketWrite(socket, 'HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  destroyQuietly(socket)
})

server.listen(listenPort, '127.0.0.1', () => {
  console.log(`CodexUI public auth proxy listening on http://127.0.0.1:${listenPort}/ -> http://127.0.0.1:${targetPort}/`)
  console.log(password ? 'Public password protection enabled.' : 'Public password protection disabled.')
})
