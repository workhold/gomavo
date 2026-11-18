import { Component, type ErrorInfo, type ReactNode } from 'react'
import { loadLocale, saveLocale } from '../lib/i18n'

interface Props {
  children: ReactNode
}

interface State {
  error: Error | null
}

/** Keep a render failure from leaving the native window as an empty dark surface. */
export class AppErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('GoMavo interface failed to render', error, info.componentStack)
  }

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    const chinese = loadLocale() === 'zh-CN'
    return <main className="app-error" role="alert">
      <h1>{chinese ? '界面出现问题' : 'Something went wrong'}</h1>
      <p>{chinese ? '可以重新载入窗口，继续使用 GoMavo。' : 'Reload the window to continue using GoMavo.'}</p>
      <div className="app-error-actions">
        <button type="button" onClick={() => window.location.reload()}>{chinese ? '重新载入' : 'Reload window'}</button>
        {chinese && <button type="button" onClick={() => { saveLocale('en-US'); window.location.reload() }}>Switch to English</button>}
      </div>
      <details><summary>{chinese ? '错误详情' : 'Error details'}</summary><pre>{this.state.error.message}</pre></details>
    </main>
  }
}
