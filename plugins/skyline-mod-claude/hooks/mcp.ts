import type { HttpInit, HttpResponse } from 'claude-code'

/**
 * A minimal MCP streamable-HTTP client for the skyline daemon, over the
 * engine's `$.http.fetch` so the engine owns the socket and an administrator's
 * policy can refuse it. One session per client: `initialize` once, its id on
 * every later call; a daemon restart invalidates the id and the next call
 * re-initialises once. A failed transport marks the daemon down for a few
 * seconds so a batch of Reads does not each wait out a connection timeout.
 *
 * A user-tier hooks module may only spell `$` as `$.noun.event(...)` at a
 * call site (the loader refuses a module that passes `$` around), so the
 * client takes the two calls it needs as closures the hook builds.
 */

export type McpContent = { type: string; text?: string }

export type McpCallResult = { content: McpContent[]; isError: boolean }

/** The engine calls the client makes, as closures over `$`. */
export type Transport = {
  fetch: (url: string, init: HttpInit) => Promise<HttpResponse>
  now: () => Promise<number>
}

/** How long a failed transport keeps the daemon marked down. */
export const DOWN_FOR_MS = 5000

const PROTOCOL_VERSION = '2025-03-26'

const HEADERS: Record<string, string> = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
}

/** The daemon is unreachable, or was within DOWN_FOR_MS. */
export class DaemonDown extends Error {}

/** The daemon no longer knows our session id (it restarted). */
class StaleSession extends Error {}

class TransportError extends Error {}

type JsonRpcMessage = {
  jsonrpc?: string
  id?: number | string
  result?: unknown
  error?: { code?: number; message?: string }
}

/**
 * Every JSON-RPC message in a response body: each non-empty `data:` line of
 * an SSE body, or the whole body when it is plain JSON.
 */
export function parseMessages(text: string): JsonRpcMessage[] {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      return [JSON.parse(trimmed) as JsonRpcMessage]
    } catch {
      return []
    }
  }
  const out: JsonRpcMessage[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('data:')) continue
    const payload = line.slice(5).trim()
    if (!payload) continue
    try {
      out.push(JSON.parse(payload) as JsonRpcMessage)
    } catch {
      // a keep-alive or a partial line; not a message
    }
  }
  return out
}

/** The `mcp-session-id` header, whatever its case. */
export function sessionIdOf(headers: Record<string, string>): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'mcp-session-id' && value) return value
  }
  return undefined
}

export class SkylineClient {
  private session: string | undefined
  private initialising: Promise<void> | undefined
  private downUntil = 0
  private nextId = 1

  constructor(readonly url: string) {}

  /**
   * Calls `tool` on the daemon and resolves its MCP result. Throws DaemonDown
   * when the daemon cannot be reached (or was marked down), any other Error
   * when it answered with a JSON-RPC error or an unreadable body.
   */
  async call(io: Transport, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    const now = await io.now()
    if (now < this.downUntil) throw new DaemonDown('skyline daemon marked down')
    try {
      try {
        return await this.callOnce(io, tool, args)
      } catch (err) {
        if (!(err instanceof StaleSession)) throw err
        this.session = undefined
        return await this.callOnce(io, tool, args)
      }
    } catch (err) {
      if (err instanceof StaleSession || err instanceof TransportError) {
        this.session = undefined
        this.downUntil = now + DOWN_FOR_MS
        throw new DaemonDown(err.message)
      }
      throw err
    }
  }

  private async callOnce(io: Transport, tool: string, args: Record<string, unknown>): Promise<McpCallResult> {
    await this.ensureSession(io)
    const id = this.nextId++
    const response = await this.post(io, {
      jsonrpc: '2.0',
      id,
      method: 'tools/call',
      params: { name: tool, arguments: args },
    })
    const message = parseMessages(response.text).find((m) => m.id === id)
    if (!message) {
      if (/initialize/i.test(response.text)) throw new StaleSession(response.text.trim())
      throw new TransportError(`no JSON-RPC answer for ${tool} (HTTP ${response.status})`)
    }
    if (message.error) throw new Error(`skyline ${tool}: ${message.error.message ?? 'JSON-RPC error'}`)
    const result = message.result as Partial<McpCallResult> | undefined
    return { content: result?.content ?? [], isError: result?.isError === true }
  }

  private ensureSession(io: Transport): Promise<void> {
    if (this.session !== undefined) return Promise.resolve()
    this.initialising ??= this.initialise(io).finally(() => {
      this.initialising = undefined
    })
    return this.initialising
  }

  private async initialise(io: Transport): Promise<void> {
    const id = this.nextId++
    const response = await this.post(io, {
      jsonrpc: '2.0',
      id,
      method: 'initialize',
      params: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'skyline-mod-claude', version: '0.2.0' },
      },
    })
    const answer = parseMessages(response.text).find((m) => m.id === id)
    if (!answer || answer.error) throw new TransportError(`initialize failed (HTTP ${response.status})`)
    this.session = sessionIdOf(response.headers) ?? ''
    await this.post(io, { jsonrpc: '2.0', method: 'notifications/initialized' })
  }

  private async post(io: Transport, body: unknown): Promise<HttpResponse> {
    const headers = { ...HEADERS }
    if (this.session) headers['Mcp-Session-Id'] = this.session
    let response: HttpResponse
    try {
      response = await io.fetch(this.url, { method: 'POST', headers, body: JSON.stringify(body) })
    } catch (err) {
      throw new TransportError(err instanceof Error ? err.message : String(err))
    }
    if (response.status >= 500) throw new TransportError(`HTTP ${response.status}`)
    if (response.status === 404 && this.session) throw new StaleSession('session not found')
    return response
  }
}
