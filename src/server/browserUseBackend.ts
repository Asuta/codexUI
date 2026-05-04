import { createServer, type Socket, type Server } from 'node:net'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import {
  PLAYWRIGHT_STEALTH_CHROMIUM_ARGS,
  PLAYWRIGHT_STEALTH_CONTEXT_OPTIONS,
  PLAYWRIGHT_STEALTH_INIT_SCRIPT,
} from './playwrightStealthPayload.js'

type JsonRpcMessage = {
  jsonrpc?: '2.0'
  id?: number
  method?: string
  params?: Record<string, unknown>
  result?: unknown
  error?: {
    code: number
    message: string
  }
}

type BrowserUseTab = {
  id: number
  title?: string
  url?: string
  active?: boolean
}

type BrowserUseBackendRecord = {
  server: Server
  socketPath: string
  browserPromise: Promise<PlaywrightBrowser>
  tabs: Map<number, PlaywrightTab>
  nextTabId: number
  sessionId: string
}

type PlaywrightBrowser = {
  close(): Promise<void>
  newContext(options?: Record<string, unknown>): Promise<PlaywrightContext>
}

type PlaywrightContext = {
  newPage(): Promise<PlaywrightPage>
  newCDPSession(page: PlaywrightPage): Promise<PlaywrightCdpSession>
  addInitScript(script: string): Promise<void>
}

type PlaywrightPage = {
  title(): Promise<string>
  url(): string
  close(): Promise<void>
}

type PlaywrightCdpSession = {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>
  detach(): Promise<void>
  on(event: string, listener: (params: unknown) => void): void
}

type PlaywrightTab = {
  page: PlaywrightPage
  cdpSession?: PlaywrightCdpSession
  clients: Set<BrowserUseClient>
}

type BrowserUseClient = {
  socket: Socket
  backend: BrowserUseBackendRecord
  pendingData: Buffer
  send(message: JsonRpcMessage): void
}

const BROWSER_USE_SOCKET_DIR = '/tmp/codex-browser-use'
const CODEX_BROWSER_USE_PEER_AUTHORIZATION =
  '/Applications/Codex.app/Contents/Resources/native/browser-use-peer-authorization.node'
const BROWSER_USE_CLIENT_PATH =
  '/Users/igor/.codex/plugins/cache/openai-bundled/browser-use/0.1.0-alpha1/scripts/browser-client.mjs'
const BROWSER_USE_NATIVE_CREATE_SOURCE =
  'static async create(t){let n=eN();if(n!=null){let r=await n.createConnection(t),i=new e(r);return r.on("data",o=>i.handleData(o)),r.on("close",()=>{i.socket===r&&(i.socket=null)}),i}throw new Error(Q7())}'
const BROWSER_USE_CODEXUI_CREATE_SOURCE =
  'static async create(t){let n=eN();if(n!=null)try{let r=await n.createConnection(t),i=new e(r);return r.on("data",o=>i.handleData(o)),r.on("close",()=>{i.socket===r&&(i.socket=null)}),i}catch(r){if(!String(t).includes("codexui-"))throw r}try{let{createConnection:r}=await import("node:net"),i=r(t),o=new e(i);return await new Promise((s,a)=>{i.once("connect",s),i.once("error",a)}),i.on("data",s=>o.handleData(s)),i.on("close",()=>{o.socket===i&&(o.socket=null)}),o}catch(r){throw new Error(Q7())}}'
const browserUseBackends = new Map<string, BrowserUseBackendRecord>()
const require = createRequire(import.meta.url)
let browserUseClientPatchPromise: Promise<void> | null = null

export async function ensureBrowserUseBackendForSession(sessionId: string): Promise<void> {
  const normalizedSessionId = sessionId.trim()
  if (!normalizedSessionId || browserUseBackends.has(normalizedSessionId)) {
    return
  }

  await ensureBrowserUseClientFallbackPatch()
  await mkdir(BROWSER_USE_SOCKET_DIR, { recursive: true })
  const socketPath = join(BROWSER_USE_SOCKET_DIR, `codexui-${process.pid}-${normalizedSessionId}.sock`)
  await rm(socketPath, { force: true })

  const backend: BrowserUseBackendRecord = {
    server: createServer((socket) => handleConnection(backend, socket)),
    socketPath,
    browserPromise: launchBrowser(),
    tabs: new Map(),
    nextTabId: 1,
    sessionId: normalizedSessionId,
  }
  browserUseBackends.set(normalizedSessionId, backend)

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      backend.server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      backend.server.off('error', onError)
      resolve()
    }
    backend.server.once('error', onError)
    backend.server.once('listening', onListening)
    backend.server.listen(socketPath)
  })
}

async function ensureBrowserUseClientFallbackPatch(): Promise<void> {
  browserUseClientPatchPromise ??= (async () => {
    const source = await readFile(BROWSER_USE_CLIENT_PATH, 'utf8')
    if (source.includes(BROWSER_USE_CODEXUI_CREATE_SOURCE)) {
      return
    }
    if (!source.includes(BROWSER_USE_NATIVE_CREATE_SOURCE)) {
      throw new Error('Browser Use client transport shape changed; cannot install codexui fallback.')
    }
    await writeFile(
      BROWSER_USE_CLIENT_PATH,
      source.replace(BROWSER_USE_NATIVE_CREATE_SOURCE, BROWSER_USE_CODEXUI_CREATE_SOURCE),
    )
  })()
  await browserUseClientPatchPromise
}

export async function closeBrowserUseBackends(): Promise<void> {
  const backends = Array.from(browserUseBackends.values())
  browserUseBackends.clear()
  await Promise.allSettled(backends.map(async (backend) => {
    await new Promise<void>((resolve) => backend.server.close(() => resolve()))
    await rm(backend.socketPath, { force: true })
    const browser = await backend.browserPromise.catch(() => null)
    await browser?.close()
  }))
}

async function launchBrowser(): Promise<PlaywrightBrowser> {
  const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<{
    chromium: { launch(options?: Record<string, unknown>): Promise<PlaywrightBrowser> }
  }>
  const { chromium } = await dynamicImport('playwright')
  return await chromium.launch({
    args: [...PLAYWRIGHT_STEALTH_CHROMIUM_ARGS],
    headless: false,
  })
}

function handleConnection(backend: BrowserUseBackendRecord, socket: Socket): void {
  authorizeSocketPeer(socket)
  const client: BrowserUseClient = {
    backend,
    pendingData: Buffer.alloc(0),
    socket,
    send(message) {
      const body = Buffer.from(JSON.stringify(message), 'utf8')
      const header = Buffer.alloc(4)
      header.writeUInt32LE(body.length, 0)
      socket.write(Buffer.concat([header, body]))
    },
  }

  socket.on('data', (chunk) => {
    client.pendingData = Buffer.concat([client.pendingData, chunk])
    const parsed = parseFramedMessages(client.pendingData)
    client.pendingData = parsed.remainingData
    for (const message of parsed.messages) {
      void handleMessage(client, message)
    }
  })
}

function authorizeSocketPeer(socket: Socket): void {
  try {
    const fd = (socket as Socket & { _handle?: { fd?: number } })._handle?.fd
    if (typeof fd !== 'number') {
      return
    }
    const nativeModule = require(CODEX_BROWSER_USE_PEER_AUTHORIZATION) as {
      authorizeSocketPeer?: (fd: number, allowUnsignedPeer: boolean) => unknown
    }
    nativeModule.authorizeSocketPeer?.(fd, false)
  } catch {
    socket.destroy()
  }
}

function parseFramedMessages(data: Buffer): { messages: JsonRpcMessage[], remainingData: Buffer } {
  const messages: JsonRpcMessage[] = []
  let offset = 0
  while (data.length - offset >= 4) {
    const size = data.readUInt32LE(offset)
    const end = offset + 4 + size
    if (data.length < end) {
      break
    }
    const text = data.subarray(offset + 4, end).toString('utf8')
    messages.push(JSON.parse(text) as JsonRpcMessage)
    offset = end
  }
  return { messages, remainingData: data.subarray(offset) }
}

async function handleMessage(client: BrowserUseClient, message: JsonRpcMessage): Promise<void> {
  if (message.id == null || typeof message.method !== 'string') {
    return
  }
  try {
    const result = await handleRequest(client, message.method, message.params ?? {})
    client.send({ jsonrpc: '2.0', id: message.id, result })
  } catch (error) {
    client.send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: 1,
        message: error instanceof Error ? error.message : String(error),
      },
    })
  }
}

async function handleRequest(
  client: BrowserUseClient,
  method: string,
  params: Record<string, unknown>,
): Promise<unknown> {
  switch (method) {
    case 'ping':
      return 'pong'
    case 'getInfo':
      return {
        name: 'CodexUI Browser',
        version: '0.0.1',
        type: 'iab',
        metadata: {
          codexSessionId: client.backend.sessionId,
        },
        capabilities: {
          downloads: false,
          fileUploads: false,
          mediaDownloads: false,
        },
      }
    case 'createTab':
      return await createTab(client)
    case 'getTabs':
      return await getTabs(client.backend)
    case 'attach':
      await attachTab(client, Number(params.tabId))
      return {}
    case 'detach':
      await detachTab(client.backend, Number(params.tabId))
      return {}
    case 'executeCdp':
      return await executeCdp(client.backend, params)
    case 'moveMouse':
      return await moveMouse(client.backend, params)
    case 'nameSession':
    case 'finalizeTabs':
      return {}
    case 'getUserTabs':
      return { tabs: [] }
    case 'getUserHistory':
      return { items: [] }
    case 'claimUserTab':
      throw new Error('User tab claiming is not supported by CodexUI Browser Use backend.')
    default:
      throw new Error(`Unsupported Browser Use backend method: ${method}`)
  }
}

async function createTab(client: BrowserUseClient): Promise<BrowserUseTab> {
  const browser = await client.backend.browserPromise
  const context = await browser.newContext({
    ...PLAYWRIGHT_STEALTH_CONTEXT_OPTIONS,
    extraHTTPHeaders: { ...PLAYWRIGHT_STEALTH_CONTEXT_OPTIONS.extraHTTPHeaders },
  })
  await context.addInitScript(PLAYWRIGHT_STEALTH_INIT_SCRIPT)
  const page = await context.newPage()
  const tabId = client.backend.nextTabId++
  client.backend.tabs.set(tabId, { clients: new Set([client]), page })
  return await serializeTab(tabId, client.backend.tabs.get(tabId), true)
}

async function getTabs(backend: BrowserUseBackendRecord): Promise<BrowserUseTab[]> {
  const tabs: BrowserUseTab[] = []
  for (const [tabId, tab] of backend.tabs) {
    tabs.push(await serializeTab(tabId, tab, tabId === backend.nextTabId - 1))
  }
  return tabs
}

async function serializeTab(
  tabId: number,
  tab: PlaywrightTab | undefined,
  active = false,
): Promise<BrowserUseTab> {
  if (!tab) {
    return { id: tabId, active }
  }
  return {
    id: tabId,
    title: await tab.page.title().catch(() => ''),
    url: tab.page.url(),
    active,
  }
}

async function attachTab(client: BrowserUseClient, tabId: number): Promise<void> {
  const tab = getTab(client.backend, tabId)
  tab.clients.add(client)
  if (tab.cdpSession) {
    return
  }
  tab.cdpSession = await getPageContext(tab.page).newCDPSession(tab.page)
  forwardCdpEvents(client.backend, tabId, tab.cdpSession)
}

async function detachTab(backend: BrowserUseBackendRecord, tabId: number): Promise<void> {
  const tab = getTab(backend, tabId)
  await tab.cdpSession?.detach().catch(() => {})
  tab.cdpSession = undefined
  tab.clients.clear()
}

async function executeCdp(backend: BrowserUseBackendRecord, params: Record<string, unknown>): Promise<unknown> {
  const target = asRecord(params.target)
  const tabId = Number(target?.tabId)
  const method = typeof params.method === 'string' ? params.method : ''
  if (!method) {
    throw new Error('executeCdp requires method')
  }
  const commandParams = asRecord(params.commandParams) ?? {}
  const tab = getTab(backend, tabId)
  if (!tab.cdpSession) {
    const context = getPageContext(tab.page)
    tab.cdpSession = await context.newCDPSession(tab.page)
    forwardCdpEvents(backend, tabId, tab.cdpSession)
  }
  if (method === 'Page.close') {
    await tab.page.close()
    backend.tabs.delete(tabId)
    return {}
  }
  return await tab.cdpSession.send(method, commandParams)
}

async function moveMouse(backend: BrowserUseBackendRecord, params: Record<string, unknown>): Promise<void> {
  await executeCdp(backend, {
    target: { tabId: params.tabId },
    method: 'Input.dispatchMouseEvent',
    commandParams: {
      type: 'mouseMoved',
      x: Number(params.x),
      y: Number(params.y),
    },
  })
}

function forwardCdpEvents(
  backend: BrowserUseBackendRecord,
  tabId: number,
  cdpSession: PlaywrightCdpSession,
): void {
  const eventNames = [
    'Page.frameStartedLoading',
    'Page.frameNavigated',
    'Page.navigatedWithinDocument',
    'Page.domContentEventFired',
    'Page.loadEventFired',
    'Page.navigationBlocked',
  ]
  for (const eventName of eventNames) {
    cdpSession.on(eventName, (params) => {
      const tab = backend.tabs.get(tabId)
      for (const client of tab?.clients ?? []) {
        client.send({
          jsonrpc: '2.0',
          method: 'onCDPEvent',
          params: {
            method: eventName,
            params,
            source: { tabId },
          },
        })
      }
    })
  }
}

function getTab(backend: BrowserUseBackendRecord, tabId: number): PlaywrightTab {
  if (!Number.isInteger(tabId) || tabId <= 0) {
    throw new Error('Expected a positive tab id')
  }
  const tab = backend.tabs.get(tabId)
  if (!tab) {
    throw new Error(`Tab not found: ${tabId}`)
  }
  return tab
}

function getPageContext(page: PlaywrightPage): PlaywrightContext {
  return (page as PlaywrightPage & { context(): PlaywrightContext }).context()
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
}
