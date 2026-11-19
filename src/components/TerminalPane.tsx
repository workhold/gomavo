import { memo, useEffect, useRef, useState } from 'react'
import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { command, desktopAvailable, errorMessage } from '../lib/api'
import { translate, type Locale } from '../lib/i18n'
import { localizeError } from '../lib/errorI18n'

type TerminalEvent = { id: string; data: string }
type TerminalExitEvent = { id: string }

type Props = {
  root: string | null
  visible: boolean
  locale: Locale
  fontSize: number
}

interface TerminalSession {
  key: number
  title: string
}

/** The terminal tool window: multiple shell sessions in tabs. */
export const TerminalPane = memo(function TerminalPane({ root, visible, locale, fontSize }: Props) {
  const [sessions, setSessions] = useState<TerminalSession[]>([{ key: 1, title: '1' }])
  const [activeKey, setActiveKey] = useState(1)
  const nextKeyRef = useRef(2)

  const closeSession = (key: number) => {
    setSessions((current) => {
      const next = current.filter((session) => session.key !== key)
      if (!next.length) return [{ key: nextKeyRef.current++, title: String(nextKeyRef.current - 1) }]
      if (activeKey === key) setActiveKey(next[0].key)
      return next
    })
  }

  return <div className="terminal-sessions">
    <div className="terminal-session-tabs" role="tablist" aria-label={translate(locale, '终端会话')}>
      {sessions.map((session, index) => <div
        className={`terminal-session-tab ${session.key === activeKey ? 'selected' : ''}`}
        key={session.key}
        role="tab"
        aria-selected={session.key === activeKey}
      >
        <button type="button" onClick={() => setActiveKey(session.key)}>{translate(locale, '终端')} {index + 1}</button>
        {sessions.length > 1 && <button type="button" className="terminal-session-close" title={translate(locale, '关闭会话')} onClick={() => closeSession(session.key)}>✕</button>}
      </div>)}
      <button type="button" className="terminal-session-new" title={translate(locale, '新建终端会话')} onClick={() => {
        const key = nextKeyRef.current++
        setSessions((current) => [...current, { key, title: String(key) }])
        setActiveKey(key)
      }}>＋</button>
    </div>
    <div className="terminal-session-body">
      {sessions.map((session) => <TerminalSessionView
        key={session.key}
        root={root}
        visible={visible && session.key === activeKey}
        locale={locale}
        fontSize={fontSize}
      />)}
    </div>
  </div>
})

function TerminalSessionView({ root, visible, locale, fontSize }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const idRef = useRef<string | null>(null)
  const startRef = useRef<(() => void) | null>(null)
  const visibleRef = useRef(visible)
  visibleRef.current = visible
  const [error, setError] = useState<string | null>(null)
  const [exited, setExited] = useState(false)
  const [restartKey, setRestartKey] = useState(0)

  useEffect(() => {
    if (!root || !desktopAvailable || !hostRef.current) return

    setError(null)
    setExited(false)

    // Follow the active theme's CSS surface variables.
    const styles = typeof window !== 'undefined' ? getComputedStyle(document.documentElement) : null
    const surface = (name: string, fallback: string): string => styles ? styles.getPropertyValue(name).trim() || fallback : fallback
    const light = document.documentElement.classList.contains('theme-light')
    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
      fontSize,
      lineHeight: 1.35,
      scrollback: 5000,
      theme: light ? {
        background: surface('--surface-panel', '#ffffff'),
        foreground: '#1f2328',
        cursor: '#33363d',
        selectionBackground: '#b4d5fe',
        black: '#3c4048',
        red: '#c0392b',
        green: '#237a2d',
        yellow: '#a06a00',
        blue: '#1a5fb4',
        magenta: '#8e44a5',
        cyan: '#0e7490',
        white: '#57606a',
      } : {
        background: surface('--surface-panel', '#191a1c'),
        foreground: '#d2d3d8',
        cursor: '#c5c8cf',
        selectionBackground: '#354a70',
        black: '#2b2d30',
        red: '#ed8a87',
        green: '#8bd5a4',
        yellow: '#edc783',
        blue: '#8fb7e8',
        magenta: '#c7a0dc',
        cyan: '#87cccb',
        white: '#dce2e9',
      },
    })
    const fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(hostRef.current)
    terminalRef.current = terminal
    fitRef.current = fit
    let sessionId: string | null = null
    let outputUnlisten: UnlistenFn | undefined
    let exitUnlisten: UnlistenFn | undefined
    let cancelled = false
    const earlyOutput: TerminalEvent[] = []
    const earlyExits = new Set<string>()
    const target = getCurrentWebviewWindow().label

    const resize = () => {
      if (cancelled || !sessionId || !hostRef.current || hostRef.current.clientWidth < 40 || hostRef.current.clientHeight < 40) return
      fit.fit()
      void command('terminal_resize', { id: sessionId, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined)
    }

    const inputDisposable = terminal.onData((data) => {
      if (sessionId) {
        void command('terminal_write', { id: sessionId, data }).catch((cause) => {
          if (!cancelled) { setError(errorMessage(cause)); setExited(true) }
        })
      }
    })

    const start = async (cols: number, rows: number) => {
      try {
        const offOutput = await listen<TerminalEvent>('terminal-output', ({ payload }) => {
          if (!sessionId) earlyOutput.push(payload)
          else if (payload.id === sessionId) terminal.write(payload.data)
        }, { target })
        if (cancelled) { offOutput(); return }
        outputUnlisten = offOutput

        const offExit = await listen<TerminalExitEvent>('terminal-exit', ({ payload }) => {
          if (!sessionId) { earlyExits.add(payload.id); return }
          if (payload.id !== sessionId) return
          sessionId = null
          if (idRef.current === payload.id) idRef.current = null
          setExited(true)
        }, { target })
        if (cancelled) { offExit(); return }
        exitUnlisten = offExit

        const id = await command<string>('terminal_start', { root, cols, rows })
        if (cancelled) {
          await command('terminal_close', { id }).catch(() => undefined)
          return
        }
        sessionId = id
        idRef.current = id
        for (const chunk of earlyOutput) if (chunk.id === id) terminal.write(chunk.data)
        earlyOutput.length = 0
        if (earlyExits.has(id)) {
          sessionId = null
          idRef.current = null
          setExited(true)
        } else requestAnimationFrame(resize)
      } catch (cause) {
        if (!cancelled) { setError(errorMessage(cause)); setExited(true) }
      }
    }
    let starting = false
    const maybeStart = () => {
      if (cancelled || starting || sessionId || !visibleRef.current || !hostRef.current || hostRef.current.clientWidth < 40 || hostRef.current.clientHeight < 40) return
      fit.fit()
      if (terminal.cols < 1 || terminal.rows < 1) return
      starting = true
      void start(terminal.cols, terminal.rows)
    }
    startRef.current = maybeStart

    const observer = new ResizeObserver(() => {
      if (sessionId) resize()
      else maybeStart()
    })
    observer.observe(hostRef.current)
    maybeStart()

    return () => {
      cancelled = true
      observer.disconnect()
      inputDisposable.dispose()
      outputUnlisten?.()
      exitUnlisten?.()
      if (sessionId) void command('terminal_close', { id: sessionId }).catch(() => undefined)
      if (idRef.current === sessionId) idRef.current = null
      if (terminalRef.current === terminal) terminalRef.current = null
      if (fitRef.current === fit) fitRef.current = null
      if (startRef.current === maybeStart) startRef.current = null
      terminal.dispose()
    }
  }, [root, restartKey])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.fontSize = fontSize
    if (visible && fitRef.current && idRef.current) {
      fitRef.current.fit()
      void command('terminal_resize', { id: idRef.current, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined)
    } else if (visible) {
      startRef.current?.()
    }
  }, [fontSize, visible])

  useEffect(() => {
    if (visible && fitRef.current) {
      const frame = requestAnimationFrame(() => {
        const terminal = terminalRef.current
        const fit = fitRef.current
        const id = idRef.current
        if (terminal && fit && hostRef.current && hostRef.current.clientWidth >= 40 && hostRef.current.clientHeight >= 40) {
          if (id) {
            fit.fit()
            void command('terminal_resize', { id, cols: terminal.cols, rows: terminal.rows }).catch(() => undefined)
          } else {
            startRef.current?.()
          }
        }
      })
      return () => cancelAnimationFrame(frame)
    }
  }, [visible])

  if (!root) return visible ? <div className="panel-empty">{translate(locale, '打开 Go 项目后可使用集成终端')}</div> : null
  if (!desktopAvailable) return visible ? <div className="panel-empty">{translate(locale, '终端仅在 Tauri 桌面应用中可用')}</div> : null

  return <div className="terminal-wrap" style={visible ? undefined : { display: 'none' }}>
    {(exited || error) && <div className="terminal-error" style={{ display: 'flex', alignItems: 'center', gap: 12, background: error ? undefined : '#292b30', color: error ? undefined : '#bcbec4' }}>
      <span>{error ? localizeError(locale, error) : translate(locale, '终端会话已结束')}</span>
      <button type="button" onClick={() => setRestartKey((key) => key + 1)} style={{ marginLeft: 'auto', border: '1px solid #5a606b', borderRadius: 4, padding: '3px 9px', background: '#383b42', color: '#e1e3e8' }}>{translate(locale, '重新启动终端')}</button>
    </div>}
    <div ref={hostRef} className="terminal-host" />
  </div>
}
