/**
 * Skyline's `find` text block, as the daemon renders it:
 *
 *     ¶\\?\C:\repo\sub\a.txt#TAG
 *     ¶\\?\C:\repo\b.txt#0000
 *     20 match(es), 2 shown, 18 elided; pass skip:2 to continue
 *
 * (no matches: `no matches` then `0 match(es), 0 shown`; the footer is
 * present only when something was elided)
 *
 * into the record core produces for a Glob (observed on Claude Code 2.1.278,
 * see README): `{ filenames, numFiles, totalMatches, truncated,
 * countIsComplete, durationMs }`, filenames relative to the working directory
 * in the host's separator, oldest modification first.
 *
 * Pure: no engine, no I/O.
 */

import { relativeOf } from './grep'

export type GlobRecord = {
  filenames: string[]
  numFiles: number
  totalMatches: number
  truncated: boolean
  countIsComplete: boolean
  durationMs: number
}

export type GlobRendering = {
  /** The session's working directory: paths come out relative to it. */
  cwd: string
  /** Whether skyline's rows came newest first (`sort: "mtime"`); core lists oldest first. */
  newestFirst: boolean
  durationMs: number
}

const ANCHOR = /^¶(.+?)(#[A-Za-z0-9]+)?$/
const FOOTER = /^(\d+) match\(es\), (\d+) shown(?:, (\d+) elided.*)?$/
const NO_MATCHES = /^no matches$/
const TRAILER = /^(hint:|resume:|steer:|note:|truncated: true)/i

/** The Windows extended-length prefix skyline's find puts on absolute paths. */
function plain(path: string): string {
  return path.replace(/^(\\\\\?\\|\/\/\?\/)/, '')
}

/**
 * Translates one find block. Returns undefined when a line is not a header,
 * the footer, the no-match lines or a trailer, so the caller can let core's
 * Glob run instead. Directory rows (ending in `/`) are dropped: core's Glob
 * lists files.
 */
export function translateGlob(block: string, r: GlobRendering): GlobRecord | undefined {
  const sep = r.cwd.includes('\\') && !r.cwd.includes('/') ? '\\' : '/'
  const paths: string[] = []
  let total: number | undefined
  let elided = 0
  for (const raw of block.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line === '' || NO_MATCHES.test(line)) continue
    const header = ANCHOR.exec(line)
    if (header) {
      const path = plain(header[1] ?? '')
      if (!path.endsWith('/') && !path.endsWith('\\')) paths.push(relativeOf(path, r.cwd, sep))
      continue
    }
    const footer = FOOTER.exec(line)
    if (footer) {
      total = Number(footer[1])
      elided = Number(footer[3] ?? 0)
      continue
    }
    if (TRAILER.test(line)) break
    return undefined
  }
  const filenames = r.newestFirst ? paths.reverse() : paths
  return {
    filenames,
    numFiles: filenames.length,
    totalMatches: total ?? filenames.length,
    truncated: elided > 0,
    countIsComplete: true,
    durationMs: r.durationMs,
  }
}
