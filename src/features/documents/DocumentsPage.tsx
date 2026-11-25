import { useCallback, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LimitNotice } from '../../components/LimitNotice';
import { getDocBackend } from '../../lib/backend/web/docBackend';
import { formatBytes } from '../../lib/errors';
import type { InputRef, ToolError } from '../../lib/backend/types';
import { useCapabilities } from '../../store/capabilities';

type Direction = 'docx2pdf' | 'pdf2docx';

export function DocumentsPage() {
  const { caps } = useCapabilities();
  const [file, setFile] = useState<InputRef | null>(null);
  const [direction, setDirection] = useState<Direction>('docx2pdf');
  const [error, setError] = useState<ToolError | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onFiles = useCallback((fs: File[]) => {
    setError(null);
    setResult(null);
    const f = fs[0];
    if (f) setFile({ file: f, name: f.name, size: f.size });
  }, []);

  const pick = useCallback(async () => {
    const refs = await getDocBackend().pickFiles('.docx,.pdf', false);
    if (refs[0]) setFile(refs[0]);
  }, []);

  const run = useCallback(async () => {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const id = `office-${Date.now().toString(36)}`;
    const ac = new AbortController();
    try {
      const out = await getDocBackend().run({
        kind: 'office.structure',
        input: file,
        direction,
      }, { taskId: id, signal: ac.signal, onProgress: () => {} });

      // 结构化结果（JSON 段落），前端可进一步用 docx/pdf-lib 生成文件。
      // Phase 4 先提供结构化中间产物与保真度声明。
      await getDocBackend().saveOutput(out.bytes, out.outputName);
      setResult(`结构化结果已生成（${formatBytes(out.bytes.length)}，${out.outputName}）`);
    } catch (e) {
      setError(e as ToolError);
    } finally {
      setBusy(false);
    }
  }, [file, direction]);

  const isNative = caps?.office.wordToPdf === 'native';

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>Word ↔ PDF</h2>
        <div className="row" style={{ gap: 10 }}>
          <button className={direction === 'docx2pdf' ? 'primary' : 'ghost'} onClick={() => setDirection('docx2pdf')}>
            Word (.docx) → PDF
          </button>
          <button className={direction === 'pdf2docx' ? 'primary' : 'ghost'} onClick={() => setDirection('pdf2docx')}>
            PDF → Word (.docx)
          </button>
        </div>
        <div style={{ marginTop: 14 }}>
          <DropZone accept={direction === 'docx2pdf' ? '.docx' : '.pdf'} multiple={false} onFiles={onFiles} onPick={pick} />
        </div>
        {file && (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="mono">{file.name}</span>
            <span className="hint">{formatBytes(file.size)}</span>
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={run} disabled={!file || busy}>
            {busy ? '处理中…' : '开始结构化转换'}
          </button>
        </div>
      </div>

      {/* 保真度声明：常驻、不可折叠（规格 §15 硬要求） */}
      <div className="notice" style={{ borderLeftColor: 'var(--amber)' }}>
        <span aria-hidden="true">⚠️</span>
        <div>
          <strong>在线版只做结构化转换，不承诺高保真</strong>
          <div className="hint" style={{ marginTop: 6 }}>
            {direction === 'docx2pdf'
              ? '浏览器内没有 LibreOffice：只转换文本与简单表格，会丢失嵌入字体、分栏、浮动图形、文本框、页眉页脚、脚注、批注、修订、域、目录、公式与复杂排版。'
              : '只还原文本段落与简单表格：会丢失原版式、图片位置、字体、合并单元格。扫描件需先 OCR（本项目不做 OCR）。'}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>
            当前转换引擎：{isNative ? '桌面版 LibreOffice headless（保真度高，但仍非无损）' : '在线版结构化（保真度有限）'}。
            需要高保真请用桌面版。
          </div>
        </div>
      </div>

      {result && <div className="notice info"><span>✓</span><div>{result}</div></div>}
      {error && <ErrorBanner error={error} />}

      <LimitNotice kind="capability" title="为什么浏览器不能做高保真转换">
        Word/PDF 的高保真转换依赖 LibreOffice 这类原生排版引擎。浏览器沙箱无法启动外部进程。
        桌面版把 LibreOffice 打包进安装包（MPL-2.0），可离线高保真转换；复杂排版仍可能丢失。
      </LimitNotice>
    </div>
  );
}
