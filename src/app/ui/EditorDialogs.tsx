import type { Dispatch, RefObject, SetStateAction } from 'react'
import { displayName } from '../../lib/api'
import type { MessageKey } from '../../lib/i18n'

type BreakpointEdit = { path: string; line: number; condition: string; logMessage: string }

interface EditorDialogsProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  lineJumpOpen: boolean
  lineJumpDraft: string
  lineJumpInputRef: RefObject<HTMLInputElement | null>
  setLineJumpOpen: Dispatch<SetStateAction<boolean>>
  setLineJumpDraft: Dispatch<SetStateAction<string>>
  submitLineJump: () => void
  breakpointEdit: BreakpointEdit | null
  setBreakpointEdit: Dispatch<SetStateAction<BreakpointEdit | null>>
  saveBreakpointEdit: () => void
  toggleBreakpoint: (path: string, line: number) => void
}

/** Small editor overlays that share the same backdrop and dialog controls. */
export function EditorDialogs({
  t, lineJumpOpen, lineJumpDraft, lineJumpInputRef, setLineJumpOpen,
  setLineJumpDraft, submitLineJump, breakpointEdit, setBreakpointEdit,
  saveBreakpointEdit, toggleBreakpoint,
}: EditorDialogsProps) {
  return <>
    {lineJumpOpen && <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setLineJumpOpen(false) }}>
      <form className="line-jump-dialog" role="dialog" aria-modal="true" aria-label={t('跳转到行:列')} onSubmit={(event) => { event.preventDefault(); submitLineJump() }}>
        <label htmlFor="mg-line-jump-input">{t('跳转到行:列')}</label>
        <input
          id="mg-line-jump-input"
          ref={lineJumpInputRef}
          value={lineJumpDraft}
          placeholder="120:8"
          autoComplete="off"
          onChange={(event) => setLineJumpDraft(event.target.value)}
          onKeyDown={(event) => { if (event.key === 'Escape') setLineJumpOpen(false) }}
        />
        <div className="dialog-actions"><button type="button" onClick={() => setLineJumpOpen(false)}>{t('取消')}</button><button type="submit" className="primary">{t('跳转')}</button></div>
      </form>
    </div>}
    {breakpointEdit && <div className="overlay-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setBreakpointEdit(null) }}>
      <form className="line-jump-dialog" role="dialog" aria-modal="true" aria-label={t('编辑断点条件')} onSubmit={(event) => { event.preventDefault(); saveBreakpointEdit() }}>
        <label htmlFor="mg-bp-condition">{t('断点条件')} · {displayName(breakpointEdit.path)}:{breakpointEdit.line}</label>
        <input
          id="mg-bp-condition"
          value={breakpointEdit.condition}
          placeholder={t('表达式为真时中断，如 count > 10')}
          autoComplete="off"
          onChange={(event) => setBreakpointEdit({ ...breakpointEdit, condition: event.target.value })}
        />
        <label htmlFor="mg-bp-log" style={{ marginTop: 10 }}>{t('日志消息（命中时记录而不暂停）')}</label>
        <input
          id="mg-bp-log"
          value={breakpointEdit.logMessage}
          placeholder={t('支持 {expr} 插值，如 count={count}')}
          autoComplete="off"
          onChange={(event) => setBreakpointEdit({ ...breakpointEdit, logMessage: event.target.value })}
        />
        <div className="dialog-actions">
          <button type="button" onClick={() => { toggleBreakpoint(breakpointEdit.path, breakpointEdit.line); setBreakpointEdit(null) }}>{t('移除断点')}</button>
          <button type="button" onClick={() => setBreakpointEdit(null)}>{t('取消')}</button>
          <button type="submit" className="primary">{t('保存断点')}</button>
        </div>
      </form>
    </div>}
  </>
}
