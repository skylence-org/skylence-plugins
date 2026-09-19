import { describe, expect, test, tier } from 'claude-code/testing'

import { parseMessages, sessionIdOf } from '../hooks/mcp'

tier('user')

describe('mcp', () => {
  test('SSE bodies: every data line that is a message, keep-alives skipped', async () => {
    const body = 'data: \nid: 0/0\nretry: 3000\n\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\nid: 1/0\n\n'
    expect(parseMessages(body)).toEqual([{ jsonrpc: '2.0', id: 1, result: { ok: true } }])
  })

  test('a plain JSON body is one message; prose is none', async () => {
    expect(parseMessages('{"jsonrpc":"2.0","id":2,"result":{}}')).toEqual([{ jsonrpc: '2.0', id: 2, result: {} }])
    expect(parseMessages('Unexpected message, expect initialize request')).toEqual([])
  })

  test('the session id header is found whatever its case', async () => {
    expect(sessionIdOf({ 'content-type': 'text/event-stream', 'mcp-session-id': 'abc' })).toBe('abc')
    expect(sessionIdOf({ 'Mcp-Session-Id': 'xyz' })).toBe('xyz')
    expect(sessionIdOf({ 'content-type': 'application/json' })).toBeUndefined()
  })
})
