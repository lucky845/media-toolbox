import { useCallback, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LimitNotice } from '../../components/LimitNotice';
import { getBackend } from '../../lib/backend';
import { submitTask } from '../../store/queue';
import { formatBytes } from '../../lib/errors';
import type { InputRef, TaskResult, ToolError } from '../../lib/backend/types';
import { useCapabilities } from '../../store/capabilities';

type Direction = 'docx2pdf' | 'pdf2docx';
type PendingOutput = Pick<TaskResult, 'bytes' | 'outputName'>;

export function DocumentsPage({ direction }: { direction: Direction }) {
  const { caps, summary } = useCapabilities();
  const [file, setFile] = useState<InputRef | null>(null);
  const accept = direction === 'docx2pdf' ? '.docx' : '.pdf';
  const [error, setError] = useState<ToolError | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [pendingOutput, setPendingOutput] = useState<PendingOutput | null>(null);
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

  const adoptFiles = useCallback(([ref]: InputRef[]) => {
    if (!ref) return;
    setFile(ref);
    setPendingOutput(null);
    setError(null);
    setResult(null);
  }, []);

  const pick = useCallback(async () => {
    const backend = await getBackend();
    adoptFiles(await backend.pickFiles(accept, false));
  }, [accept, adoptFiles]);

  // 能力驱动：桌面有 LibreOffice → 走 office.convert（原生高保真）；
  // 在线版无外部进程 → 退回 office.structure（结构化 + 保真度声明）。
  // 组件只问 capabilities，不 if(isTauri)。
  const engine = direction === 'docx2pdf' ? caps?.office.wordToPdf : caps?.office.pdfToWord;
  const isNative = engine === 'native';
  const browserConversion = summary?.showBrowserGuidance && engine === 'structured';
  const conversionAvailable = isNative || browserConversion;

  const save = async (out: PendingOutput) => {
    const outcome = await (await getBackend()).saveOutput(out.bytes, out.outputName);
    const description = `结构化结果已生成（${formatBytes(out.bytes.length)}，${out.outputName}）`;
    if (outcome === 'cancelled') {
      setResult(`已取消保存，文件未保存。${description}。`);
      return;
    }
    setPendingOutput(null);
    setResult(`${description}。${outcome === 'saved' ? '已保存。' : '已发起下载。'}`);
  };

  const retrySave = async () => {
    if (!pendingOutput || busy) return;
    setBusy(true);
    setResult(null);
    setError(null);
    try {
      await save(pendingOutput);
    } catch (e) {
      setError(e as ToolError);
    } finally {
      setBusy(false);
    }
  };

  const run = async () => {
    if (!file || busy || !conversionAvailable) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setPendingOutput(null);
    try {
      const out = await submitTask(
        isNative
          ? { kind: 'office.convert', input: file, direction }
          : { kind: 'office.structure', input: file, direction },
      );
      if (isNative) {
        setResult(`已生成 ${out.outputName}（LibreOffice 原生转换）`);
      } else {
        const { bytes, outputName } = out;
        setPendingOutput({ bytes, outputName });
        await save({ bytes, outputName });
      }
    } catch (e) {
      setError(e as ToolError);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>{direction === 'docx2pdf' ? '导入 Word (.docx)' : '导入 PDF'}</h2>
        <DropZone
          accept={accept}
          multiple={false}
          onFiles={(files) => adoptFiles(files.map((file) => ({ file, name: file.name, size: file.size })))}
          onNativeFiles={caps?.fileSystem.nativeFilePicker ? adoptFiles : undefined}
          onPick={pick}
          disabled={busy}
        />
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

      <div role="status">
        {result && <div className="notice info"><div>{result}</div></div>}
      </div>
      {pendingOutput && !busy && (
        <div className="row">
          <button type="button" className="btn ghost" onClick={() => void retrySave()}>重新保存</button>
        </div>
      )}
      {error && <ErrorBanner error={error} />}

    </div>
  );
}
