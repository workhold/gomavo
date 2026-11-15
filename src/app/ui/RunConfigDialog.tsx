import { useState } from 'react'
import { Plus, Trash2, X } from 'lucide-react'
import type { RunConfiguration } from '../../lib/preferences'
import { Dropdown } from './Dropdown'
import { iconButton } from '../helpers'
import type { Locale, MessageKey } from '../../lib/i18n'

export interface RunConfigDialogProps {
  t: (key: MessageKey, values?: Record<string, string | number>) => string
  locale: Locale
  configurations: RunConfiguration[]
  activePath: string | null
  onChange: (configurations: RunConfiguration[]) => void
  onClose: () => void
}

function emptyConfiguration(): RunConfiguration {
  return {
    id: `config-${Math.random().toString(36).slice(2, 9)}`,
    name: 'New configuration',
    kind: 'run',
    scope: 'workspace',
    targetPath: null,
    testName: null,
    programArgs: '',
    envVars: '',
    buildTags: '',
    race: false,
  }
}

/** Create, edit, and delete persisted run configurations (GoLand's Edit Configurations). */
export function RunConfigDialog(props: RunConfigDialogProps) {
  const { t, locale, configurations, activePath, onChange, onClose } = props
  const [selectedId, setSelectedId] = useState(configurations[0]?.id ?? null)
  const selected = configurations.find((item) => item.id === selectedId) ?? configurations[0] ?? null
  const update = (patch: Partial<RunConfiguration>) => {
    if (!selected) return
    onChange(configurations.map((item) => item.id === selected.id ? { ...item, ...patch } : item))
  }
  const label = (zh: string, en: string) => locale === 'zh-CN' ? zh : en

  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="create-dialog run-config-dialog" role="dialog" aria-modal="true" aria-label={t('编辑运行配置…')}>
      <div className="dialog-header">
        <div className="dialog-heading">
          <h2>{t('编辑运行配置…')}</h2>
          <p className="dialog-subtitle">{label('保存 go run / go test / go build 的参数、环境变量与构建标签。', 'Persist arguments, environment, and build tags for go run / test / build.')}</p>
        </div>
        {iconButton(t('关闭'), X, onClose)}
      </div>
      <div className="run-config-body">
        <div className="run-config-list">
          {configurations.map((config) => <button
            key={config.id}
            type="button"
            className={config.id === selected?.id ? 'selected' : ''}
            onClick={() => setSelectedId(config.id)}
          ><span>{config.name}</span><small>{config.kind}</small></button>)}
          <div className="run-config-list-actions">
            <button type="button" onClick={() => {
              const next = emptyConfiguration()
              onChange([...configurations, next])
              setSelectedId(next.id)
            }}><Plus size={14} />{t('新建配置')}</button>
          </div>
        </div>
        {selected ? <div className="run-config-form">
          <label>
            <span>{label('名称', 'Name')}</span>
            <input value={selected.name} onChange={(event) => update({ name: event.target.value })} />
          </label>
          <div className="run-config-row">
            <label>
              <span>{label('类型', 'Kind')}</span>
              <Dropdown ariaLabel={label('类型', 'Kind')} value={selected.kind} options={[{ value: 'run', label: 'go run' }, { value: 'test', label: 'go test' }, { value: 'build', label: 'go build' }]} onChange={(kind) => update({ kind })} />
            </label>
            <label>
              <span>{label('作用域', 'Scope')}</span>
              <Dropdown ariaLabel={label('作用域', 'Scope')} value={selected.scope} options={[
                { value: 'workspace', label: label('整个工作区 ./...', 'Workspace ./...') },
                { value: 'package', label: label('包目录', 'Package directory') },
                { value: 'directory', label: label('目录及子目录', 'Directory and children') },
                { value: 'file', label: label('文件', 'File') },
              ]} onChange={(scope) => update({ scope })} />
            </label>
          </div>
          {selected.scope !== 'workspace' && <label>
            <span>{selected.scope === 'file' ? label('文件路径', 'File path') : label('目标目录', 'Target directory')}</span>
            <input
              value={selected.targetPath ?? ''}
              placeholder={selected.scope === 'file' ? 'cmd/app/main.go' : 'cmd/app'}
              onChange={(event) => update({ targetPath: event.target.value || null })}
            />
            {activePath && <small className="run-config-hint" onClick={() => update({ targetPath: activePath })}>
              {label('使用当前文件：', 'Use current file: ')}{activePath}
            </small>}
          </label>}
          {selected.kind === 'test' && <label>
            <span>{label('测试名称（可选）', 'Test name (optional)')}</span>
            <input value={selected.testName ?? ''} placeholder="TestFoo" onChange={(event) => update({ testName: event.target.value || null })} />
          </label>}
          {selected.kind === 'run' && <label>
            <span>{label('程序参数', 'Program arguments')}</span>
            <input value={selected.programArgs} placeholder="-port 8080 --verbose" onChange={(event) => update({ programArgs: event.target.value })} />
          </label>}
          <label>
            <span>{label('环境变量（每行 KEY=VALUE）', 'Environment (KEY=VALUE per line)')}</span>
            <textarea rows={3} value={selected.envVars} placeholder={'PORT=8080\nDEBUG=1'} onChange={(event) => update({ envVars: event.target.value })} />
          </label>
          <label>
            <span>{label('构建标签', 'Build tags')}</span>
            <input value={selected.buildTags} placeholder="integration" onChange={(event) => update({ buildTags: event.target.value })} />
          </label>
          <label className="run-config-check">
            <input type="checkbox" checked={selected.race} onChange={(event) => update({ race: event.target.checked })} />
            <span>{label('启用 -race 竞态检测', 'Enable -race')}</span>
          </label>
          <button type="button" className="danger run-config-delete" onClick={() => {
            const next = configurations.filter((item) => item.id !== selected.id)
            onChange(next)
            setSelectedId(next[0]?.id ?? null)
          }}><Trash2 size={14} />{t('删除配置')}</button>
        </div> : <div className="run-config-empty">{label('还没有保存的运行配置。', 'No saved run configurations yet.')}</div>}
      </div>
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>{t('完成')}</button>
      </div>
    </div>
  </div>
}
