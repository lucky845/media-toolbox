//! LibreOffice headless Word↔PDF command（档位：MPL-2.0 原生引擎优先）。
//!
//! 职责边界：只做「路径 → soffice argv → 子进程 → 输出路径」的胶水；
//! 不承诺高保真（复杂排版仍可能丢失，UI 常驻声明）。无 LibreOffice 时返回
//! `LibreOfficeMissing`，前端据此回退到结构化转换（Web 同款）。

use media_native::cancel::TaskGuard;
use media_native::process::run_capture_with_cancel;
use media_ports::error::ErrorCode;
use media_ports::ToolError;
use serde::Serialize;
use std::fs::File;
use std::path::{Path, PathBuf};

use crate::sidecar;

/// Open the official download page in the system browser on user request.
#[tauri::command]
#[allow(deprecated)] // Reuse the bundled shell plugin for this fixed URL.
pub fn open_libreoffice_download(app: tauri::AppHandle) -> Result<(), String> {
    use tauri_plugin_shell::ShellExt;

    app.shell()
        .open("https://www.libreoffice.org/download/", None)
        .map_err(|error| error.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OfficeConvertResult {
    pub output_path: String,
    pub direction: String,
}

/// 用 soffice --headless --convert-to 转换。
///
/// `direction`: 'docx2pdf' | 'pdf2docx'。输出写到同目录，文件名基于输入 stem + taskId，
/// 避免覆盖；LibreOffice 只在独立临时目录内生成输出。
#[tauri::command]
pub async fn office_convert(
    input_path: String,
    direction: String,
    task_id: String,
) -> Result<OfficeConvertResult, ToolError> {
    let guard = TaskGuard::new(&task_id);
    let cancel = guard.token().clone();
    // 先校验方向（纯逻辑），再查二进制：无效参数不应被「组件缺失」掩盖。
    let (filter, ext) = match direction.as_str() {
        "docx2pdf" => ("pdf:writer_pdf_Export", "pdf"),
        "pdf2docx" => ("docx:MS Word 2007 XML", "docx"),
        other => return Err(ToolError::invalid(format!("不支持的转换方向: {other}"))),
    };

    let soffice = sidecar::libreoffice_path()
        .ok_or_else(|| ToolError::new(ErrorCode::LibreOfficeMissing, &[]))?;

    // 临时目录由阻塞任务持有，直到子进程退出和发布完成。
    let output = tokio::task::spawn_blocking(move || {
        convert_office_file(Path::new(&input_path), filter, ext, &task_id, |argv| {
            run_capture_with_cancel(&soffice, argv, &cancel)
        })
    })
    .await
    .map_err(|e| ToolError::internal(format!("任务崩溃: {e}")))??;

    Ok(OfficeConvertResult {
        output_path: output.to_string_lossy().into_owned(),
        direction,
    })
}

fn convert_office_file(
    src: &Path,
    filter: &str,
    ext: &str,
    task_id: &str,
    run: impl FnOnce(&[String]) -> Result<(), ToolError>,
) -> Result<PathBuf, ToolError> {
    if task_id.is_empty()
        || !task_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
    {
        return Err(ToolError::invalid("无效的任务 ID"));
    }
    let src = std::path::absolute(src).map_err(|e| ToolError::io(e.to_string()))?;
    let stem = src
        .file_stem()
        .ok_or_else(|| ToolError::invalid("输入文件名无效"))?
        .to_string_lossy();
    let dir = src
        .parent()
        .ok_or_else(|| ToolError::invalid("输入路径无效"))?;
    let final_out = dir.join(format!("{stem}-converted-{task_id}.{ext}"));

    let stage = tempfile::Builder::new()
        .prefix("mt-lo-")
        .tempdir()
        .map_err(|e| ToolError::io(format!("创建转换临时目录失败: {}", e.kind())))?;
    // 独立 profile 避免抢占用户已运行的 LibreOffice 实例；file URL 处理空格和非 ASCII 路径。
    let profile = tauri::Url::from_directory_path(stage.path().join("profile"))
        .map_err(|()| ToolError::io("LibreOffice 临时配置路径无效"))?;
    let argv = vec![
        format!("-env:UserInstallation={profile}"),
        "--headless".into(),
        "--norestore".into(),
        "--invisible".into(),
        "--nodefault".into(),
        "--convert-to".into(),
        filter.into(),
        "--outdir".into(),
        stage.path().to_string_lossy().into_owned(),
        src.to_string_lossy().into_owned(),
    ];
    run(&argv)?;

    let produced = stage.path().join(format!("{stem}.{ext}"));
    let mut input = File::open(produced).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ToolError::new(
                ErrorCode::EncodeFailed,
                &[("detail", "LibreOffice 未生成输出文件")],
            )
        } else {
            ToolError::io(format!("读取转换输出失败: {}", e.kind()))
        }
    })?;

    // 系统临时目录可能在不同卷：先将完整内容复制到目标目录的临时文件，
    // 再以不覆盖的操作发布，避免覆盖普通文件、符号链接或并发任务刚写入的结果。
    let mut pending = tempfile::NamedTempFile::new_in(dir)
        .map_err(|e| ToolError::io(format!("创建输出临时文件失败: {}", e.kind())))?;
    std::io::copy(&mut input, pending.as_file_mut())
        .map_err(|e| ToolError::io(format!("复制转换输出失败: {}", e.kind())))?;
    pending.persist_noclobber(&final_out).map_err(|e| {
        if e.error.kind() == std::io::ErrorKind::AlreadyExists {
            ToolError::io("输出文件已存在，未覆盖")
        } else {
            ToolError::io(format!("发布转换输出失败: {}", e.error.kind()))
        }
    })?;
    Ok(final_out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake_conversion(
        input: &std::path::Path,
        task_id: &str,
    ) -> Result<std::path::PathBuf, ToolError> {
        convert_office_file(input, "pdf:writer_pdf_Export", "pdf", task_id, |argv| {
            let outdir_arg = argv.iter().position(|arg| arg == "--outdir").unwrap();
            let outdir = std::path::Path::new(&argv[outdir_arg + 1]);
            assert_ne!(outdir, input.parent().unwrap());
            assert_eq!(argv.last().unwrap(), input.to_str().unwrap());
            assert!(argv[0].starts_with("-env:UserInstallation=file:"));
            assert!(!outdir.join("sample.pdf").exists());
            std::fs::write(outdir.join("sample.pdf"), b"new PDF").unwrap();
            Ok(())
        })
    }

    #[test]
    fn office_conversion_preserves_existing_sibling_and_publishes_result() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.docx");
        let sibling = dir.path().join("sample.pdf");
        std::fs::write(&input, b"source document").unwrap();
        std::fs::write(&sibling, b"existing PDF").unwrap();

        let output = fake_conversion(&input, "t-test").unwrap();

        assert_eq!(output, dir.path().join("sample-converted-t-test.pdf"));
        assert_eq!(std::fs::read(output).unwrap(), b"new PDF");
        assert_eq!(std::fs::read(sibling).unwrap(), b"existing PDF");
    }

    #[test]
    fn office_conversion_does_not_clobber_existing_final_output() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.docx");
        let output = dir.path().join("sample-converted-t-test.pdf");
        std::fs::write(&input, b"source document").unwrap();
        std::fs::write(&output, b"existing output").unwrap();

        assert!(fake_conversion(&input, "t-test").is_err());
        assert_eq!(std::fs::read(output).unwrap(), b"existing output");
        assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 2);
    }

    #[test]
    fn office_conversion_does_not_accept_stale_output_and_cleans_stage() {
        let dir = tempfile::tempdir().unwrap();
        let input = dir.path().join("sample.docx");
        let sibling = dir.path().join("sample.pdf");
        std::fs::write(&input, b"source document").unwrap();
        std::fs::write(&sibling, b"existing PDF").unwrap();
        let mut staged = None;

        let result =
            convert_office_file(&input, "pdf:writer_pdf_Export", "pdf", "t-test", |argv| {
                let outdir_arg = argv.iter().position(|arg| arg == "--outdir").unwrap();
                staged = Some(std::path::PathBuf::from(&argv[outdir_arg + 1]));
                Ok(())
            });

        assert!(result.is_err());
        assert!(!staged.unwrap().exists());
        assert!(!dir.path().join("sample-converted-t-test.pdf").exists());
        assert_eq!(std::fs::read(sibling).unwrap(), b"existing PDF");
    }

    #[test]
    fn invalid_direction_rejected() {
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let r = rt.block_on(office_convert(
            "in.docx".into(),
            "xlsx2pdf".into(),
            "t-test".into(),
        ));
        assert!(r.is_err());
        let e = r.err().unwrap();
        assert_eq!(e.code, ErrorCode::InvalidParams);
    }

    #[test]
    fn missing_libreoffice_reports_specific_error() {
        // 没有 LibreOffice 的机器上应返回 LibreOfficeMissing（而不是 DecodeFailed/Internal）。
        if sidecar::libreoffice_path().is_some() {
            eprintln!("跳过：本机有 LibreOffice");
            return;
        }
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let r = rt.block_on(office_convert(
            "in.docx".into(),
            "docx2pdf".into(),
            "t-test-lo".into(),
        ));
        assert!(r.is_err());
        assert_eq!(r.err().unwrap().code, ErrorCode::LibreOfficeMissing);
    }
}
