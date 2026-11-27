//! LibreOffice headless Word↔PDF command（档位：MPL-2.0 原生引擎优先）。
//!
//! 职责边界：只做「路径 → soffice argv → 子进程 → 输出路径」的胶水；
//! 不承诺高保真（复杂排版仍可能丢失，UI 常驻声明）。无 LibreOffice 时返回
//! `LibreOfficeMissing`，前端据此回退到结构化转换（Web 同款）。

use media_native::cancel::TaskGuard;
use media_native::process::run_capture;
use media_ports::error::ErrorCode;
use media_ports::ToolError;
use serde::Serialize;

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
/// 避免覆盖；LibreOffice 的 --outdir 不支持指定文件名，转换后重命名。
#[tauri::command]
pub async fn office_convert(
    input_path: String,
    direction: String,
    task_id: String,
) -> Result<OfficeConvertResult, ToolError> {
    let _guard = TaskGuard::new(&task_id);
    // 先校验方向（纯逻辑），再查二进制：无效参数不应被「组件缺失」掩盖。
    let (filter, ext) = match direction.as_str() {
        "docx2pdf" => ("pdf:writer_pdf_Export", "pdf"),
        "pdf2docx" => ("docx:MS Word 2007 XML", "docx"),
        other => return Err(ToolError::invalid(format!("不支持的转换方向: {other}"))),
    };

    let soffice = sidecar::libreoffice_path()
        .ok_or_else(|| ToolError::new(ErrorCode::LibreOfficeMissing, &[]))?;

    let src = std::path::Path::new(&input_path);
    let stem = src
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| "document".into());
    let dir = src.parent().unwrap_or_else(|| std::path::Path::new("."));
    let final_out = dir.join(format!("{stem}-converted-{task_id}.{ext}"));

    // LibreOffice 用独立 user profile，避免与用户正在运行的实例冲突；
    // profile 放系统临时目录，任务结束后删除。
    let profile = std::env::temp_dir().join(format!("mt-lo-profile-{task_id}"));
    let _ = std::fs::create_dir_all(&profile);

    // 有些 soffice 包装脚本不支持 -env:UserInstallation 紧跟等号，分开传值。
    let argv = vec![
        format!("-env:UserInstallation=file://{}", profile.to_string_lossy()),
        "--headless".into(),
        "--norestore".into(),
        "--invisible".into(),
        "--nodefault".into(),
        "--convert-to".into(),
        filter.into(),
        "--outdir".into(),
        dir.to_string_lossy().into_owned(),
        input_path.clone(),
    ];

    // soffice 转换是 CPU + IO 密集，放 spawn_blocking 避免阻塞 async 运行时。
    let soffice_bin = soffice.clone();
    let result = tokio::task::spawn_blocking(move || run_capture(&soffice_bin, &argv)).await;
    let _ = std::fs::remove_dir_all(&profile);

    match result {
        Ok(Ok(_)) => {}
        Ok(Err(e)) => return Err(e),
        Err(e) => return Err(ToolError::internal(format!("任务崩溃: {e}"))),
    }

    // LibreOffice 会把输出命名为 <stem>.<ext>；重命名为带 taskId 的最终名。
    let produced = dir.join(format!("{stem}.{ext}"));
    if produced.exists() {
        std::fs::rename(&produced, &final_out)
            .map_err(|e| ToolError::io(format!("重命名输出失败: {}", e.kind())))?;
    } else if !final_out.exists() {
        return Err(ToolError::new(ErrorCode::LibreOfficeMissing, &[])
            .with_detail("LibreOffice 未生成输出文件"));
    }

    Ok(OfficeConvertResult {
        output_path: final_out.to_string_lossy().into_owned(),
        direction,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

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
