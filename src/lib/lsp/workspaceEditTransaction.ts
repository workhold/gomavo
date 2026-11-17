export interface WorkspaceFileWrite {
  path: string
  /** Null means this file did not exist when the edit was prepared. */
  before: string | null
  after: string
}

export interface WorkspaceFileIO {
  read(path: string): Promise<string>
  write(path: string, content: string, expectedContent: string): Promise<void>
  create(path: string, content: string): Promise<void>
  remove(path: string): Promise<void>
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

/** Commit checked writes, restoring completed writes if any later step fails. */
export async function commitWorkspaceFileWrites(
  writes: readonly WorkspaceFileWrite[],
  io: WorkspaceFileIO,
  validate: () => void,
  afterWrites: () => void,
): Promise<void> {
  const completed: WorkspaceFileWrite[] = []
  try {
    for (const write of writes) {
      validate()
      try {
        if (write.before === null) await io.create(write.path, write.after)
        else await io.write(write.path, write.after, write.before)
      } catch (cause) {
        throw new Error(`${write.path}: ${message(cause)}`, { cause })
      }
      completed.push(write)
    }
    validate()
    afterWrites()
  } catch (cause) {
    const rollbackErrors: string[] = []
    for (const write of completed.reverse()) {
      try {
        if (write.before === null) {
          // A generated file may have changed since creation. Preserve that
          // newer content instead of deleting it during rollback.
          if (await io.read(write.path) !== write.after) throw new Error('File changed after creation')
          await io.remove(write.path)
        } else {
          await io.write(write.path, write.before, write.after)
        }
      } catch (rollbackCause) {
        rollbackErrors.push(`${write.path}: ${message(rollbackCause)}`)
      }
    }
    if (rollbackErrors.length) {
      throw new Error(`${message(cause)}; rollback failed for ${rollbackErrors.join('; ')}`, { cause })
    }
    throw cause
  }
}
