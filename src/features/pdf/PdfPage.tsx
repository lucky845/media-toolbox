import { useCallback, useRef, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LimitNotice } from '../../components/LimitNotice';
import { getDocBackend } from '../../lib/backend/web/docBackend';
import { PdfPreview } from './PdfPreview';
import { formatBytes } from '../../lib/errors';
import type { InputRef, PageRange, ToolError } from '../../lib/backend/types';
interface PdfMeta {
  pages: number;
  bytes: number;
  encrypted: boolean;
  version: string;
}
const probePdfFile = async (f: File) => await getDocBackend().probe({ file: f, name: f.name, size: f.size }) as Promise<PdfMeta>;

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

  const onFiles = useCallback(async (fs: File[]) => {
    const version = ++selectionVersion.current;
    setError(null);
    setMeta(null);
    setResult(null);
    setExtracted(null);
    setOutputStatus('');
    setFiles(fs.map((file) => ({ file, name: file.name, size: file.size })));
    const first = fs[0];
    setProbing(!!first);
    if (!first) return;
    try {
      const nextMeta = await probePdfFile(first);
      if (version === selectionVersion.current) setMeta(nextMeta);
    } catch (e) {
      if (version === selectionVersion.current) setError(e as ToolError);
    } finally {
      if (version === selectionVersion.current) setProbing(false);
    }
  }, []);

  function moveFile(index: number, offset: number) {
    const ordered = files.flatMap((ref) => ref.file ? [ref.file] : []);
    const file = ordered[index];
    const target = ordered[index + offset];
    if (!file || !target) return;
    ordered[index] = target;
    ordered[index + offset] = file;
    void onFiles(ordered);
  }

  const pick = useCallback(async () => {
    const refs = await getDocBackend().pickFiles(ACCEPT, true);
    if (refs.length) await onFiles(refs.map((r) => r.file!).filter(Boolean));
  }, [onFiles]);

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
      const outcome = await getDocBackend().saveOutput(extracted, name);
      if (outcome !== 'cancelled') setOutputStatus(`已导出 ${name}`);
    } catch {
      setError({ code: 'IO', message: '无法导出 TXT，请重试', retryable: true, desktopHint: false });
    }
  }

  const outputFileName = files[0]?.name.replace(/\.pdf$/i, '') || 'document';

  async function run() {
    if (!files[0] || !meta || busy || probing || action === 'render') return;
    setOutputStatus('');
    setBusy(true);
    setError(null);
    setResult(null);
    setExtracted(null);
    const backend = getDocBackend();
    const id = `pdf-${Date.now().toString(36)}`;
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
      const out = await backend.run(task!, {
        taskId: id,
        signal: ac.signal,
        onProgress: () => {},
      });
      if (action === 'extractText') {
        setExtracted(out.bytes);
        setResult(`已提取 ${out.bytes.length} 字节文本`);
      } else {
        await backend.saveOutput(out.bytes, out.outputName);
        setResult(`已生成 ${out.outputName}（${formatBytes(out.bytes.length)}）`);
      }
    } catch (e) {
      setError(e as ToolError);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>导入 PDF</h2>
        <DropZone accept={ACCEPT} onFiles={onFiles} onPick={pick} multiple disabled={busy} />
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
            <button className="primary" onClick={run} disabled={!meta || busy || probing || (action === 'merge' && files.length < 2)}>
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

      {action === 'render' && files[0]?.file && meta && (
        <PdfPreview file={files[0].file} pageCount={meta.pages} onError={setError} />
      )}
      {action === 'render' && !meta && (
        <div className="card"><span className="hint">正在探测 PDF 页数…</span></div>
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

      <LimitNotice kind="fidelity" title="PDF 在线处理说明">
        旋转、拆分、合并与提取在浏览器内以字节级方式完成。PDF→图片渲染已在浏览器内用 pdf.js
        逐页完成（≤100 页、按页虚拟化、受内存上限保护）；更高 DPI 的批量导出请到桌面版。PDF↔Word
        高保真转换需桌面版；在线版只做结构化处理。
      </LimitNotice>
    </div>
  );
}
