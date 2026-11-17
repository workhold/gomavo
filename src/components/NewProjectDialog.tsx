import { useEffect, useRef, useState, type FormEvent } from 'react'
import { FolderOpen, FolderPlus } from 'lucide-react'
import { open } from '@tauri-apps/plugin-dialog'
import { command, errorMessage } from '../lib/api'
import type { Locale } from '../lib/i18n'
import './NewProjectDialog.css'

type Props = {
  locale: Locale
  onCancel: () => void
  onCreated: (path: string) => Promise<void>
}

const safeName = (name: string) => name === name.trim() && !!name && name !== '.' && name !== '..' && !/[\\/:*?"<>|\x00-\x1f\x7f]/.test(name)

export function NewProjectDialog({ locale, onCancel, onCreated }: Props) {
  const zh = locale === 'zh-CN'
  const [name, setName] = useState('')
  const [parent, setParent] = useState(() => localStorage.getItem('gomavo.projectParent') ?? '')
  const [module, setModule] = useState('')
  const [nameTouched, setNameTouched] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const dialogRef = useRef<HTMLFormElement>(null)
  const moduleIssue = module.trim()
    ? /\s|\\/.test(module.trim())
      ? (zh ? '模块路径不能包含空格或反斜杠。' : 'Module path cannot contain spaces or backslashes.')
      : ''
    : /\s/.test(name)
      ? (zh ? '项目名称包含空格，请填写模块路径。' : 'Enter a module path when the project name contains spaces.')
      : ''

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) {
        event.preventDefault()
        onCancel()
      }
      if (event.key !== 'Tab') return
      const focusable = [...(dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])]
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [busy, onCancel])

  const chooseParent = async () => {
    try {
      const picked = await open({ directory: true, multiple: false, title: zh ? '选择项目位置' : 'Choose project location' })
      if (typeof picked === 'string') { setParent(picked); setError('') }
    } catch (cause) { setError(errorMessage(cause)) }
  }

  const create = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    setNameTouched(true)
    if (!safeName(name) || !parent || moduleIssue || busy) return
    setBusy(true)
    setError('')
    try {
      const path = await command<string>('create_go_project', { parent, name, module: module.trim() || null })
      localStorage.setItem('gomavo.projectParent', parent)
      await onCreated(path)
    } catch (cause) { setError(errorMessage(cause)) }
    finally { setBusy(false) }
  }

  return <div className="modal-backdrop new-project-backdrop">
    <form ref={dialogRef} className="create-dialog new-project-dialog" role="dialog" aria-modal="true" aria-labelledby="new-project-heading" aria-describedby="new-project-description" aria-busy={busy} onSubmit={(event) => void create(event)}>
      <div className="dialog-header">
        <div className="dialog-icon" aria-hidden="true"><FolderPlus size={19} /></div>
        <div className="dialog-heading">
          <h2 id="new-project-heading">{zh ? '新建 Go 项目' : 'New Go Project'}</h2>
          <p className="dialog-subtitle" id="new-project-description">{zh ? '创建目录并初始化 Go 模块' : 'Create a folder and initialize a Go module'}</p>
        </div>
      </div>
      <div className="dialog-content">
        <div className="dialog-field">
          <label htmlFor="project-name">{zh ? '项目名称' : 'Project name'}</label>
          <input id="project-name" autoFocus value={name} onChange={(event) => { setName(event.target.value); setError('') }} onBlur={() => setNameTouched(true)} aria-invalid={nameTouched && !safeName(name)} aria-describedby={nameTouched && !safeName(name) ? 'project-name-error' : undefined} placeholder="my-project" />
          {nameTouched && !safeName(name) && <div id="project-name-error" className="project-field-error">{zh ? '请输入不含路径分隔符的目录名称。' : 'Enter one directory name without path separators.'}</div>}
        </div>

        <div className="dialog-field">
          <label htmlFor="project-parent">{zh ? '项目位置' : 'Location'}</label>
          <div className="project-location-row"><input id="project-parent" value={parent} readOnly title={parent} placeholder={zh ? '选择父目录' : 'Choose a parent folder'} aria-required="true" /><button type="button" onClick={() => void chooseParent()} disabled={busy} aria-label={zh ? '浏览项目位置' : 'Browse for project location'}><FolderOpen size={16} aria-hidden="true" /><span>{zh ? '浏览' : 'Browse'}</span></button></div>
        </div>

        <div className="dialog-field">
          <label htmlFor="project-module">{zh ? '模块路径' : 'Module path'} <span className="project-optional">{zh ? '可选' : 'optional'}</span></label>
          <input id="project-module" value={module} onChange={(event) => { setModule(event.target.value); setError('') }} aria-invalid={!!moduleIssue} aria-describedby={moduleIssue ? 'project-module-error' : 'project-module-hint'} placeholder={name.replace(/\s+/g, '-') || 'my-project'} />
          {moduleIssue ? <div id="project-module-error" className="project-field-error">{moduleIssue}</div> : <div id="project-module-hint" className="project-field-hint">{zh ? '留空时使用项目名称。' : 'Leave blank to use the project name.'}</div>}
        </div>

        {error && <div className="project-form-error" role="alert">{error}</div>}
      </div>
      <div className="dialog-actions"><button type="button" onClick={onCancel} disabled={busy}>{zh ? '取消' : 'Cancel'}</button><button className="primary-button" type="submit" disabled={!safeName(name) || !parent || !!moduleIssue || busy}>{busy ? (zh ? '创建中…' : 'Creating…') : (zh ? '创建项目' : 'Create project')}</button></div>
    </form>
  </div>
}
