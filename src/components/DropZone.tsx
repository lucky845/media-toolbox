import { useEffect, useEffectEvent, useId, useRef, useState, type DragEvent } from 'react';
import { listenNativeFileDrop } from '../lib/backend';
import type { NativeDropPayload, InputRef } from '../lib/backend/types';

interface Props {
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onNativeFiles?: (files: InputRef[]) => void;
  onPick?: () => void;
  disabled?: boolean;
}

function matchesAccept(accept: string, name: string, mime = '') {
  const tokens = accept.toLowerCase().split(',').map((token) => token.trim()).filter(Boolean);
  const lowerName = name.toLowerCase();
  const lowerMime = mime.toLowerCase();
  return tokens.length === 0 || tokens.some((token) => {
    if (token.startsWith('.')) return lowerName.endsWith(token);
    if (token.endsWith('/*')) return lowerMime.startsWith(token.slice(0, -1));
    return lowerMime === token;
  });
}

function isFileDrag(event: DragEvent) {
  return event.dataTransfer.types.includes('Files') || event.dataTransfer.files.length > 0;
}

export function DropZone({ accept, multiple = true, onFiles, onNativeFiles, onPick, disabled }: Props) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);
  const target = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const helpId = useId();
  const formatsId = useId();
  const native = onNativeFiles !== undefined;

  const resetDrag = () => {
    depth.current = 0;
    setDragging(false);
  };

  const onNativeDrag = useEffectEvent((payload: NativeDropPayload) => {
    if (payload.type === 'leave') {
      resetDrag();
      return;
    }
    // Tauri reports physical pixels; DOM hit testing expects CSS pixels.
    if (!payload.position) return;
    const x = payload.position.x / window.devicePixelRatio;
    const y = payload.position.y / window.devicePixelRatio;
    const hit = document.elementFromPoint(x, y);
    const inside = !!hit && !!target.current?.contains(hit);
    if (payload.type !== 'drop') {
      setDragging(inside && !disabled);
      return;
    }
    resetDrag();
    if (!inside || disabled) return;
    const files = (payload.paths ?? []).flatMap((path) => {
      const name = path.split(/[\\/]/).pop() ?? '';
      return name && matchesAccept(accept, name) ? [{ path, name, size: 0 }] : [];
    });
    if (files.length > 0) onNativeFiles?.(multiple ? files : files.slice(0, 1));
  });

  useEffect(() => {
    if (!native) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void (async () => {
      try {
        if (disposed) return;
        const stop = await listenNativeFileDrop((payload) => {
          if (!disposed) onNativeDrag(payload);
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch (error) {
        if (!disposed) console.warn('无法监听系统文件拖放', error);
      }
    })();
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [native]);

  const submitFiles = (files: File[]) => {
    if (disabled || native) return;
    const accepted = files.filter((file) => matchesAccept(accept, file.name, file.type));
    if (accepted.length > 0) onFiles(multiple ? accepted : accepted.slice(0, 1));
  };

  return (
    <div
      ref={target}
      onDragEnter={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        if (!disabled && !native) {
          depth.current += 1;
          setDragging(true);
        }
      }}
      onDragOver={(event) => {
        if (!isFileDrag(event)) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = disabled || native ? 'none' : 'copy';
      }}
      onDragLeave={() => {
        depth.current = Math.max(0, depth.current - 1);
        if (depth.current === 0) setDragging(false);
      }}
      onDrop={(event) => {
        // Consume drops over the target, even when disabled or unsupported, so the page stays open.
        event.preventDefault();
        event.stopPropagation();
        resetDrag();
        const items = Array.from(event.dataTransfer.items).filter((item) => item.kind === 'file');
        const files = items.length > 0
          ? items.flatMap((item) => {
              if (item.webkitGetAsEntry?.()?.isDirectory) return [];
              const file = item.getAsFile();
              return file ? [file] : [];
            })
          : Array.from(event.dataTransfer.files);
        submitFiles(files);
      }}
    >
      <button
        type="button"
        className={`dropzone ${dragging && !disabled ? 'dragover' : ''}`}
        style={{ width: '100%', pointerEvents: disabled ? 'none' : undefined }}
        aria-label="选择文件"
        aria-describedby={`${formatsId} ${helpId}`}
        aria-disabled={disabled}
        disabled={disabled}
        onClick={() => onPick ? onPick() : input.current?.click()}
      >
        <span className="dropzone-mark" aria-hidden="true"><span>+</span></span>
        <span className="dropzone-title">{dragging && !disabled ? '松开以添加文件' : '选择文件'}</span>
        <span id={formatsId} className="dropzone-formats">{accept.replaceAll('.', '').replaceAll(',', ' / ').toUpperCase()}</span>
        <span id={helpId} className="hint">也可以拖放到这里</span>
      </button>
      {!native && <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        hidden
        disabled={disabled}
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []);
          event.currentTarget.value = '';
          submitFiles(files);
        }}
      />}
    </div>
  );
}
