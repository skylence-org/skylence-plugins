/**
 * Skyline's `read` text block, as the daemon renders it:
 *
 *     ¶/abs/path#TAG
 *     1:first line
 *     2:second line
 *     total: 2 lines          (whole reads only)
 *
 * into the record core produces for a Read (observed on Claude Code 2.1.278,
 * see README): `{ filePath, content, numLines, startLine, totalLines }`.
 *
 * Pure: no engine, no I/O.
 */

export type ReadFile = {
  filePath: string
  content: string
  numLines: number
  startLine: number
  totalLines: number
}

export type Translated = {
  file: ReadFile
  /** The `¶path#TAG` header, skyline's anchor for a later `edit`. */
  anchor: string
}

const ANCHOR = /^¶.+#[A-Za-z0-9]+$/
const NUMBERED = /^(\d+):(.*)$/
const TOTAL = /^total: (\d+) lines?$/

/**
 * Translates one read block. Returns undefined when the block is not in the
 * expected form (an outline, a delta, a zip listing, a hint), so the caller
 * can let core's Read run instead of answering with something wrong.
 *
 * `totalLines` comes from the `total:` trailer; a partial read has none, and
 * then it is the last line returned, a lower bound.
 */
export function translateRead(block: string, filePath: string, offset?: number): Translated | undefined {
  const lines = block.split('\n')
  const anchor = lines.shift() ?? ''
  if (!ANCHOR.test(anchor)) return undefined
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()

  let total: number | undefined
  const last = lines[lines.length - 1]
  const trailer = last === undefined ? null : TOTAL.exec(last)
  if (trailer) {
    total = Number(trailer[1])
    lines.pop()
  }

  const content: string[] = []
  let first: number | undefined
  for (const line of lines) {
    const m = NUMBERED.exec(line)
    if (!m) return undefined
    first ??= Number(m[1])
    content.push(m[2] ?? '')
  }

  const startLine = first ?? offset ?? 1
  const numLines = content.length
  const totalLines = total ?? (numLines === 0 ? 0 : startLine + numLines - 1)
  return {
    anchor,
    file: { filePath, content: content.join('\n'), numLines, startLine, totalLines },
  }
}
