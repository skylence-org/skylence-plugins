/**
 * Glob, declared for this mod by declaration merging (see grep.d.ts). The
 * fields are the Glob tool's input schema as Claude Code 2.1.278 offers them
 * to the model.
 */
declare module 'claude-code' {
  interface BuiltinToolInputs {
    Glob: {
      /** The glob pattern to match files against, e.g. "**\/*.js" */
      pattern: string
      /** The directory to search in; defaults to the working directory */
      path?: string
    }
  }
}
