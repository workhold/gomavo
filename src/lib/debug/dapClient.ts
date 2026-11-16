// Debug Adapter Protocol client for the Delve bridge. The Rust side spawns
// `dlv dap` and relays framed JSON; this class handles sequencing, request/
// response matching, and surfaces DAP events for the debugger UI.

import { invoke } from '@tauri-apps/api/core'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'

export interface DapMessage {
  seq?: number
  type: 'request' | 'response' | 'event'
  command?: string
  event?: string
  request_seq?: number
  success?: boolean
  message?: string
  body?: unknown
  arguments?: unknown
}

export interface DapBreakpoint {
  line: number
  verified: boolean
  message?: string
  id?: number
}

export interface DapStackFrame {
  id: number
  name: string
  source?: { path?: string; name?: string }
  line: number
  column: number
}

export interface DapVariable {
  name: string
  value: string
  type?: string
  variablesReference: number
  namedVariables?: number
  indexedVariables?: number
}

export interface DapScope {
  name: string
  variablesReference: number
  expensive: boolean
}

export interface DapThread {
  id: number
  name: string
}

type PendingRequest = {
  resolve: (body: unknown) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export type DapEventHandler = (event: string, body: unknown) => void
export type DapLogHandler = (line: string) => void
export type DapExitHandler = () => void

const REQUEST_TIMEOUT_MS = 15_000

export class DapClient {
  private sessionId: string | null = null
  private nextSeq = 1
  private pending = new Map<number, PendingRequest>()
  private unlisteners: UnlistenFn[] = []
  private stopped = false
  private sendQueue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly onEvent: DapEventHandler,
    private readonly onLog?: DapLogHandler,
    private readonly onExit?: DapExitHandler,
  ) {}

  get active(): boolean {
    return this.sessionId !== null && !this.stopped
  }

  async start(root: string): Promise<void> {
    if (this.sessionId) return
    const target = getCurrentWebviewWindow().label
    const [offEvent, offExit, offLog] = await Promise.all([
      listen<{ id: string; message: DapMessage }>('debug-event', ({ payload }) => {
        if (payload.id === this.sessionId) this.receive(payload.message)
      }, { target }),
      listen<{ id: string }>('debug-exit', ({ payload }) => {
        if (payload.id === this.sessionId) this.handleExit()
      }, { target }),
      listen<{ id: string; line: string }>('debug-log', ({ payload }) => {
        if (payload.id === this.sessionId) this.onLog?.(payload.line)
      }, { target }),
    ])
    this.unlisteners.push(offEvent, offExit, offLog)
    try {
      this.sessionId = await invoke<string>('debug_start', { root })
    } catch (cause) {
      this.dispose()
      throw cause
    }
  }

  private handleExit(): void {
    if (this.stopped) return
    this.stopped = true
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error('Delve session ended'))
    }
    this.pending.clear()
    this.onExit?.()
  }

  private receive(message: DapMessage): void {
    if (message.type === 'response' && message.request_seq !== undefined) {
      const pending = this.pending.get(message.request_seq)
      if (pending) {
        this.pending.delete(message.request_seq)
        window.clearTimeout(pending.timer)
        if (message.success === false) {
          pending.reject(new Error(message.message || `Delve request failed: ${message.command}`))
        } else {
          pending.resolve(message.body)
        }
      }
      return
    }
    if (message.type === 'event' && message.event) {
      this.onEvent(message.event, message.body)
    }
  }

  /** Send a DAP request and await its response body. */
  request<T = unknown>(command: string, args?: unknown): Promise<T> {
    const session = this.sessionId
    if (!session || this.stopped) return Promise.reject(new Error('Delve session is not running'))
    const seq = this.nextSeq
    this.nextSeq += 1
    const task = this.sendQueue.then(async () => {
      // Register the pending entry before the bytes go out: dlv answers fast
      // requests like setBreakpoints in under a millisecond, so the relayed
      // response can beat `invoke`'s resolution back to the webview and would
      // otherwise be dropped as unmatched.
      const promise = new Promise<T>((resolve, reject) => {
        const timer = window.setTimeout(() => {
          this.pending.delete(seq)
          reject(new Error(`Delve request timed out: ${command}`))
        }, REQUEST_TIMEOUT_MS)
        this.pending.set(seq, {
          resolve: (body) => resolve(body as T),
          reject,
          timer,
        })
      })
      try {
        await invoke('debug_send', {
          id: session,
          message: { seq, type: 'request', command, arguments: args ?? {} },
        })
      } catch (cause) {
        const pending = this.pending.get(seq)
        if (pending) {
          this.pending.delete(seq)
          window.clearTimeout(pending.timer)
          pending.reject(cause instanceof Error ? cause : new Error(String(cause)))
        }
        throw cause
      }
      return promise
    })
    this.sendQueue = task.then(() => undefined, () => undefined)
    return task
  }

  async stop(): Promise<void> {
    if (!this.sessionId) return
    const session = this.sessionId
    this.stopped = true
    for (const pending of this.pending.values()) {
      window.clearTimeout(pending.timer)
      pending.reject(new Error('Delve session stopped'))
    }
    this.pending.clear()
    try { await invoke('debug_stop', { id: session }) } catch { /* already gone */ }
    this.dispose()
  }

  dispose(): void {
    for (const stop of this.unlisteners.splice(0)) stop()
    this.sessionId = null
  }
}
