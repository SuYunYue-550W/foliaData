import { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Loader2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { LocalSong } from '../../types';
import {
  collectRenamePreview,
  collectTagWriteBackPreview,
  executeTagWriteBack,
  executeTemplateRename,
  type TagFieldChange,
  type TagWriteBackFileResult,
  type TagWriteBackPreviewItem,
  type RenamePreviewItem,
} from '../../services/localTagWriteBackService';
import { useEscapeClose } from '../../hooks/useEscapeClose';
import { Button, TextField } from '../ui';

// src/components/local-library-entity/TagWriteBackDialog.tsx
// 「写回文件标签 / 按模板重命名文件」的预览确认对话框。
// 只用控件库（Button / TextField），不手写控件（ci/uiPolicy 门禁）。
// 执行前必须先看到「旧值 → 新值」预览；失败逐文件列出。

const DEFAULT_RENAME_TEMPLATE = '{artist} - {title}';

type DialogMode = 'tags' | 'rename';

interface TagWriteBackDialogProps {
  songs: LocalSong[];
  isDaylight: boolean;
  onClose: () => void;
}

const FIELD_I18N_KEYS: Record<TagFieldChange['field'], string> = {
  title: 'localMusic.tagWriteBack.fieldTitle',
  artist: 'localMusic.tagWriteBack.fieldArtist',
  album: 'localMusic.tagWriteBack.fieldAlbum',
  albumArtist: 'localMusic.tagWriteBack.fieldAlbumArtist',
  track: 'localMusic.tagWriteBack.fieldTrack',
  year: 'localMusic.tagWriteBack.fieldYear',
};

export const TagWriteBackDialog = ({ songs, isDaylight, onClose }: TagWriteBackDialogProps) => {
  const { t } = useTranslation();
  const [mode, setMode] = useState<DialogMode>('tags');
  const [template, setTemplate] = useState(DEFAULT_RENAME_TEMPLATE);
  const [preview, setPreview] = useState<TagWriteBackPreviewItem[] | null>(null);
  const [renamePreview, setRenamePreview] = useState<RenamePreviewItem[] | null>(null);
  const [results, setResults] = useState<TagWriteBackFileResult[] | null>(null);
  const [running, setRunning] = useState(false);

  useEscapeClose(onClose);

  const panelTheme = isDaylight
    ? 'bg-white/90 border-white/40 text-zinc-900 shadow-2xl shadow-black/5'
    : 'bg-zinc-950/90 border-white/10 text-white shadow-2xl shadow-black/50';
  const borderTheme = isDaylight ? 'border-zinc-200/60' : 'border-white/10';
  const mutedTheme = isDaylight ? 'text-zinc-500' : 'text-zinc-400';

  // 打开即收集预览：标签预览读旧标签，重命名预览渲染模板。
  useEffect(() => {
    let cancelled = false;
    collectTagWriteBackPreview(songs).then(items => {
      if (!cancelled) setPreview(items);
    }).catch(() => {
      if (!cancelled) setPreview([]);
    });
    return () => { cancelled = true; };
  }, [songs]);

  useEffect(() => {
    if (mode !== 'rename') return;
    let cancelled = false;
    collectRenamePreview(songs, template).then(items => {
      if (!cancelled) setRenamePreview(items);
    }).catch(() => {
      if (!cancelled) setRenamePreview([]);
    });
    return () => { cancelled = true; };
  }, [mode, songs, template]);

  const run = useCallback(async () => {
    setRunning(true);
    setResults(null);
    try {
      if (mode === 'tags' && preview) {
        setResults(await executeTagWriteBack(preview));
      } else if (mode === 'rename' && renamePreview) {
        setResults(await executeTemplateRename(renamePreview));
      }
    } catch (error) {
      console.error('[TagWriteBackDialog] Execution failed:', error);
    } finally {
      setRunning(false);
    }
  }, [mode, preview, renamePreview]);

  const previewLoading = mode === 'tags' ? preview === null : renamePreview === null;
  const changeCount = mode === 'tags'
    ? (preview ?? []).filter(item => !item.error && item.changes.length > 0).length
    : (renamePreview ?? []).filter(item => !item.error && item.newBaseName !== item.fileName.replace(/\.[^.]+$/, '')).length;
  const canRun = !previewLoading && !running && (mode === 'tags' ? changeCount > 0 : template.trim().length > 0);

  return (
    <div
      data-folia-keyboard-window="true"
      className="fixed inset-0 z-[130] flex items-center justify-center bg-black/60 p-3 backdrop-blur-xl md:p-6"
      onMouseDown={event => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('localMusic.tagWriteBack.title')}
        className={`${panelTheme} flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-2xl border backdrop-blur-md`}
      >
        <header className={`flex shrink-0 items-center justify-between gap-4 border-b px-6 py-4 ${borderTheme}`}>
          <h2 className="truncate text-base font-bold">{t('localMusic.tagWriteBack.title')}</h2>
          <Button
            onClick={onClose}
            className={`shrink-0 rounded-full p-2 transition-colors ${isDaylight ? 'hover:bg-zinc-200/50 text-zinc-500' : 'hover:bg-white/10 text-zinc-400'}`}
            aria-label={t('localMusic.cancel')}
          >
            <X size={18} />
          </Button>
        </header>

        <div className={`flex shrink-0 gap-2 border-b px-6 py-3 ${borderTheme}`}>
          <Button
            variant={mode === 'tags' ? 'fill' : 'quiet'}
            size="sm"
            className="rounded-full px-3"
            onClick={() => setMode('tags')}
          >
            {t('localMusic.tagWriteBack.tabTags')}
          </Button>
          <Button
            variant={mode === 'rename' ? 'fill' : 'quiet'}
            size="sm"
            className="rounded-full px-3"
            onClick={() => setMode('rename')}
          >
            {t('localMusic.tagWriteBack.tabRename')}
          </Button>
        </div>

        <main className="min-h-0 flex-1 overflow-y-auto custom-scrollbar px-6 py-4">
          {mode === 'rename' && (
            <div className="mb-4">
              <label className={`mb-1 block text-xs font-semibold ${mutedTheme}`} htmlFor="folia-rename-template">
                {t('localMusic.tagWriteBack.templateLabel')}
              </label>
              <TextField
                id="folia-rename-template"
                value={template}
                onChange={event => setTemplate(event.target.value)}
                className={`w-full rounded-lg border px-3 py-2 text-sm outline-none ${borderTheme} ${isDaylight ? 'bg-white/70' : 'bg-white/5'}`}
              />
              <p className={`mt-1 text-xs ${mutedTheme}`}>{t('localMusic.tagWriteBack.templateHint')}</p>
            </div>
          )}

          {previewLoading && (
            <div className={`flex items-center gap-2 py-6 text-sm ${mutedTheme}`}>
              <Loader2 size={16} className="animate-spin" />
              {t('localMusic.tagWriteBack.loadingPreview')}
            </div>
          )}

          {!previewLoading && mode === 'tags' && (preview ?? []).map(item => (
            <div key={item.songId} className={`mb-3 rounded-xl border px-4 py-3 ${borderTheme}`}>
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                {item.error
                  ? <AlertCircle size={14} className="text-rose-400" />
                  : item.changes.length === 0
                    ? <CheckCircle2 size={14} className="text-emerald-400" />
                    : null}
                <span className="truncate">{item.fileName}</span>
              </div>
              {item.error && (
                <p className="text-xs text-rose-400">
                  {t(`localMusic.tagWriteBack.error.${item.error}`)}
                </p>
              )}
              {!item.error && item.changes.length === 0 && (
                <p className={`text-xs ${mutedTheme}`}>{t('localMusic.tagWriteBack.noChanges')}</p>
              )}
              {item.changes.map(change => (
                <div key={change.field} className="flex gap-2 text-xs">
                  <span className={`shrink-0 ${mutedTheme}`}>{t(FIELD_I18N_KEYS[change.field])}</span>
                  <span className="truncate">
                    {change.from === null ? '—' : change.from}
                    <span className="mx-1">→</span>
                    {change.to}
                  </span>
                </div>
              ))}
            </div>
          ))}

          {!previewLoading && mode === 'rename' && (renamePreview ?? []).map(item => (
            <div key={item.songId} className={`mb-3 rounded-xl border px-4 py-3 ${borderTheme}`}>
              <div className="mb-1 flex items-center gap-2 text-sm font-semibold">
                {item.error ? <AlertCircle size={14} className="text-rose-400" /> : null}
                <span className="truncate">{item.fileName}</span>
              </div>
              {item.error
                ? <p className="text-xs text-rose-400">{t(`localMusic.tagWriteBack.error.${item.error}`)}</p>
                : <p className="truncate text-xs">{item.newBaseName + (item.fileName.match(/\.[^.]+$/)?.[0] || '')}</p>}
            </div>
          ))}

          {results && (
            <div className="mt-4">
              <p className="mb-2 text-sm font-bold">{t('localMusic.tagWriteBack.results')}</p>
              {results.map(result => (
                <div key={result.songId} className="flex items-center gap-2 py-1 text-xs">
                  {result.ok
                    ? <CheckCircle2 size={13} className="shrink-0 text-emerald-400" />
                    : <AlertCircle size={13} className="shrink-0 text-rose-400" />}
                  <span className="truncate">{result.fileName}</span>
                  {!result.ok && result.error && (
                    <span className="truncate text-rose-400">{result.error}</span>
                  )}
                </div>
              ))}
            </div>
          )}
        </main>

        <footer className={`flex shrink-0 items-center justify-end gap-2 border-t px-6 py-4 ${borderTheme}`}>
          <Button variant="quiet" size="md" className="rounded-lg px-3" onClick={onClose}>
            {t('localMusic.cancel')}
          </Button>
          <Button
            variant="primary"
            size="md"
            className="rounded-lg px-4"
            disabled={!canRun}
            onClick={run}
          >
            {running
              ? t('localMusic.tagWriteBack.executing')
              : t('localMusic.tagWriteBack.execute', { count: changeCount })}
          </Button>
        </footer>
      </div>
    </div>
  );
};
