//! Desktop PDF structure operations backed by the shared Rust core.

use crate::commands::probe::desktop_limits;
use media_core::pdf::{self, PageRange, PageSelector, PdfMeta};
use media_native::cancel::{TaskCancel, TaskGuard};
use media_native::{read_limited, unique_path, write_atomic};
use media_ports::{Limits, ToolError};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Deserialize)]
#[serde(tag = "kind", rename_all_fields = "camelCase")]
pub enum PdfRequest {
    #[serde(rename = "pdf.merge")]
    Merge {
        input_paths: Vec<String>,
        task_id: String,
    },
    #[serde(rename = "pdf.split")]
    Split {
        input_path: String,
        ranges: Vec<PageRange>,
        task_id: String,
    },
    #[serde(rename = "pdf.rotate")]
    Rotate {
        input_path: String,
        pages: PageSelector,
        degrees: i32,
        task_id: String,
    },
    #[serde(rename = "pdf.extract")]
    Extract {
        input_path: String,
        pages: PageSelector,
        what: ExtractKind,
        task_id: String,
    },
}

impl PdfRequest {
    fn task_id(&self) -> &str {
        match self {
            Self::Merge { task_id, .. }
            | Self::Split { task_id, .. }
            | Self::Rotate { task_id, .. }
            | Self::Extract { task_id, .. } => task_id,
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExtractKind {
    Text,
    Images,
    Pages,
}

#[derive(Debug, Serialize)]
pub struct PdfOutput {
    name: String,
    path: PathBuf,
    bytes: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfResult {
    output_name: String,
    outputs: Vec<PdfOutput>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[tauri::command]
pub async fn pdf_probe(input_path: String) -> Result<PdfMeta, ToolError> {
    tokio::task::spawn_blocking(move || {
        let input = read_limited(input_path, desktop_limits().max_bytes)?;
        pdf::probe_pdf(&input)
    })
    .await
    .map_err(|e| ToolError::internal(format!("PDF probe task failed: {e}")))?
}

/// Bound the in-memory payload sent to the WebView for PDF.js preview.
#[tauri::command]
pub async fn pdf_read_preview(input_path: String) -> Result<tauri::ipc::Response, ToolError> {
    const MAX_PREVIEW_BYTES: u64 = 64 * 1024 * 1024;
    tokio::task::spawn_blocking(move || {
        read_limited(input_path, MAX_PREVIEW_BYTES).map(tauri::ipc::Response::new)
    })
    .await
    .map_err(|e| ToolError::internal(format!("PDF preview task failed: {e}")))?
}

#[tauri::command]
pub async fn pdf_run(request: PdfRequest) -> Result<PdfResult, ToolError> {
    let guard = TaskGuard::new(request.task_id());
    tokio::task::spawn_blocking(move || run_pdf(request, &desktop_limits(), guard.token()))
        .await
        .map_err(|e| ToolError::internal(format!("PDF operation task failed: {e}")))?
}

fn check_cancel(token: &TaskCancel) -> Result<(), ToolError> {
    if token.is_cancelled() {
        Err(ToolError::cancelled())
    } else {
        Ok(())
    }
}

fn save_outputs(
    input: &Path,
    fallback_name: &str,
    artifacts: Vec<(String, Vec<u8>)>,
    token: &TaskCancel,
) -> Result<PdfResult, ToolError> {
    // Serialize filename selection and writes among PDF operations in this process.
    static PDF_OUTPUT_LOCK: Mutex<()> = Mutex::new(());
    let _lock = PDF_OUTPUT_LOCK
        .lock()
        .map_err(|_| ToolError::internal("PDF output lock poisoned"))?;
    check_cancel(token)?;
    let dir = input.parent().unwrap_or_else(|| Path::new("."));
    let mut outputs: Vec<PdfOutput> = Vec::with_capacity(artifacts.len());
    for (name, data) in artifacts {
        let path = unique_path(dir.join(name));
        let name = path
            .file_name()
            .unwrap_or_default()
            .to_string_lossy()
            .into_owned();
        if let Err(err) = write_atomic(&path, &data) {
            for output in &outputs {
                let _ = std::fs::remove_file(&output.path);
            }
            return Err(err);
        }
        outputs.push(PdfOutput {
            name,
            path,
            bytes: data.len() as u64,
        });
    }
    Ok(PdfResult {
        output_name: outputs
            .first()
            .map_or_else(|| fallback_name.into(), |out| out.name.clone()),
        outputs,
        text: None,
    })
}

fn run_pdf(
    request: PdfRequest,
    limits: &Limits,
    token: &TaskCancel,
) -> Result<PdfResult, ToolError> {
    let read = |path: &str, max_bytes| {
        check_cancel(token)?;
        let bytes = read_limited(path, max_bytes)?;
        check_cancel(token)?;
        Ok::<_, ToolError>(bytes)
    };
    let (path, name, artifacts) = match request {
        PdfRequest::Merge { input_paths, .. } => {
            pdf::ops::check_merge_count(input_paths.len(), limits)?;
            let mut remaining = limits.max_bytes;
            let mut inputs = Vec::with_capacity(input_paths.len());
            for path in &input_paths {
                let bytes = read(path, remaining)?;
                remaining = remaining.saturating_sub(bytes.len() as u64);
                inputs.push(bytes);
            }
            let bytes = pdf::pdf_merge(&inputs, limits)?;
            (
                input_paths.into_iter().next().unwrap(),
                "merged.pdf",
                vec![("merged.pdf".into(), bytes)],
            )
        }
        PdfRequest::Split {
            input_path, ranges, ..
        } => {
            if ranges.is_empty() {
                return Err(ToolError::invalid("请指定拆分页码范围"));
            }
            let bytes = read(&input_path, limits.max_bytes)?;
            let outputs = pdf::pdf_split(&bytes, &ranges, limits)?
                .into_iter()
                .map(|(name, bytes)| (format!("{name}.pdf"), bytes))
                .collect();
            (input_path, "part-1.pdf", outputs)
        }
        PdfRequest::Rotate {
            input_path,
            pages,
            degrees,
            ..
        } => {
            let bytes = read(&input_path, limits.max_bytes)?;
            let out = pdf::pdf_rotate(&bytes, &pages, degrees, limits)?;
            (input_path, "rotated.pdf", vec![("rotated.pdf".into(), out)])
        }
        PdfRequest::Extract {
            input_path,
            pages,
            what,
            ..
        } => {
            let bytes = read(&input_path, limits.max_bytes)?;
            match what {
                ExtractKind::Text => {
                    let text = pdf::pdf_extract_text(&bytes, &pages, limits)?;
                    check_cancel(token)?;
                    return Ok(PdfResult {
                        output_name: "extracted.txt".into(),
                        outputs: Vec::new(),
                        text: Some(text),
                    });
                }
                ExtractKind::Pages => {
                    let out = pdf::pdf_extract_pages(&bytes, &pages, limits)?;
                    (
                        input_path,
                        "extracted.pdf",
                        vec![("extracted.pdf".into(), out)],
                    )
                }
                ExtractKind::Images => {
                    // Core returns raw image streams; extension does not promise a standalone image.
                    let outputs = pdf::pdf_extract_images(&bytes, &pages, limits)?
                        .into_iter()
                        .enumerate()
                        .map(|(i, (_, bytes))| (format!("image-{}.bin", i + 1), bytes))
                        .collect();
                    (input_path, "image-1.bin", outputs)
                }
            }
        }
    };
    save_outputs(Path::new(&path), name, artifacts, token)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct TestDir(PathBuf);

    impl TestDir {
        fn new() -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let name = format!(
                "media-pdf-test-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            );
            let path = std::env::temp_dir().join(name);
            std::fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn fixture(&self) -> PathBuf {
            let path = self.0.join("源文件.pdf");
            std::fs::write(&path, include_bytes!("../../../tests/fixtures/sample.pdf")).unwrap();
            path
        }
    }

    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    async fn invoke(request: Value) -> Result<PdfResult, ToolError> {
        pdf_run(serde_json::from_value(request).unwrap()).await
    }

    #[tokio::test]
    async fn probe_and_extract_pages_use_camel_case_contract() {
        let dir = TestDir::new();
        let path = dir.fixture();
        assert_eq!(
            pdf_probe(path.to_str().unwrap().into())
                .await
                .unwrap()
                .pages,
            3
        );
        std::fs::write(dir.0.join("extracted.pdf"), b"existing").unwrap();
        let out = invoke(json!({
            "kind": "pdf.extract", "inputPath": path, "taskId": "pdf-test-extract",
            "what": "pages", "pages": {"ranges": [{"from": 2, "toInclusive": 2}],
                "oddOnly": false, "evenOnly": false}
        }))
        .await
        .unwrap();
        let data = std::fs::read(&out.outputs[0].path).unwrap();
        assert_eq!(pdf::probe_pdf(&data).unwrap().pages, 1);
        assert_eq!(
            std::fs::read(dir.0.join("extracted.pdf")).unwrap(),
            b"existing"
        );
        let contract = serde_json::to_value(&out).unwrap();
        assert_eq!(contract["outputName"], "extracted-1.pdf");
        assert_eq!(contract["outputs"][0]["bytes"], data.len());
        assert!(contract.get("text").is_none());
    }

    #[tokio::test]
    async fn split_preserves_all_outputs_and_merge_follows_input_order() {
        let dir = TestDir::new();
        let path = dir.fixture();
        let out = invoke(json!({
            "kind": "pdf.split", "inputPath": path, "taskId": "pdf-test-split",
            "ranges": [{"from": 1, "toInclusive": 1}, {"from": 2, "toInclusive": 3}]
        }))
        .await
        .unwrap();
        let parts = out.outputs;
        assert_eq!(parts.len(), 2);
        assert_eq!(parts[0].name, "part-1.pdf");
        assert_eq!(parts[1].name, "part-2.pdf");
        let inputs: Vec<_> = parts.iter().rev().map(|part| &part.path).collect();
        let merged = invoke(json!({
            "kind": "pdf.merge", "inputPaths": inputs, "taskId": "pdf-test-merge"
        }))
        .await
        .unwrap();
        let actual = std::fs::read(&merged.outputs[0].path).unwrap();
        let expected_inputs: Vec<_> = inputs.iter().map(|p| std::fs::read(p).unwrap()).collect();
        assert_eq!(
            actual,
            pdf::pdf_merge(&expected_inputs, &Limits::DESKTOP).unwrap()
        );
    }

    #[tokio::test]
    async fn merge_validates_count_before_file_access() {
        let err = invoke(json!({
            "kind": "pdf.merge", "inputPaths": ["missing.pdf"], "taskId": "pdf-test-invalid"
        }))
        .await
        .unwrap_err();
        assert_eq!(err.code, media_ports::ErrorCode::InvalidParams);
    }
}
