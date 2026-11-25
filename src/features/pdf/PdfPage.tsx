import { useCallback, useState } from 'react';
import { DropZone } from '../../components/DropZone';
import { ErrorBanner } from '../../components/ErrorBanner';
import { LimitNotice } from '../../components/LimitNotice';
import { getDocBackend } from '../../lib/backend/web/docBackend';
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

type PdfAction = 'rotate' | 'split' | 'extractText' | 'extractImages' | 'merge';

export function PdfPage() {
  const [files, setFiles] = useState<InputRef[]>([]);
  const [meta, setMeta] = useState<PdfMeta | null>(null);
  const [action, setAction] = useState<PdfAction>('rotate');
  const [degrees, setDegrees] = useState(90);
  const [rangeText, setRangeText] = useState('1-1');
  const [error, setError] = useState<ToolError | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [extracted, setExtracted] = useState<string | null>(null);

  const onFiles = useCallback(async (fs: File[]) => {
    setError(null);
    setMeta(null);
    setResult(null);
    const refs = fs.map((f) => ({ file: f, name: f.name, size: f.size }));
    setFiles(refs);
    if (refs[0]?.file) {
      try {
        setMeta(await probePdfFile(refs[0].file));
      } catch (e) {
        setError(e as ToolError);
      }
    }
  }, []);

  const pick = useCallback(async () => {
    const refs = await getDocBackend().pickFiles(ACCEPT, true);
    if (refs.length) await onFiles(refs.map((r) => r.file!).filter(Boolean));
  }, [onFiles]);

  const parseRanges = (): PageRange[] => {
    return rangeText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
      .map((s) => {
        const [a, b] = s.split('-').map((x) => parseInt(x.trim(), 10));
        return { from: a!, toInclusive: b ?? a! };
      })
      .filter((r) => Number.isFinite(r.from) && Number.isFinite(r.toInclusive));
  };

  const run = useCallback(async () => {
    if (!files[0]) return;
    setBusy(true);
    setError(null);
    setResult(null);
    setExtracted(null);
    const backend = getDocBackend();
    const id = `pdf-${Date.now().toString(36)}`;
    const ac = new AbortController();
    const selector = { ranges: parseRanges(), oddOnly: false, evenOnly: false };

    let task;
    switch (action) {
      case 'rotate':
        task = { kind: 'pdf.rotate' as const, input: files[0]!, pages: selector, degrees };
        break;
      case 'split':
        task = { kind: 'pdf.split' as const, input: files[0]!, ranges: parseRanges() };
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
        setExtracted(new TextDecoder().decode(out.bytes));
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
  }, [files, action, degrees, rangeText]);

  return (
    <div className="col" style={{ gap: 16 }}>
      <div className="card">
        <h2>导入 PDF</h2>
        <DropZone accept={ACCEPT} onFiles={onFiles} onPick={pick} multiple />
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
            ['extractText', '提取文本'],
            ['extractImages', '提取图片'],
            ['merge', '合并'],
          ] as Array<[PdfAction, string]>).map(([k, label]) => (
            <button key={k} className={action === k ? 'primary' : 'ghost'} onClick={() => setAction(k)}>
              {label}
            </button>
          ))}
        </div>

        {(action === 'rotate' || action === 'extractText' || action === 'extractImages') && (
          <div className="row" style={{ marginTop: 14, gap: 14 }}>
            <label className="row" style={{ gap: 8 }}>
              <span className="hint">页码范围</span>
              <input type="text" value={rangeText} onChange={(e) => setRangeText(e.target.value)} style={{ width: 160 }} />
            </label>
            <span className="hint">如 1-3,5 或 2</span>
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

        {action === 'split' && (
          <div className="row" style={{ marginTop: 10, gap: 8 }}>
            <span className="hint">每段范围（逗号分隔）</span>
            <input type="text" value={rangeText} onChange={(e) => setRangeText(e.target.value)} style={{ width: 220 }} />
          </div>
        )}

        <div className="row" style={{ marginTop: 16 }}>
          <button className="primary" onClick={run} disabled={!files.length || busy}>
            {busy ? '处理中…' : '执行'}
          </button>
        </div>
      </div>

      {result && <div className="notice info"><span>✓</span><div>{result}</div></div>}
      {error && <ErrorBanner error={error} />}
      {extracted && (
        <div className="card">
          <h2>提取的文本</h2>
          <pre style={{ maxHeight: 320, overflow: 'auto' }}>{extracted}</pre>
          <LimitNotice kind="fidelity" title="文本提取说明">
            扫描件（纯图片 PDF）没有文本层，提取结果为空。复杂排版、分栏与表格的文本顺序可能错乱。
          </LimitNotice>
        </div>
      )}

      <LimitNotice kind="fidelity" title="PDF 结构操作">
        旋转、拆分、合并与提取在浏览器内以字节级方式完成。PDF→图片渲染（pdf.js）与 PDF↔Word
        高保真转换需桌面版；在线版只做结构化处理。
      </LimitNotice>
    </div>
  );
}
