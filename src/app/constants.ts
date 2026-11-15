import type { MessageKey } from '../lib/i18n'
import type { LocalHistoryKind } from '../lib/localHistory'

export const TASK_LABELS: Record<string, MessageKey> = {
  run: '运行', test: '测试', build: '编译', fmt: '格式化', vet: '静态检查',
  mod_tidy: '整理依赖', mod_download: '下载依赖', install_gopls: '安装 gopls',
}

export const LOCAL_HISTORY_LABELS: Record<LocalHistoryKind, MessageKey> = {
  edit: '编辑', undo: '撤销', redo: '重做', external: '文件更新',
}
