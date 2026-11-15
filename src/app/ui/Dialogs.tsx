import type { FormEvent } from 'react'
import { AlertCircle, Braces, FilePlus2, FolderPlus, Settings2 } from 'lucide-react'
import { displayName, relativePath } from '../../lib/api'
import { GoFileIcon } from '../../components/GoFileIcon'
import { NewProjectDialog } from '../../components/NewProjectDialog'
import type { DialogState, OpenFile } from '../types'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface DialogsProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  root: string | null
  dialog: DialogState | null
  dialogName: string
  setDialogName: (value: string) => void
  dialogError: string | null
  setDialogError: (value: string | null) => void
  dialogBusy: boolean
  closeDialog: () => void
  submitDialog: (event: FormEvent) => Promise<void>
  windowClosePrompt: boolean
  windowCloseBusy: boolean
  dirtyFiles: OpenFile[]
  cancelWindowClose: () => void
  discardAndCloseWindow: () => Promise<void>
  saveAndCloseWindow: () => Promise<void>
  newProjectOpen: boolean
  setNewProjectOpen: (value: boolean) => void
  activateWorkspace: (path: string) => Promise<unknown>
}

export function Dialogs(props: DialogsProps) {
  const {
    t, locale, root, dialog, dialogName, setDialogName, dialogError, setDialogError, dialogBusy, closeDialog, submitDialog,
    windowClosePrompt, windowCloseBusy, dirtyFiles, cancelWindowClose, discardAndCloseWindow, saveAndCloseWindow,
    newProjectOpen, setNewProjectOpen, activateWorkspace,
  } = props
  return <>
    {dialog && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) closeDialog() }}>
      <form className="create-dialog" role="dialog" aria-modal="true" aria-labelledby="entry-dialog-title" aria-describedby="entry-dialog-location" aria-busy={dialogBusy} onSubmit={(event) => void submitDialog(event)} onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled), button:not(:disabled)')]
        if (!controls.length) return
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
      }}>
        <div className="dialog-header">
          <div className="dialog-icon" aria-hidden="true">{dialog.kind === 'folder' ? <FolderPlus size={19} /> : dialog.kind === 'go' ? <GoFileIcon size={19} /> : dialog.kind === 'module' || dialog.kind === 'workspace' ? <Braces size={19} /> : dialog.kind === 'file' ? <FilePlus2 size={19} /> : <Settings2 size={19} />}</div>
          <div className="dialog-heading">
            <h2 id="entry-dialog-title">{dialog.kind === 'go' ? locale === 'zh-CN' ? '新建 Go 文件' : 'New Go File' : dialog.kind === 'module' ? locale === 'zh-CN' ? '新建 Go 模块文件' : 'New Go Module File' : dialog.kind === 'workspace' ? locale === 'zh-CN' ? '新建 Go 工作区文件' : 'New Go Workspace File' : t(dialog.kind === 'file' ? '新建文件' : dialog.kind === 'folder' ? '新建文件夹' : '重命名')}</h2>
            <p className="dialog-subtitle" id="entry-dialog-location" title={dialog.parent}>{t('位置：{path}', { path: root ? relativePath(root, dialog.parent) || displayName(root) : dialog.parent })}</p>
          </div>
        </div>
        <div className="dialog-content">
          <div className="dialog-field">
            <label htmlFor="entry-name">{dialog.kind === 'module' ? locale === 'zh-CN' ? '模块路径' : 'Module path' : t('名称')}</label>
            <input id="entry-name" autoFocus disabled={dialogBusy} readOnly={dialog.kind === 'workspace'} aria-invalid={!!dialogError} aria-describedby={dialogError ? 'entry-dialog-error' : dialog.kind === 'go' || dialog.kind === 'module' || dialog.kind === 'workspace' ? 'entry-dialog-hint' : undefined} value={dialogName} onChange={(event) => { setDialogName(event.target.value); setDialogError(null) }} placeholder={dialog.kind === 'go' ? 'main.go' : dialog.kind === 'file' ? 'filename.ext' : dialog.kind === 'module' ? 'example.com/my-module' : t('名称')} />
            {(dialog.kind === 'go' || dialog.kind === 'module' || dialog.kind === 'workspace') && <p className="dialog-hint" id="entry-dialog-hint">{dialog.kind === 'go' ? locale === 'zh-CN' ? '输入文件名；未输入 .go 时会自动补全，并填入当前目录的 package 声明。' : 'The .go extension and package declaration are added automatically.' : dialog.kind === 'module' ? locale === 'zh-CN' ? '创建 go.mod，模块路径可在文件中继续修改。' : 'Creates go.mod. You can edit the module path later.' : locale === 'zh-CN' ? '在当前目录创建 go.work。' : 'Creates go.work in this directory.'}</p>}
            {dialogError && <p className="dialog-error" id="entry-dialog-error" role="alert">{dialogError}</p>}
          </div>
        </div>
        <div className="dialog-actions"><button type="button" disabled={dialogBusy} onClick={closeDialog}>{t('取消')}</button><button className="primary-button" type="submit" disabled={dialogBusy}>{dialogBusy ? t('处理中…') : t(dialog.kind === 'rename' ? '重命名' : '创建')}</button></div>
      </form>
    </div>}

    {windowClosePrompt && <div className="modal-backdrop window-close-backdrop">
      <div className="create-dialog window-close-dialog" role="dialog" aria-modal="true" aria-labelledby="window-close-title" aria-describedby="window-close-description" aria-busy={windowCloseBusy} onKeyDown={(event) => {
        if (event.key !== 'Tab') return
        const controls = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        if (!controls.length) return
        if (event.shiftKey && document.activeElement === controls[0]) { event.preventDefault(); controls.at(-1)?.focus() }
        else if (!event.shiftKey && document.activeElement === controls.at(-1)) { event.preventDefault(); controls[0].focus() }
      }}>
        <div className="dialog-header">
          <div className="dialog-icon" aria-hidden="true"><AlertCircle size={19} /></div>
          <div className="dialog-heading">
            <h2 id="window-close-title">{t('关闭窗口')}</h2>
            <p className="dialog-subtitle" id="window-close-description">{t('有 {count} 个文件尚未保存。', { count: dirtyFiles.length })}</p>
          </div>
        </div>
        <div className="dialog-content">
          <p className="window-close-files-title">{t('未保存的文件')}</p>
          <ul className="window-close-files">{dirtyFiles.map((file) => <li key={file.path} title={file.path}>{displayName(file.path)}</li>)}</ul>
        </div>
        <div className="dialog-actions">
          <button type="button" autoFocus disabled={windowCloseBusy} onClick={cancelWindowClose}>{t('取消')}</button>
          <button type="button" disabled={windowCloseBusy} onClick={() => void discardAndCloseWindow()}>{t('不保存并关闭')}</button>
          <button className="primary-button" type="button" disabled={windowCloseBusy} onClick={() => void saveAndCloseWindow()}>{windowCloseBusy ? t('处理中…') : t('保存并关闭')}</button>
        </div>
      </div>
    </div>}

    {newProjectOpen && <NewProjectDialog locale={locale} onCancel={() => setNewProjectOpen(false)} onCreated={async (path) => { await activateWorkspace(path); setNewProjectOpen(false) }} />}
  </>
}
