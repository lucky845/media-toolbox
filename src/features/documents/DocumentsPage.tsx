import { useCallback, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LimitNotice } from '../../components/LimitNotice';
import { getBackend } from '../../lib/backend';
import { formatBytes } from '../../lib/errors';
import type { InputRef, ToolError } from '../../lib/backend/types';
import { useCapabilities } from '../../store/capabilities';

type Direction = 'docx2pdf' | 'pdf2docx';

export function DocumentsPage({ direction }: { direction: Direction }) {
  const { caps, summary } = useCapabilities();
  const [file, setFile] = useState<InputRef | null>(null);
  const accept = direction === 'docx2pdf' ? '.docx' : '.pdf';
  const [error, setError] = useState<ToolError | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloadOpenFailed, setDownloadOpenFailed] = useState(false);

  const openLibreOfficeDownload = async () => {
    try {
      const backend = await getBackend();
      if (!backend.openLibreOfficeDownload) {
        setDownloadOpenFailed(true);
        return;
      }
      await backend.openLibreOfficeDownload();
      setDownloadOpenFailed(false);
    } catch {
      setDownloadOpenFailed(true);
    }
  };

  const onFiles = useCallback((fs: File[]) => {
    setError(null);
    setResult(null);
    const f = fs[0];
    if (f) setFile({ file: f, name: f.name, size: f.size });
  }, []);

  const pick = useCallback(async () => {
    const backend = await getBackend();
    const refs = await backend.pickFiles(accept, false);
    if (refs[0]) {
      setFile(refs[0]);
      setError(null);
      setResult(null);
    }
  }, [accept]);

  // 能力驱动：桌面有 LibreOffice → 走 office.convert（原生高保真）；
  // 在线版无外部进程 → 退回 office.structure（结构化 + 保真度声明）。
  // 组件只问 capabilities，不 if(isTauri)。
  const engine = direction === 'docx2pdf' ? caps?.office.wordToPdf : caps?.office.pdfToWord;
  const isNative = engine === 'native';
  const browserConversion = summary?.showBrowserGuidance && engine === 'structured';
  const conversionAvailable = isNative || browserConversion;

  const run = useCallback(async () => {
    if (!file || !conversionAvailable) return;
    setBusy(true);
    setError(null);
    setResult(null);
    const id = `office-${Date.now().toString(36)}`;
    const ac = new AbortController();
    try {
      const backend = await getBackend();
      const out = await backend.run(
        isNative
          ? { kind: 'office.convert', input: file, direction }
          : { kind: 'office.structure', input: file, direction },
        { taskId: id, signal: ac.signal, onProgress: () => {} },
      );
      await backend.saveOutput(out.bytes, out.outputName);
      setResult(
        isNative
          ? `已生成 ${out.outputName}（LibreOffice 原生转换）`
          : `结构化结果已生成（${formatBytes(out.bytes.length)}，${out.outputName}）`,
      );
    } catch (e) {
      setError(e as ToolError);
    } finally {
      setBusy(false);
    }
  }, [file, direction, isNative, conversionAvailable]);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>{direction === 'docx2pdf' ? '导入 Word (.docx)' : '导入 PDF'}</h2>
        <DropZone accept={accept} multiple={false} onFiles={onFiles} onPick={pick} />
        {file && (
          <div className="row" style={{ marginTop: 12 }}>
            <span className="mono">{file.name}</span>
            <span className="hint">{formatBytes(file.size)}</span>
          </div>
        )}
        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={run} disabled={!file || busy || !conversionAvailable}>
            {busy ? '处理中…' : browserConversion ? '开始结构化转换' : '开始转换'}
          </button>
        </div>
      </div>

      {browserConversion && (
        <LimitNotice kind="fidelity" title="在线版只做结构化转换">
          {direction === 'docx2pdf'
            ? '仅转换文本与简单表格。嵌入字体、分栏、页眉页脚、批注与其他复杂排版可能丢失。'
            : '仅还原文本段落与简单表格。原版式、图片位置和字体可能丢失。扫描件需先识别文字。'}
        </LimitNotice>
      )}
      {isNative && (
        <LimitNotice kind="fidelity" title="LibreOffice 原生转换">
          转换在本机完成。字体、复杂排版和扫描页的转换效果取决于源文件。
        </LimitNotice>
      )}
      {summary && !summary.showBrowserGuidance && !isNative && (
        <LimitNotice kind="capability" title="原生文档转换需要 LibreOffice">
          <p>请下载适合你系统的 LibreOffice。安装完成后，退出并重新打开工具箱。</p>
          <button type="button" className="btn ghost" onClick={() => void openLibreOfficeDownload()}>
            打开 LibreOffice 官方下载页
          </button>
          {downloadOpenFailed && (
            <p role="status">无法打开系统浏览器。请手动访问 <code>https://www.libreoffice.org/download/</code>。</p>
          )}
        </LimitNotice>
      )}

      {result && <div className="notice info"><span>✓</span><div>{result}</div></div>}
      {error && <ErrorBanner error={error} />}

    </div>
  );
}
