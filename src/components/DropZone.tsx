import { useCallback, useRef, useState } from 'react';

interface Props {
  accept: string;
  multiple?: boolean;
  onFiles: (files: File[]) => void;
  onPick: () => void;
  disabled?: boolean;
}

/** 拖放 + 点击选择。拖放是浏览器 API，两壳共用同一组件。 */
export function DropZone({ accept, multiple = true, onFiles, onPick, disabled }: Props) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    depth.current += 1;
    if (depth.current === 1) setDragging(true);
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    depth.current -= 1;
    if (depth.current <= 0) {
      depth.current = 0;
      setDragging(false);
    }
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files).filter((f) => f.size > 0);
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles],
  );

  return (
    <div
      className={`dropzone ${dragging ? 'dragover' : ''}`}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled}
      onDragEnter={onDragEnter}
      onDragOver={(e) => e.preventDefault()}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      onClick={() => !disabled && onPick()}
      onKeyDown={(e) => {
        if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onPick();
        }
      }}
    >
      <div style={{ fontSize: 15, marginBottom: 6 }}>
        {dragging ? '松开以添加文件' : '拖放文件到这里，或点击选择'}
      </div>
      <div className="hint">支持 {accept} · 文件不会离开本机</div>
      {/*
        这个 input 是「原生文件选择」的兜底通道：
        - 点击区块时优先走 onPick（由 Backend 决定用 input 还是系统对话框）；
        - 但无 onPick 时（或希望完全绕过 Backend 的测试/无障碍场景），
          用户仍可以直接触发这个 input。
        它必须是真正可用的，不能只是装饰 —— 否则键盘用户与自动化测试都走不通。
      */}
      <input
        type="file"
        accept={accept}
        multiple={multiple}
        className="sr-only"
        tabIndex={-1}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          if (files.length > 0) onFiles(files);
          // 允许重复选择同一个文件
          e.target.value = '';
        }}
      />
    </div>
  );
}
