/**
 * The shape of a value: keys and types, never the values themselves.
 *
 * A primitive is its `typeof` (a string carries its length, `string(12)`), an
 * array is a one-element array holding the shape of its first item (`[]` when
 * empty), an object is a record of its keys' shapes. Past `depth` levels an
 * object collapses to `object{k1,k2}` and an array to `array(n)`, so a deep or
 * cyclic value cannot run away.
 *
 * Pure and import-free: the test calls it directly, and stage 2 can read the
 * signature it produced without loading the engine.
 */
export type Shape = string | Shape[] | { [key: string]: Shape }

const DEFAULT_DEPTH = 4

export function shapeOf(value: unknown, depth: number = DEFAULT_DEPTH): Shape {
  if (value === null) return 'null'
  if (typeof value === 'string') return `string(${value.length})`
  if (typeof value !== 'object') return typeof value
  if (Array.isArray(value)) {
    if (depth <= 0) return `array(${value.length})`
    return value.length === 0 ? [] : [shapeOf(value[0], depth - 1)]
  }
  const keys = Object.keys(value as object).sort()
  if (depth <= 0) return `object{${keys.join(',')}}`
  const out: { [key: string]: Shape } = {}
  for (const key of keys) {
    out[key] = shapeOf((value as { [key: string]: unknown })[key], depth - 1)
  }
  return out
}

/**
 * One line that names a shape, the key two records share when their shapes
 * are the same: `JSON.stringify` over a shape whose object keys are already
 * sorted, so key order in the source value does not split a signature, with
 * string lengths dropped, so two files of different sizes do not either.
 */
export function signatureOf(shape: Shape): string {
  return JSON.stringify(shape).replace(/string\(\d+\)/g, 'string')
}
