import { useCallback, useEffect, useRef, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LimitNotice } from '../../components/LimitNotice';
import { getBackend } from '../../lib/backend';
import { useCapabilities } from '../../store/capabilities';
import { PdfPreview } from './PdfPreview';
import { formatBytes, isToolError } from '../../lib/errors';
import type { InputRef, PageRange, PdfMeta, ToolError } from '../../lib/backend/types';

function pdfError(error: unknown): ToolError {
  if (isToolError(error)) return error;
  return { code: 'IO', message: error instanceof Error ? error.message : String(error), retryable: true, desktopHint: false };
}

const ACCEPT = '.pdf';

type PdfAction = 'rotate' | 'split' | 'extractPages' | 'extractText' | 'extractImages' | 'merge' | 'render';

export function PdfPage() {
  const [files, setFiles] = useState<InputRef[]>([]);
  const [meta, setMeta] = useState<PdfMeta | null>(null);
  const [action, setAction] = useState<PdfAction>('rotate');
  const [degrees, setDegrees] = useState(90);
  const [rangeText, setRangeText] = useState('');
  const [error, setError] = useState<ToolError | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [extracted, setExtracted] = useState<Uint8Array | null>(null);
  const extractedText = extracted ? new TextDecoder().decode(extracted) : '';
  const [outputStatus, setOutputStatus] = useState('');
  const [probing, setProbing] = useState(false);
  const selectionVersion = useRef(0);
  const nativePicker = useCapabilities((state) => state.caps?.fileSystem.nativeFilePicker);

  const onFiles = useCallback(async (refs: InputRef[]) => {
    const version = ++selectionVersion.current;
    setError(null);
    setMeta(null);
    setResult(null);
    setExtracted(null);
    setOutputStatus('');
    setFiles(refs);
    const first = refs[0];
    setProbing(!!first);
    if (!first) return;
    try {
      const backend = await getBackend();
      if (!backend.probePdf) throw new Error('当前后端不支持 PDF 探测');
      const nextMeta = await backend.probePdf(first);
      if (version === selectionVersion.current) setMeta(nextMeta);
    } catch (e) {
      if (version === selectionVersion.current) setError(pdfError(e));
    } finally {
      if (version === selectionVersion.current) setProbing(false);
    }
  }, []);

  function moveFile(index: number, offset: number) {
    const ordered = [...files];
    const file = ordered[index];
    const target = ordered[index + offset];
    if (!file || !target) return;
    ordered[index] = target;
    ordered[index + offset] = file;
    void onFiles(ordered);
  }

  const pick = useCallback(async () => {
    try {
      const refs = await (await getBackend()).pickFiles(ACCEPT, true);
      if (refs.length) await onFiles(refs);
    } catch (e) {
      setError(pdfError(e));
    }
  }, [onFiles]);

  const first = files[0];
  const [localPreview, setLocalPreview] = useState<{ input: InputRef; file: File }>();
  useEffect(() => {
    if (action !== 'render' || !first?.path || !meta || meta.encrypted) return;
    let current = true;
    setLocalPreview(undefined);
    void (async () => {
      try {
        const backend = await getBackend();
        if (!backend.readPdf) throw new Error('当前后端不支持 PDF 预览');
        const bytes = await backend.readPdf(first);
        if (current) setLocalPreview({ input: first, file: new File([bytes], first.name, { type: 'application/pdf' }) });
      } catch (e) {
        if (current) setError(pdfError(e));
      }
    })();
    return () => { current = false; };
  }, [action, first, meta]);
  const previewFile = first?.file ?? (localPreview?.input === first ? localPreview?.file : undefined);

  const parseRanges = (): PageRange[] | null => {
    if (!rangeText.trim()) return action === 'split' ? null : [];
    const ranges: PageRange[] = [];
    for (const segment of rangeText.split(',')) {
      const match = /^(\d+)(?:\s*-\s*(\d+))?$/.exec(segment.trim());
      if (!match) return null;
      const from = Number(match[1]);
      const toInclusive = Number(match[2] ?? match[1]);
      if (from < 1 || toInclusive < from || toInclusive > (meta?.pages ?? 0)) return null;
      ranges.push({ from, toInclusive });
    }
    return ranges;
  };

  async function downloadText() {
    if (!extracted?.length) return;
    setOutputStatus('');
    setError(null);
    try {
      const name = `${outputFileName}.txt`;
      const outcome = await (await getBackend()).saveOutput(extracted, name, { directDownload: true });
      if (outcome !== 'cancelled') setOutputStatus(`已导出 ${name}`);
    } catch {
      setError({ code: 'IO', message: '无法导出 TXT，请重试', retryable: true, desktopHint: false });
    }
  }

  const outputFileName = files[0]?.name.replace(/\.pdf$/i, '') || 'document';

  async function run() {
    if (!files[0] || !meta || meta.encrypted || busy || probing || action === 'render') return;
    setOutputStatus('');
    setBusy(true);
    setError(null);
    setResult(null);
    setExtracted(null);
    const id = `pdf-${crypto.randomUUID()}`;
    const ac = new AbortController();
    const ranges = action === 'merge' ? [] : parseRanges();
    if (!ranges) {
      setError({ code: 'INVALID_PARAMS', message: '页码范围无效，请使用如 1-3,5 的格式，并且不能超过 PDF 页数', retryable: false, desktopHint: false });
      setBusy(false);
      return;
    }
    const selector = { ranges, oddOnly: false, evenOnly: false };

    let task;
    switch (action) {
      case 'rotate':
        task = { kind: 'pdf.rotate' as const, input: files[0]!, pages: selector, degrees };
        break;
      case 'split':
        task = { kind: 'pdf.split' as const, input: files[0]!, ranges };
        break;
      case 'extractPages':
        task = { kind: 'pdf.extract' as const, input: files[0]!, pages: selector, what: 'pages' as const };
        break;
      case 'extractText':
        task = { kind: 'pdf.extract' as const, input: files[0]!, pages: selector, what: 'text' as const };
        break;
      case 'extractImages':
        task = { kind: 'pdf.extract' as const, input: files[0]!, pages: selector, what: 'images' as const };
        break;
      case 'merge':
        if (files.length < 2) {
          setError({ code: 'INVALID_PARAMS', message: '合并至少需要 2 个 PDF', retryable: false, desktopHint: false });
          setBusy(false);
          return;
        }
        task = { kind: 'pdf.merge' as const, inputs: files };
        break;
    }

    try {
      const backend = await getBackend();
      const out = await backend.run(task!, {
        taskId: id,
        signal: ac.signal,
        onProgress: () => {},
      });
      if (action === 'extractText') {
        const textBytes = out.text ? new TextEncoder().encode(out.text) : out.bytes;
        setExtracted(textBytes);
        setResult(`已提取 ${textBytes.length} 字节文本`);
      } else if (out.savedOutputs) {
        const [firstOutput] = out.savedOutputs;
        setResult(firstOutput
          ? `已生成 ${firstOutput.path}${out.savedOutputs.length > 1 ? `（共 ${out.savedOutputs.length} 个文件）` : ''}`
          : '选定页面没有可提取的嵌入图片');
      } else {
        const outputs = out.outputs ?? [{ bytes: out.bytes, name: out.outputName }];
        if (outputs.length === 0) {
          setResult('选定页面没有可提取的嵌入图片');
          return;
        }
        let saved = 0;
        for (const item of outputs) {
          if (await backend.saveOutput(item.bytes, item.name, { directDownload: true }) !== 'cancelled') saved++;
        }
        if (outputs.length === 1 && saved) setResult(`已生成 ${out.outputName}（${formatBytes(out.bytes.length)}）`);
        else if (saved) setResult(`已导出 ${saved} / ${outputs.length} 个文件`);
      }
    } catch (e) {
      setError(pdfError(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>导入 PDF</h2>
        {nativePicker ? (
          <button type="button" onClick={() => void pick()} disabled={busy}>选择 PDF 文件</button>
        ) : (
          <DropZone accept={ACCEPT} onFiles={(items) => void onFiles(items.map((file) => ({ file, name: file.name, size: file.size })))}
            onPick={pick} multiple disabled={busy} />
        )}
        {action === 'merge' && files.length > 1 && (
          <ol aria-label="PDF 合并顺序" style={{ margin: '12px 0 0', paddingLeft: 22 }}>
            {files.map((file, index) => (
              <li key={index}>
                <span className="mono">{file.name}</span>{' '}
                <button type="button" className="ghost" onClick={() => moveFile(index, -1)}
                  disabled={busy || index === 0} aria-label={`上移第 ${index + 1} 个文件 ${file.name}`}>上移</button>{' '}
                <button type="button" className="ghost" onClick={() => moveFile(index, 1)}
                  disabled={busy || index === files.length - 1} aria-label={`下移第 ${index + 1} 个文件 ${file.name}`}>下移</button>
              </li>
            ))}
          </ol>
        )}
        {probing && <p className="hint" role="status">正在读取 PDF 信息…</p>}
        {meta && (
          <dl className="kv" style={{ marginTop: 12 }}>
            <dt>页数</dt><dd className="mono">{meta.pages}</dd>
            <dt>大小</dt><dd className="mono">{formatBytes(meta.bytes)}</dd>
            <dt>加密</dt><dd>{meta.encrypted ? '是（暂不支持处理）' : '否'}</dd>
            <dt>版本</dt><dd className="mono">{meta.version}</dd>
          </dl>
        )}
      </div>

      <div className="card">
        <h2>操作</h2>
        <div className="row" style={{ gap: 10 }}>
          {([
            ['rotate', '旋转'],
            ['split', '拆分'],
            ['extractPages', '提取页面'],
            ['extractText', '提取文本'],
            ['extractImages', '提取图片'],
            ['merge', '合并'],
            ['render', '渲染图片'],
          ] as Array<[PdfAction, string]>).map(([k, label]) => (
            <button key={k} type="button" className={action === k ? 'primary' : 'ghost'}
              disabled={busy} aria-pressed={action === k} onClick={() => {
                setAction(k);
                setResult(null);
                setExtracted(null);
                setOutputStatus('');
                if (meta) setError(null);
              }}>
              {label}
            </button>
          ))}
        </div>

        {action !== 'merge' && action !== 'render' && (
          <div className="row" style={{ marginTop: 14, gap: 14 }}>
            <label className="row" style={{ gap: 8 }}>
              <span className="hint">页码范围</span>
              <input type="text" value={rangeText} disabled={busy} aria-describedby="pdf-range-help"
                onChange={(e) => setRangeText(e.target.value)} style={{ width: 160 }} />
            </label>
            <span className="hint" id="pdf-range-help">
              如 1-3,5 或 2{action !== 'split' && '，留空处理全部页面'}
            </span>
          </div>
        )}

        {action === 'rotate' && (
          <label className="row" style={{ marginTop: 10, gap: 8 }}>
            <span className="hint">角度</span>
            <select value={degrees} onChange={(e) => setDegrees(Number(e.target.value))}>
              <option value={90}>顺时针 90°</option>
              <option value={180}>180°</option>
              <option value={270}>逆时针 90°</option>
            </select>
          </label>
        )}

        {action !== 'render' && (
          <div className="row" style={{ marginTop: 16 }}>
            <button className="primary" onClick={run} disabled={!meta || meta.encrypted || busy || probing || (action === 'merge' && files.length < 2)}>
              {busy ? '处理中…' : '执行'}
            </button>
          </div>
        )}
        {action === 'render' && (
          <div className="notice info" style={{ marginTop: 14 }}>
            <span>↓</span><div>渲染在下方「页面预览与图片导出」区完成：支持按需预览、DPI/格式选择、页码范围与长图拼接。</div>
          </div>
        )}
      </div>

      {action === 'render' && previewFile && meta && !meta.encrypted && (
        <PdfPreview file={previewFile} pageCount={meta.pages} onError={setError} />
      )}
      {action === 'render' && !previewFile && !error && !meta?.encrypted && (
        <div className="card"><span className="hint">{first ? '正在读取 PDF…' : '请选择 PDF 文件'}</span></div>
      )}

      <div role="status" hidden={!outputStatus && !result}>
        {(outputStatus || result) && <div className="notice info">{outputStatus || result}</div>}
      </div>
      {error && <ErrorBanner error={error} />}
      {extracted && (
        <div className="card">
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
            <h2 style={{ margin: 0 }}>提取的文本</h2>
            <button
              className="ghost"
              type="button"
              onClick={() => void downloadText()}
              disabled={extracted.length === 0}
            >
              下载 TXT
            </button>
          </div>
          {extracted.length > 0 && (
            <pre style={{ maxHeight: 320, overflow: 'auto' }} tabIndex={0} aria-label="PDF 提取文本">
              {extractedText}
            </pre>
          )}
          <LimitNotice kind="fidelity" title="文本提取说明">
            扫描件（纯图片 PDF）没有文本层，提取结果为空。复杂排版、分栏与表格的文本顺序可能错乱。
          </LimitNotice>
        </div>
      )}

      <LimitNotice kind="fidelity" title="PDF 处理说明">
        旋转、拆分、合并、提取和图片导出均在本机完成。
        {nativePicker && ' 编辑后的 PDF 保存到列表首份文件所在目录。'}
      </LimitNotice>
    </div>
  );
}
