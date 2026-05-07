import { afterEach, describe, expect, it, vi } from 'vitest'
import { getThreadTurnPage, listDirectoryComposioConnectors, startThreadTurn } from './codexGateway'

function mockRpcFetch(): { requests: Array<{ method: string, params: Record<string, unknown> }> } {
  const requests: Array<{ method: string, params: Record<string, unknown> }> = []

  vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    const body = typeof init?.body === 'string'
      ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
      : { method: '', params: {} }

    requests.push(body)

    return new Response(JSON.stringify({
      result: {
        turn: {
          id: `turn-${requests.length}`,
        },
      },
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
      },
    })
  }))

  return { requests }
}

describe('startThreadTurn collaboration mode payloads', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends default collaboration mode explicitly after a plan turn', async () => {
    const { requests } = mockRpcFetch()

    await startThreadTurn('thread-1', 'make a plan', [], 'gpt-5.4', 'medium', undefined, [], 'plan')
    await startThreadTurn('thread-1', 'implement it', [], 'gpt-5.4', 'medium', undefined, [], 'default')

    expect(requests).toHaveLength(2)
    expect(requests[0].method).toBe('turn/start')
    expect(requests[0].params.collaborationMode).toEqual({
      mode: 'plan',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
    expect(requests[1].method).toBe('turn/start')
    expect(requests[1].params.collaborationMode).toEqual({
      mode: 'default',
      settings: {
        model: 'gpt-5.4',
        reasoning_effort: 'medium',
        developer_instructions: null,
      },
    })
  })
})

describe('listDirectoryComposioConnectors', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sends search queries as query params expected by the server', async () => {
    const requests: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input))
      return new Response(JSON.stringify({
        data: [],
        nextCursor: null,
        total: 0,
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    await listDirectoryComposioConnectors('instagram', '50', 25)

    expect(requests).toEqual(['/codex-api/composio/connectors?query=instagram&cursor=50&limit=25'])
  })
})

describe('getThreadTurnPage', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('requests paged thread turns and normalizes messages', async () => {
    const requests: Array<{ method: string, params: Record<string, unknown> }> = []
    vi.stubGlobal('fetch', vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = typeof init?.body === 'string'
        ? JSON.parse(init.body) as { method: string, params: Record<string, unknown> }
        : { method: '', params: {} }
      requests.push(body)

      return new Response(JSON.stringify({
        result: {
          data: [
            {
              id: 'turn-older',
              status: 'completed',
              error: null,
              items: [
                {
                  id: 'msg-older',
                  type: 'agentMessage',
                  text: 'older answer',
                },
              ],
            },
            {
              id: 'turn-newer',
              status: 'inProgress',
              error: null,
              items: [
                {
                  id: 'msg-newer',
                  type: 'agentMessage',
                  text: 'newer answer',
                },
              ],
            },
          ],
          nextCursor: 'turn-before-older',
        },
      }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }))

    const page = await getThreadTurnPage('thread-1', 'cursor-1', 5)

    expect(requests).toEqual([
      {
        method: 'thread/turns/list',
        params: {
          threadId: 'thread-1',
          cursor: 'cursor-1',
          limit: 5,
        },
      },
    ])
    expect(page.nextCursor).toBe('turn-before-older')
    expect(page.inProgress).toBe(true)
    expect(page.activeTurnId).toBe('turn-newer')
    expect(page.turnIndexByTurnId).toEqual({
      'turn-older': 0,
      'turn-newer': 1,
    })
    expect(page.messages.map((message) => ({
      id: message.id,
      text: message.text,
      turnId: message.turnId,
      turnIndex: message.turnIndex,
    }))).toEqual([
      { id: 'msg-older', text: 'older answer', turnId: 'turn-older', turnIndex: 0 },
      { id: 'msg-newer', text: 'newer answer', turnId: 'turn-newer', turnIndex: 1 },
    ])
  })
})
