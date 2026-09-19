import { describe, expect, test, tier } from 'claude-code/testing'

import { shapeOf, signatureOf } from '../hooks/shape'

tier('user')

describe('shape', () => {
  test('primitives, strings by length, arrays by first item, objects by key', async () => {
    expect(shapeOf(null)).toBe('null')
    expect(shapeOf(3)).toBe('number')
    expect(shapeOf(true)).toBe('boolean')
    expect(shapeOf('hello')).toBe('string(5)')
    expect(shapeOf([])).toEqual([])
    expect(shapeOf([1, 2, 3])).toEqual(['number'])
    expect(shapeOf({ b: 1, a: 'x' })).toEqual({ a: 'string(1)', b: 'number' })
  })

  test('depth caps a deep value without losing its keys', async () => {
    const deep = { a: { b: { c: { d: { e: 1 } } } } }
    expect(shapeOf(deep, 2)).toEqual({ a: { b: 'object{c}' } })
    expect(shapeOf([[1]], 1)).toEqual(['array(1)'])
  })

  test('the signature ignores key order and string length, and carries no values', async () => {
    const one = signatureOf(shapeOf({ content: 'secret text', numLines: 2 }))
    const two = signatureOf(shapeOf({ numLines: 9, content: 'a much longer other text' }))
    expect(one).toBe(two)
    expect(one).toBe('{"content":"string","numLines":"number"}')
    expect(one).not.toContain('secret')
  })
})
