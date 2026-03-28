import { spawn, type ChildProcessWithoutNullStreams, type ChildProcess } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { getSpawnInvocation } from '../utils/commandInvocation.js'
import { resolveAcpAgentCommand, type AcpAgentId } from '../commandResolution.js'

type JsonRpcCall = {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

type JsonRpcResponse = {
  id?: number
  result?: unknown
  error?: {
    code: number
    message: string
  }
  method?: string
  params?: unknown
}

type PendingServerRequest = {
  id: number
  method: string
  params: unknown
  receivedAtIso: string
}

type AcpSessionState = {
  sessionId: string
  cwd: string
  threadId: string
  createdAtMs: number
  title: string
  messages: AcpSessionMessage[]
  inProgress: boolean
}

type AcpSessionMessage = {
  id: string
  role: 'user' | 'assistant'
  text: string
  timestamp: number
}

type AcpToolCallState = {
  toolCallId: string
  title: string
  kind: string
  status: string
  rawInput: string
  rawOutput: string
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}

function getErrorMessage(payload: unknown, fallback: string): string {
  if (payload instanceof Error && payload.message.trim().length > 0) {
    return payload.message
  }
  const record = asRecord(payload)
  if (!record) return fallback
  const error = record.error
  if (typeof error === 'string' && error.length > 0) return error
  const nestedError = asRecord(error)
  if (nestedError && typeof nestedError.message === 'string' && nestedError.message.length > 0) {
    return nestedError.message
  }
  return fallback
}

function setJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.statusCode = statusCode
  res.setHeader('Content-Type', 'application/json; charset=utf-8')
  res.end(JSON.stringify(payload))
}

function generateId(): string {
  return randomBytes(8).toString('hex')
}

function getCodexHomeDir(): string {
  const codexHome = process.env.CODEX_HOME?.trim()
  return codexHome && codexHome.length > 0 ? codexHome : join(homedir(), '.codex')
}

function getCodexGlobalStatePath(): string {
  return join(getCodexHomeDir(), '.codex-global-state.json')
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const normalized: string[] = []
  for (const item of value) {
    if (typeof item === 'string' && item.length > 0 && !normalized.includes(item)) {
      normalized.push(item)
    }
  }
  return normalized
}

function normalizeStringRecord(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const next: Record<string, string> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (typeof key === 'string' && key.length > 0 && typeof item === 'string') {
      next[key] = item
    }
  }
  return next
}

type WorkspaceRootsState = {
  order: string[]
  labels: Record<string, string>
  active: string[]
}

async function readWorkspaceRootsState(): Promise<WorkspaceRootsState> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    const parsed = JSON.parse(raw) as unknown
    payload = asRecord(parsed) ?? {}
  } catch {
    payload = {}
  }
  return {
    order: normalizeStringArray(payload['electron-saved-workspace-roots']),
    labels: normalizeStringRecord(payload['electron-workspace-root-labels']),
    active: normalizeStringArray(payload['active-workspace-roots']),
  }
}

async function writeWorkspaceRootsState(nextState: WorkspaceRootsState): Promise<void> {
  const statePath = getCodexGlobalStatePath()
  let payload: Record<string, unknown> = {}
  try {
    const raw = await readFile(statePath, 'utf8')
    payload = asRecord(JSON.parse(raw)) ?? {}
  } catch {
    payload = {}
  }
  payload['electron-saved-workspace-roots'] = normalizeStringArray(nextState.order)
  payload['electron-workspace-root-labels'] = normalizeStringRecord(nextState.labels)
  payload['active-workspace-roots'] = normalizeStringArray(nextState.active)
  await writeFile(statePath, JSON.stringify(payload), 'utf8')
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Uint8Array[] = []
  for await (const chunk of req) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
  }
  const raw = Buffer.concat(chunks)
  if (raw.length === 0) return null
  const text = raw.toString('utf8').trim()
  if (text.length === 0) return null
  return JSON.parse(text) as unknown
}

export class AcpServerProcess {
  private process: ChildProcessWithoutNullStreams | null = null
  private initialized = false
  private initializePromise: Promise<void> | null = null
  private readBuffer = ''
  private nextId = 1
  private stopping = false
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (reason?: unknown) => void }>()
  private readonly notificationListeners = new Set<(value: { method: string; params: unknown }) => void>()
  private readonly pendingServerRequests = new Map<number, PendingServerRequest>()
  private readonly sessions = new Map<string, AcpSessionState>()
  private readonly toolCalls = new Map<string, AcpToolCallState>()
  private agentId: AcpAgentId

  constructor(agentId: AcpAgentId = 'gemini') {
    this.agentId = agentId
  }

  setAgentId(agentId: AcpAgentId): void {
    this.agentId = agentId
  }

  private getAgentCommand(): { command: string; args: string[] } {
    const resolved = resolveAcpAgentCommand(this.agentId)
    if (!resolved) {
      throw new Error(`ACP agent "${this.agentId}" is not available. Ensure the command is installed and in PATH.`)
    }
    return resolved
  }

  private start(): void {
    if (this.process) return
    this.stopping = false

    const agent = this.getAgentCommand()
    const invocation = getSpawnInvocation(agent.command, agent.args)
    const proc = spawn(invocation.command, invocation.args, { stdio: ['pipe', 'pipe', 'pipe'] })
    this.process = proc

    proc.stdout.setEncoding('utf8')
    proc.stdout.on('data', (chunk: string) => {
      this.readBuffer += chunk
      let lineEnd = this.readBuffer.indexOf('\n')
      while (lineEnd !== -1) {
        const line = this.readBuffer.slice(0, lineEnd).trim()
        this.readBuffer = this.readBuffer.slice(lineEnd + 1)
        if (line.length > 0) {
          this.handleLine(line)
        }
        lineEnd = this.readBuffer.indexOf('\n')
      }
    })

    proc.stderr.setEncoding('utf8')
    proc.stderr.on('data', () => {})

    proc.on('exit', () => {
      const failure = new Error(this.stopping ? 'ACP agent stopped' : 'ACP agent exited unexpectedly')
      for (const request of this.pending.values()) {
        request.reject(failure)
      }
      this.pending.clear()
      this.pendingServerRequests.clear()
      this.process = null
      this.initialized = false
      this.initializePromise = null
      this.readBuffer = ''
    })
  }

  private sendLine(payload: Record<string, unknown>): void {
    if (!this.process) {
      throw new Error('ACP agent is not running')
    }
    this.process.stdin.write(`${JSON.stringify(payload)}\n`)
  }

  private handleLine(line: string): void {
    let message: JsonRpcResponse
    try {
      message = JSON.parse(line) as JsonRpcResponse
    } catch {
      return
    }

    if (typeof message.id === 'number' && this.pending.has(message.id)) {
      const pendingRequest = this.pending.get(message.id)
      this.pending.delete(message.id)
      if (!pendingRequest) return
      if (message.error) {
        pendingRequest.reject(new Error(message.error.message))
      } else {
        pendingRequest.resolve(message.result)
      }
      return
    }

    if (typeof message.method === 'string' && typeof message.id !== 'number') {
      this.handleAcpNotification(message.method, message.params ?? null)
      return
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.handleAcpServerRequest(message.id, message.method, message.params ?? null)
    }
  }

  private handleAcpNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      this.processSessionUpdate(params)
      return
    }
    this.emitNotification({ method, params })
  }

  private processSessionUpdate(params: unknown): void {
    const record = asRecord(params)
    if (!record) return

    const sessionId = typeof record.sessionId === 'string' ? record.sessionId : ''
    const update = asRecord(record.update)
    if (!update) return

    const sessionUpdate = typeof update.sessionUpdate === 'string' ? update.sessionUpdate : ''
    const session = this.findSessionByAcpId(sessionId)
    const threadId = session?.threadId ?? ''

    switch (sessionUpdate) {
      case 'agent_message_chunk': {
        const content = asRecord(update.content)
        const text = typeof content?.text === 'string' ? content.text : ''
        if (text && session) {
          const lastMsg = session.messages[session.messages.length - 1]
          if (lastMsg && lastMsg.role === 'assistant') {
            lastMsg.text += text
          } else {
            session.messages.push({
              id: generateId(),
              role: 'assistant',
              text,
              timestamp: Date.now(),
            })
          }
        }

        const messageId = session
          ? (session.messages[session.messages.length - 1]?.id ?? generateId())
          : generateId()

        this.emitNotification({
          method: 'item/agentMessage/delta',
          params: {
            threadId,
            itemId: messageId,
            delta: text,
          },
        })
        break
      }

      case 'agent_thought_chunk': {
        const content = asRecord(update.content)
        const text = typeof content?.text === 'string' ? content.text : ''
        if (text) {
          this.emitNotification({
            method: 'item/reasoning/delta',
            params: {
              threadId,
              itemId: `reasoning-${threadId}`,
              delta: text,
            },
          })
        }
        break
      }

      case 'tool_call': {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : generateId()
        const title = typeof update.title === 'string' ? update.title : ''
        const kind = typeof update.kind === 'string' ? update.kind : 'other'
        const status = typeof update.status === 'string' ? update.status : 'running'
        const rawInput = typeof update.rawInput === 'string' ? update.rawInput : ''
        const rawOutput = typeof update.rawOutput === 'string' ? update.rawOutput : ''

        this.toolCalls.set(toolCallId, { toolCallId, title, kind, status, rawInput, rawOutput })

        const commandText = title || rawInput || 'Tool call'
        this.emitNotification({
          method: 'item/commandExecution/started',
          params: {
            threadId,
            itemId: toolCallId,
            command: commandText,
            cwd: session?.cwd ?? null,
          },
        })

        this.emitNotification({
          method: 'turn/activity',
          params: {
            threadId,
            activity: {
              label: 'Running tool',
              details: [commandText],
            },
          },
        })
        break
      }

      case 'tool_call_update': {
        const toolCallId = typeof update.toolCallId === 'string' ? update.toolCallId : ''
        const existing = this.toolCalls.get(toolCallId)
        if (!existing) break

        const newStatus = typeof update.status === 'string' ? update.status : existing.status
        const newTitle = typeof update.title === 'string' ? update.title : existing.title
        const newRawOutput = typeof update.rawOutput === 'string' ? update.rawOutput : existing.rawOutput

        existing.status = newStatus
        existing.title = newTitle
        existing.rawOutput = newRawOutput

        if (newRawOutput && newRawOutput !== existing.rawOutput) {
          this.emitNotification({
            method: 'item/commandExecution/outputDelta',
            params: {
              threadId,
              itemId: toolCallId,
              delta: newRawOutput,
            },
          })
        }

        const isCompleted = newStatus === 'completed' || newStatus === 'error'
        if (isCompleted) {
          this.emitNotification({
            method: 'item/commandExecution/completed',
            params: {
              threadId,
              itemId: toolCallId,
              command: existing.title || existing.rawInput || 'Tool call',
              cwd: session?.cwd ?? null,
              status: newStatus === 'error' ? 'failed' : 'completed',
              aggregatedOutput: existing.rawOutput,
              exitCode: newStatus === 'error' ? 1 : 0,
            },
          })
        }
        break
      }

      case 'plan': {
        const entries = Array.isArray(update.entries) ? update.entries : []
        const planDetails = entries
          .map((entry: unknown) => {
            const e = asRecord(entry)
            return typeof e?.description === 'string' ? e.description : ''
          })
          .filter(Boolean)

        this.emitNotification({
          method: 'turn/activity',
          params: {
            threadId,
            activity: {
              label: 'Planning',
              details: planDetails,
            },
          },
        })
        break
      }

      case 'session_info_update': {
        const title = typeof update.title === 'string' ? update.title.trim() : ''
        if (title && session) {
          session.title = title
          this.emitNotification({
            method: 'thread/name/updated',
            params: { threadId, threadName: title },
          })
        }
        break
      }

      default:
        break
    }
  }

  private handleAcpServerRequest(requestId: number, method: string, params: unknown): void {
    if (method === 'session/request_permission') {
      this.autoAcceptPermission(requestId, params)
      return
    }

    if (method === 'fs/read_text_file') {
      this.handleFsReadTextFile(requestId, params)
      return
    }

    if (method === 'fs/write_text_file') {
      this.handleFsWriteTextFile(requestId, params)
      return
    }

    if (method === 'terminal/create') {
      this.handleTerminalCreate(requestId, params)
      return
    }

    if (method === 'terminal/output') {
      this.handleTerminalOutput(requestId, params)
      return
    }

    if (method === 'terminal/wait_for_exit') {
      this.handleTerminalWaitForExit(requestId, params)
      return
    }

    if (method === 'terminal/kill' || method === 'terminal/release') {
      this.handleTerminalKillOrRelease(requestId, params)
      return
    }

    const pendingRequest: PendingServerRequest = {
      id: requestId,
      method,
      params,
      receivedAtIso: new Date().toISOString(),
    }
    this.pendingServerRequests.set(requestId, pendingRequest)
    this.emitNotification({
      method: 'server/request',
      params: pendingRequest,
    })
  }

  private autoAcceptPermission(requestId: number, params: unknown): void {
    const record = asRecord(params)
    const options = Array.isArray(record?.options) ? record.options : []

    let selectedOptionId = ''

    for (const option of options) {
      const opt = asRecord(option)
      if (!opt) continue
      const kind = typeof opt.kind === 'string' ? opt.kind : ''
      const optionId = typeof opt.optionId === 'string' ? opt.optionId : ''
      if (kind === 'allow_always' && optionId) {
        selectedOptionId = optionId
        break
      }
    }

    if (!selectedOptionId) {
      for (const option of options) {
        const opt = asRecord(option)
        if (!opt) continue
        const kind = typeof opt.kind === 'string' ? opt.kind : ''
        const optionId = typeof opt.optionId === 'string' ? opt.optionId : ''
        if (kind === 'allow_once' && optionId) {
          selectedOptionId = optionId
          break
        }
      }
    }

    if (!selectedOptionId && options.length > 0) {
      const firstOpt = asRecord(options[0])
      selectedOptionId = typeof firstOpt?.optionId === 'string' ? firstOpt.optionId : ''
    }

    this.sendLine({
      jsonrpc: '2.0',
      id: requestId,
      result: {
        outcome: {
          outcome: 'selected',
          optionId: selectedOptionId,
        },
      },
    })

    const sessionId = typeof (asRecord(params) as Record<string, unknown>)?.sessionId === 'string'
      ? (params as Record<string, unknown>).sessionId as string
      : ''
    const session = this.findSessionByAcpId(sessionId)
    const threadId = session?.threadId ?? ''

    this.emitNotification({
      method: 'server/request/resolved',
      params: {
        id: requestId,
        method: 'session/request_permission',
        threadId,
        mode: 'auto-accept',
        resolvedAtIso: new Date().toISOString(),
      },
    })
  }

  private readonly terminals = new Map<string, {
    proc: ChildProcess
    stdout: string
    exitCode: number | null
    exitSignal: string | null
    exited: boolean
    exitWaiters: Array<() => void>
  }>()

  private handleTerminalCreate(requestId: number, params: unknown): void {
    const record = asRecord(params)
    const command = typeof record?.command === 'string' ? record.command : ''
    const args = Array.isArray(record?.args) ? record.args.filter((a: unknown) => typeof a === 'string') as string[] : []
    const cwd = typeof record?.cwd === 'string' ? record.cwd : undefined
    const terminalId = `term-${generateId()}`

    try {
      const proc = spawn(command, args, {
        cwd,
        env: process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: true,
      })

      const termState = {
        proc,
        stdout: '',
        exitCode: null as number | null,
        exitSignal: null as string | null,
        exited: false,
        exitWaiters: [] as Array<() => void>,
      }

      proc.stdout.setEncoding('utf8')
      proc.stdout.on('data', (chunk: string) => { termState.stdout += chunk })
      proc.stderr.setEncoding('utf8')
      proc.stderr.on('data', (chunk: string) => { termState.stdout += chunk })

      proc.on('exit', (code, signal) => {
        termState.exitCode = code
        termState.exitSignal = signal
        termState.exited = true
        for (const waiter of termState.exitWaiters) waiter()
        termState.exitWaiters = []
      })

      proc.on('error', () => {
        termState.exited = true
        termState.exitCode = 1
        for (const waiter of termState.exitWaiters) waiter()
        termState.exitWaiters = []
      })

      this.terminals.set(terminalId, termState)

      this.sendLine({
        jsonrpc: '2.0',
        id: requestId,
        result: { terminalId },
      })
    } catch (error) {
      this.sendLine({
        jsonrpc: '2.0',
        id: requestId,
        error: { code: -32000, message: getErrorMessage(error, 'Failed to create terminal') },
      })
    }
  }

  private handleTerminalOutput(requestId: number, params: unknown): void {
    const record = asRecord(params)
    const terminalId = typeof record?.terminalId === 'string' ? record.terminalId : ''
    const term = this.terminals.get(terminalId)
    if (!term) {
      this.sendLine({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Terminal not found' } })
      return
    }
    this.sendLine({
      jsonrpc: '2.0',
      id: requestId,
      result: {
        output: term.stdout,
        truncated: false,
        exitStatus: term.exited ? { exitCode: term.exitCode, signal: term.exitSignal } : null,
      },
    })
  }

  private handleTerminalWaitForExit(requestId: number, params: unknown): void {
    const record = asRecord(params)
    const terminalId = typeof record?.terminalId === 'string' ? record.terminalId : ''
    const term = this.terminals.get(terminalId)
    if (!term) {
      this.sendLine({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Terminal not found' } })
      return
    }
    if (term.exited) {
      this.sendLine({ jsonrpc: '2.0', id: requestId, result: { exitCode: term.exitCode, signal: term.exitSignal } })
      return
    }
    term.exitWaiters.push(() => {
      this.sendLine({ jsonrpc: '2.0', id: requestId, result: { exitCode: term.exitCode, signal: term.exitSignal } })
    })
  }

  private handleTerminalKillOrRelease(requestId: number, params: unknown): void {
    const record = asRecord(params)
    const terminalId = typeof record?.terminalId === 'string' ? record.terminalId : ''
    const term = this.terminals.get(terminalId)
    if (term && !term.exited) {
      try { term.proc.kill('SIGTERM') } catch {}
    }
    this.sendLine({ jsonrpc: '2.0', id: requestId, result: {} })
  }

  private handleFsReadTextFile(requestId: number, params: unknown): void {
    const record = asRecord(params)
    const filePath = typeof record?.path === 'string' ? record.path : ''
    if (!filePath) {
      this.sendLine({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Missing path' } })
      return
    }
    void readFile(filePath, 'utf8')
      .then((content) => {
        this.sendLine({ jsonrpc: '2.0', id: requestId, result: { content } })
      })
      .catch((error) => {
        this.sendLine({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: getErrorMessage(error, 'Read failed') } })
      })
  }

  private handleFsWriteTextFile(requestId: number, params: unknown): void {
    const record = asRecord(params)
    const filePath = typeof record?.path === 'string' ? record.path : ''
    const content = typeof record?.content === 'string' ? record.content : ''
    if (!filePath) {
      this.sendLine({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: 'Missing path' } })
      return
    }
    void writeFile(filePath, content, 'utf8')
      .then(() => {
        this.sendLine({ jsonrpc: '2.0', id: requestId, result: {} })
      })
      .catch((error) => {
        this.sendLine({ jsonrpc: '2.0', id: requestId, error: { code: -32000, message: getErrorMessage(error, 'Write failed') } })
      })
  }

  private findSessionByAcpId(acpSessionId: string): AcpSessionState | null {
    if (!acpSessionId) return null
    for (const session of this.sessions.values()) {
      if (session.sessionId === acpSessionId) return session
    }
    return null
  }

  private emitNotification(notification: { method: string; params: unknown }): void {
    for (const listener of this.notificationListeners) {
      listener(notification)
    }
  }

  private async call(method: string, params: unknown): Promise<unknown> {
    this.start()
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject })
      this.sendLine({
        jsonrpc: '2.0',
        id,
        method,
        params,
      } satisfies JsonRpcCall)
    })
  }

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return
    if (this.initializePromise) {
      await this.initializePromise
      return
    }
    this.initializePromise = this.call('initialize', {
      protocolVersion: '1',
      clientInfo: {
        name: 'codex-web-local',
        version: '0.1.0',
      },
      capabilities: {
        fs: { readTextFile: true, writeTextFile: true },
        terminal: true,
      },
    }).then(() => {
      this.initialized = true
    }).finally(() => {
      this.initializePromise = null
    })
    await this.initializePromise
  }

  async createSession(cwd: string): Promise<{ threadId: string; sessionId: string }> {
    await this.ensureInitialized()
    const result = asRecord(await this.call('session/new', {
      cwd,
      mcpServers: [],
    }))
    const sessionId = typeof result?.sessionId === 'string' ? result.sessionId : ''
    if (!sessionId) {
      throw new Error('session/new did not return a sessionId')
    }
    const threadId = `acp-${generateId()}`
    const session: AcpSessionState = {
      sessionId,
      cwd,
      threadId,
      createdAtMs: Date.now(),
      title: '',
      messages: [],
      inProgress: false,
    }
    this.sessions.set(threadId, session)
    return { threadId, sessionId }
  }

  async sendPrompt(threadId: string, text: string): Promise<void> {
    await this.ensureInitialized()
    const session = this.sessions.get(threadId)
    if (!session) {
      throw new Error(`No session found for thread ${threadId}`)
    }

    session.inProgress = true
    session.messages.push({
      id: generateId(),
      role: 'user',
      text,
      timestamp: Date.now(),
    })

    if (!session.title) {
      session.title = text.slice(0, 80).trim() || 'New chat'
    }

    this.emitNotification({
      method: 'turn/started',
      params: {
        threadId,
        turnId: `turn-${generateId()}`,
        startedAtIso: new Date().toISOString(),
      },
    })

    try {
      const result = asRecord(await this.call('session/prompt', {
        sessionId: session.sessionId,
        content: [{ type: 'text', text }],
      }))

      session.inProgress = false
      const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn'
      const status = stopReason === 'error' ? 'failed' : 'completed'

      this.emitNotification({
        method: 'turn/completed',
        params: {
          threadId,
          turnId: `turn-${generateId()}`,
          status,
          completedAtIso: new Date().toISOString(),
        },
      })
    } catch (error) {
      session.inProgress = false
      this.emitNotification({
        method: 'turn/completed',
        params: {
          threadId,
          turnId: `turn-${generateId()}`,
          status: 'failed',
          error: getErrorMessage(error, 'Prompt failed'),
          completedAtIso: new Date().toISOString(),
        },
      })
      throw error
    }
  }

  async cancelSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId)
    if (!session) return
    try {
      this.sendLine({
        jsonrpc: '2.0',
        method: 'session/cancel',
        params: { sessionId: session.sessionId },
      })
    } catch {}
  }

  getSession(threadId: string): AcpSessionState | undefined {
    return this.sessions.get(threadId)
  }

  listSessions(): AcpSessionState[] {
    return Array.from(this.sessions.values())
      .sort((a, b) => b.createdAtMs - a.createdAtMs)
  }

  deleteSession(threadId: string): void {
    this.sessions.delete(threadId)
  }

  onNotification(listener: (value: { method: string; params: unknown }) => void): () => void {
    this.notificationListeners.add(listener)
    return () => {
      this.notificationListeners.delete(listener)
    }
  }

  listPendingServerRequests(): PendingServerRequest[] {
    return Array.from(this.pendingServerRequests.values())
  }

  async respondToServerRequest(payload: unknown): Promise<void> {
    await this.ensureInitialized()
    const body = asRecord(payload)
    if (!body) throw new Error('Invalid response payload: expected object')
    const id = body.id
    if (typeof id !== 'number' || !Number.isInteger(id)) {
      throw new Error('Invalid response payload: "id" must be an integer')
    }
    const rawError = asRecord(body.error)
    if (rawError) {
      const message = typeof rawError.message === 'string' && rawError.message.trim().length > 0
        ? rawError.message.trim()
        : 'Server request rejected by client'
      const code = typeof rawError.code === 'number' && Number.isFinite(rawError.code)
        ? Math.trunc(rawError.code)
        : -32000
      this.sendLine({ jsonrpc: '2.0', id, error: { code, message } })
      this.pendingServerRequests.delete(id)
      return
    }
    if (!('result' in body)) {
      throw new Error('Invalid response payload: expected "result" or "error"')
    }
    this.sendLine({ jsonrpc: '2.0', id, result: body.result ?? {} })
    this.pendingServerRequests.delete(id)
  }

  dispose(): void {
    if (!this.process) return
    const proc = this.process
    this.stopping = true
    this.process = null
    this.initialized = false
    this.initializePromise = null
    this.readBuffer = ''

    const failure = new Error('ACP agent stopped')
    for (const request of this.pending.values()) {
      request.reject(failure)
    }
    this.pending.clear()
    this.pendingServerRequests.clear()

    for (const term of this.terminals.values()) {
      if (!term.exited) {
        try { term.proc.kill('SIGTERM') } catch {}
      }
    }
    this.terminals.clear()

    try { proc.stdin.end() } catch {}
    try { proc.kill('SIGTERM') } catch {}

    const forceKillTimer = setTimeout(() => {
      if (!proc.killed) {
        try { proc.kill('SIGKILL') } catch {}
      }
    }, 1500)
    forceKillTimer.unref()
  }
}

export type AcpBridgeMiddleware = ((req: IncomingMessage, res: ServerResponse, next: () => void) => Promise<void>) & {
  dispose: () => void
  subscribeNotifications: (listener: (value: { method: string; params: unknown; atIso: string }) => void) => () => void
}

type SharedAcpBridgeState = {
  acpServer: AcpServerProcess
}

const SHARED_ACP_BRIDGE_KEY = '__codexAcpSharedBridge__'

function getSharedAcpBridgeState(agentId: AcpAgentId): SharedAcpBridgeState {
  const globalScope = globalThis as typeof globalThis & {
    [SHARED_ACP_BRIDGE_KEY]?: SharedAcpBridgeState
  }
  const existing = globalScope[SHARED_ACP_BRIDGE_KEY]
  if (existing) {
    existing.acpServer.setAgentId(agentId)
    return existing
  }
  const acpServer = new AcpServerProcess(agentId)
  const created: SharedAcpBridgeState = { acpServer }
  globalScope[SHARED_ACP_BRIDGE_KEY] = created
  return created
}

export function createAcpBridgeMiddleware(agentId: AcpAgentId = 'gemini'): AcpBridgeMiddleware {
  const { acpServer } = getSharedAcpBridgeState(agentId)

  const middleware = async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    try {
      if (!req.url) {
        next()
        return
      }
      const url = new URL(req.url, 'http://localhost')

      if (req.method === 'POST' && url.pathname === '/codex-api/rpc') {
        const payload = await readJsonBody(req)
        const body = asRecord(payload)
        if (!body || typeof body.method !== 'string' || body.method.length === 0) {
          setJson(res, 400, { error: 'Invalid body: expected { method, params? }' })
          return
        }

        const result = await handleAcpRpc(acpServer, body.method, body.params ?? null)
        setJson(res, 200, { result })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/server-requests/respond') {
        const payload = await readJsonBody(req)
        await acpServer.respondToServerRequest(payload)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/server-requests/pending') {
        setJson(res, 200, { data: acpServer.listPendingServerRequests() })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/methods') {
        setJson(res, 200, {
          data: [
            'thread/list', 'thread/start', 'thread/read', 'thread/archive',
            'thread/name/set', 'thread/resume', 'thread/rollback', 'thread/fork',
            'turn/start', 'turn/interrupt', 'model/list', 'config/read',
          ],
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/meta/notifications') {
        setJson(res, 200, {
          data: [
            'turn/started', 'turn/completed', 'turn/activity',
            'item/agentMessage/delta', 'item/agentMessage/completed',
            'item/reasoning/delta', 'item/commandExecution/started',
            'item/commandExecution/completed', 'item/commandExecution/outputDelta',
            'thread/name/updated', 'server/request', 'server/request/resolved',
          ],
        })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/workspace-roots-state') {
        const state = await readWorkspaceRootsState()
        setJson(res, 200, { data: state })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/workspace-roots-state') {
        const payload = await readJsonBody(req)
        const record = asRecord(payload)
        if (!record) {
          setJson(res, 400, { error: 'Invalid body: expected object' })
          return
        }
        const nextState: WorkspaceRootsState = {
          order: normalizeStringArray(record.order),
          labels: normalizeStringRecord(record.labels),
          active: normalizeStringArray(record.active),
        }
        await writeWorkspaceRootsState(nextState)
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/home-directory') {
        setJson(res, 200, { data: { path: homedir() } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/thread-titles') {
        const sessions = acpServer.listSessions()
        const titles: Record<string, string> = {}
        const order: string[] = []
        for (const session of sessions) {
          if (session.title) {
            titles[session.threadId] = session.title
            order.push(session.threadId)
          }
        }
        setJson(res, 200, { data: { titles, order } })
        return
      }

      if (req.method === 'PUT' && url.pathname === '/codex-api/thread-titles') {
        const payload = asRecord(await readJsonBody(req))
        const id = typeof payload?.id === 'string' ? payload.id : ''
        const title = typeof payload?.title === 'string' ? payload.title : ''
        if (id) {
          const session = acpServer.getSession(id)
          if (session) session.title = title
        }
        setJson(res, 200, { ok: true })
        return
      }

      if (req.method === 'POST' && url.pathname === '/codex-api/project-root') {
        const payload = asRecord(await readJsonBody(req))
        const rawPath = typeof payload?.path === 'string' ? payload.path.trim() : ''
        const createIfMissing = payload?.createIfMissing === true
        const label = typeof payload?.label === 'string' ? payload.label : ''
        if (!rawPath) {
          setJson(res, 400, { error: 'Missing path' })
          return
        }
        const normalizedPath = isAbsolute(rawPath) ? rawPath : resolve(rawPath)
        let pathExists = true
        try {
          const info = await stat(normalizedPath)
          if (!info.isDirectory()) {
            setJson(res, 400, { error: 'Path exists but is not a directory' })
            return
          }
        } catch {
          pathExists = false
        }
        if (!pathExists && createIfMissing) {
          await mkdir(normalizedPath, { recursive: true })
        } else if (!pathExists) {
          setJson(res, 404, { error: 'Directory does not exist' })
          return
        }
        const existingState = await readWorkspaceRootsState()
        const nextOrder = [normalizedPath, ...existingState.order.filter((item) => item !== normalizedPath)]
        const nextActive = [normalizedPath, ...existingState.active.filter((item) => item !== normalizedPath)]
        const nextLabels = { ...existingState.labels }
        if (label.trim().length > 0) nextLabels[normalizedPath] = label.trim()
        await writeWorkspaceRootsState({ order: nextOrder, labels: nextLabels, active: nextActive })
        setJson(res, 200, { data: { path: normalizedPath } })
        return
      }

      if (req.method === 'GET' && url.pathname === '/codex-api/events') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
        res.setHeader('Cache-Control', 'no-cache, no-transform')
        res.setHeader('Connection', 'keep-alive')
        res.setHeader('X-Accel-Buffering', 'no')

        const unsubscribe = middleware.subscribeNotifications((notification) => {
          if (res.writableEnded || res.destroyed) return
          res.write(`data: ${JSON.stringify(notification)}\n\n`)
        })

        res.write(`event: ready\ndata: ${JSON.stringify({ ok: true })}\n\n`)
        const keepAlive = setInterval(() => {
          res.write(': ping\n\n')
        }, 15000)

        const close = () => {
          clearInterval(keepAlive)
          unsubscribe()
          if (!res.writableEnded) res.end()
        }
        req.on('close', close)
        req.on('aborted', close)
        return
      }

      next()
    } catch (error) {
      const message = getErrorMessage(error, 'Unknown ACP bridge error')
      setJson(res, 502, { error: message })
    }
  }

  middleware.dispose = () => {
    acpServer.dispose()
  }

  middleware.subscribeNotifications = (
    listener: (value: { method: string; params: unknown; atIso: string }) => void,
  ) => {
    return acpServer.onNotification((notification) => {
      listener({ ...notification, atIso: new Date().toISOString() })
    })
  }

  return middleware
}

async function handleAcpRpc(
  acpServer: AcpServerProcess,
  method: string,
  params: unknown,
): Promise<unknown> {
  const record = asRecord(params)

  switch (method) {
    case 'thread/list': {
      const sessions = acpServer.listSessions()
      return {
        data: sessions.map((s) => ({
          id: s.threadId,
          name: s.title || undefined,
          preview: s.messages.length > 0 ? s.messages[0].text.slice(0, 200) : '',
          cwd: s.cwd,
          updatedAt: s.messages.length > 0
            ? s.messages[s.messages.length - 1].timestamp / 1000
            : s.createdAtMs / 1000,
          createdAt: s.createdAtMs / 1000,
        })),
      }
    }

    case 'thread/start': {
      const cwd = typeof record?.cwd === 'string' && record.cwd.trim().length > 0
        ? record.cwd.trim()
        : process.cwd()
      const { threadId } = await acpServer.createSession(cwd)
      return { thread: { id: threadId } }
    }

    case 'thread/read': {
      const threadId = typeof record?.threadId === 'string' ? record.threadId : ''
      const session = acpServer.getSession(threadId)
      if (!session) {
        throw new Error(`Thread ${threadId} not found`)
      }
      return {
        thread: {
          id: session.threadId,
          cwd: session.cwd,
          preview: session.messages.length > 0 ? session.messages[0].text.slice(0, 200) : '',
          turns: [{
            id: `turn-${session.threadId}`,
            status: session.inProgress ? 'in_progress' : 'completed',
            items: session.messages.map((msg) => ({
              id: msg.id,
              type: msg.role === 'user' ? 'userMessage' : 'agentMessage',
              ...(msg.role === 'user'
                ? { content: [{ type: 'text', text: msg.text }] }
                : { text: msg.text }),
            })),
          }],
          updatedAt: session.messages.length > 0
            ? session.messages[session.messages.length - 1].timestamp / 1000
            : session.createdAtMs / 1000,
          createdAt: session.createdAtMs / 1000,
        },
      }
    }

    case 'thread/archive': {
      const threadId = typeof record?.threadId === 'string' ? record.threadId : ''
      acpServer.deleteSession(threadId)
      return {}
    }

    case 'thread/name/set': {
      const threadId = typeof record?.threadId === 'string' ? record.threadId : ''
      const name = typeof record?.name === 'string' ? record.name : ''
      const session = acpServer.getSession(threadId)
      if (session) session.title = name
      return {}
    }

    case 'thread/resume':
    case 'thread/rollback':
    case 'thread/fork':
      return {}

    case 'turn/start': {
      const threadId = typeof record?.threadId === 'string' ? record.threadId : ''
      const input = Array.isArray(record?.input) ? record.input : []
      let text = ''
      for (const block of input) {
        const b = asRecord(block)
        if (b?.type === 'text' && typeof b.text === 'string') {
          text += b.text
        }
      }
      if (!text.trim()) {
        throw new Error('Empty prompt text')
      }
      void acpServer.sendPrompt(threadId, text.trim())
      return {}
    }

    case 'turn/interrupt': {
      const threadId = typeof record?.threadId === 'string' ? record.threadId : ''
      await acpServer.cancelSession(threadId)
      return {}
    }

    case 'model/list':
      return { data: [{ id: 'acp-agent', model: 'acp-agent' }] }

    case 'config/read':
      return { config: { model: 'acp-agent', model_reasoning_effort: 'medium', service_tier: 'standard' } }

    case 'setDefaultModel':
    case 'config/batchWrite':
    case 'skills/list':
      return { data: [] }

    case 'generate-thread-title': {
      const prompt = typeof record?.prompt === 'string' ? record.prompt : ''
      return { title: prompt.slice(0, 60).trim() || 'New chat' }
    }

    case 'account/rateLimits/read':
      return {
        limitId: null,
        limitName: null,
        primary: null,
        secondary: null,
        credits: { hasCredits: true, unlimited: true, balance: null },
        planType: 'acp',
      }

    default:
      throw new Error(`Unknown RPC method: ${method}`)
  }
}
