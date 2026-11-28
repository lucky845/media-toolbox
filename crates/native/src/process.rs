//! 子进程执行层：FFmpeg/ffprobe 的 spawn、进度换算与取消（阶段 5 视频纵切）。
//!
//! 职责边界（`docs/ARCHITECTURE.md` §2.1）：
//! - argv 由 `media_core::video::args` 的纯函数构造（本层不拼命令行字符串，杜绝注入）；
//! - 进度逐行喂给 `ProgressParser`（同一份换算逻辑，Web ffmpeg.wasm 降级也复用）；
//! - 取消 = 置 TaskCancel 标志 + kill 进程树（硬取消，对应 capabilities().cancel.hard）；
//! - 错误映射为中文 ToolError：二进制缺失 → BinaryMissing，退出码异常 → DecodeFailed；
//! - stderr 直接接到 null sink，避免管道堵塞和无用读线程。
//!
//! 非 UTF-8 文件名：`std::process::Command` 接受 `OsStr`，全程不做 UTF-8 转换；
//! detail 里不写路径（规格：错误详情不得含文件内容或路径）。

use std::io::{BufRead, BufReader};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::Duration;

use media_core::video::args::ProgressParser;
use media_ports::error::ErrorCode;
use media_ports::progress::{Phase, Progress, Unit};
use media_ports::ToolError;

use crate::cancel::TaskCancel;

/// 一次子进程运行的输出摘要（不给前端回传大段 stdout）。
#[derive(Debug, Clone)]
pub struct ProcessOutcome {
    pub success: bool,
    /// stdout 最后 N 行（排障用，可能含 ffmpeg 进度尾行，不含路径）。
    pub stdout_tail: String,
    pub cancelled: bool,
}

/// unix 下把子进程放入独立进程组，取消时可 `kill -PGID` 一次带走整棵树
/// （ffmpeg 会派生编码器线程/子进程，只 kill 主进程会留孤儿）。
#[cfg(unix)]
fn configure_spawn(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

#[cfg(not(unix))]
fn configure_spawn(_cmd: &mut Command) {}

/// 监视取消标志的看门狗线程：一旦置位就 kill 进程树，让阻塞中的 read_line 结束。
fn spawn_watchdog(cancel: &TaskCancel, child_id: u32, done: Arc<std::sync::atomic::AtomicBool>) {
    let flag = cancel.handle();
    std::thread::spawn(move || {
        while !done.load(std::sync::atomic::Ordering::Relaxed) {
            if flag.load(std::sync::atomic::Ordering::SeqCst) {
                #[cfg(unix)]
                {
                    let pgid = child_id as i32;
                    let _ = Command::new("kill")
                        .args(["-9", &format!("-{pgid}")])
                        .status();
                }
                #[cfg(windows)]
                {
                    let _ = Command::new("taskkill")
                        .args(["/PID", &child_id.to_string(), "/T", "/F"])
                        .status();
                }
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    });
}

/// 运行一个带 `-progress pipe:1` 的命令，逐行换算进度。
///
/// `binary` 必须是 sidecar 探测到的绝对路径；不存在时返回 `BinaryMissing`。
/// `total_duration_sec` 来自 ffprobe；为 0 时进度条只报帧数不报百分比。
pub fn run_with_progress(
    binary: &Path,
    args: &[String],
    total_duration_sec: f64,
    cancel: &TaskCancel,
    on_progress: &dyn Fn(Progress),
) -> Result<ProcessOutcome, ToolError> {
    let mut cmd = Command::new(binary);
    // stderr is not returned or otherwise consumed, so connect it to the platform null sink
    // rather than creating a pipe that can fill and block ffmpeg.
    cmd.args(args).stdout(Stdio::piped()).stderr(Stdio::null());
    configure_spawn(&mut cmd);

    let mut child = cmd.spawn().map_err(|e| {
        let name = binary
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("ffmpeg");
        let mut err = ToolError::new(ErrorCode::BinaryMissing, &[("name", name)]);
        // detail 只写错误类别，不写路径
        err = err.with_detail(format!("spawn failed: {}", e.kind()));
        err
    })?;

    let child_id = child.id();
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    spawn_watchdog(cancel, child_id, done.clone());

    let mut parser = ProgressParser::new(total_duration_sec);
    let mut tail: Vec<String> = Vec::new();
    let stdout = child.stdout.take();
    let mut last_pct = -1i32;

    if let Some(stdout) = stdout {
        for line in BufReader::new(stdout).lines() {
            if cancel.is_cancelled() {
                break;
            }
            let line = match line {
                Ok(l) => l,
                Err(_) => break,
            };
            if let Some(ratio) = parser.feed_line(&line) {
                let pct = (ratio * 100.0) as i32;
                if pct != last_pct {
                    last_pct = pct;
                    on_progress(Progress {
                        done: pct as u64,
                        total: 100,
                        phase: Phase::Encoding,
                        unit: Unit::Percent,
                    });
                }
            }
            tail.push(line);
            if tail.len() > 32 {
                tail.remove(0);
            }
        }
    }

    // 取消可能发生在进程已退出之后；统一以标志为准（watchdog 已尽力 kill）。
    let cancelled = cancel.is_cancelled();
    if cancelled {
        let _ = child.kill();
    }
    let status = child
        .wait()
        .map_err(|e| ToolError::io(format!("wait failed: {}", e.kind())))?;
    done.store(true, std::sync::atomic::Ordering::Relaxed);

    if cancelled {
        return Ok(ProcessOutcome {
            success: false,
            stdout_tail: tail.join("\n"),
            cancelled: true,
        });
    }
    if !status.success() {
        // stderr 不回传（可能含输入文件名）；只给退出码与错误类别。
        return Err(ToolError::new(
            ErrorCode::EncodeFailed,
            &[(
                "detail",
                &format!("ffmpeg 退出码 {}", status.code().unwrap_or(-1)),
            )],
        ));
    }

    Ok(ProcessOutcome {
        success: true,
        stdout_tail: tail.join("\n"),
        cancelled: false,
    })
}

/// 运行一个不带进度协议的短命令（ffprobe），返回完整 stdout。
pub fn run_capture(binary: &Path, args: &[String]) -> Result<String, ToolError> {
    let out = Command::new(binary)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|e| {
            let name = binary
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("ffprobe");
            ToolError::new(ErrorCode::BinaryMissing, &[("name", name)])
                .with_detail(format!("spawn failed: {}", e.kind()))
        })?;
    if !out.status.success() {
        return Err(
            ToolError::new(ErrorCode::DecodeFailed, &[]).with_detail(format!(
                "ffprobe 退出码 {}",
                out.status.code().unwrap_or(-1)
            )),
        );
    }
    String::from_utf8(out.stdout).map_err(|_| {
        ToolError::new(ErrorCode::DecodeFailed, &[]).with_detail("ffprobe 输出非 UTF-8")
    })
}

/// 运行一个不需要回传 stdout 的短命令，并支持硬取消。
pub fn run_capture_with_cancel(
    binary: &Path,
    args: &[String],
    cancel: &TaskCancel,
) -> Result<(), ToolError> {
    let mut cmd = Command::new(binary);
    cmd.args(args).stdout(Stdio::null()).stderr(Stdio::null());
    configure_spawn(&mut cmd);
    let mut child = cmd.spawn().map_err(|e| {
        let name = binary
            .file_name()
            .and_then(|s| s.to_str())
            .unwrap_or("command");
        ToolError::new(ErrorCode::BinaryMissing, &[("name", name)])
            .with_detail(format!("spawn failed: {}", e.kind()))
    })?;
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));
    spawn_watchdog(cancel, child.id(), done.clone());
    let status = child
        .wait()
        .map_err(|e| ToolError::io(format!("wait failed: {}", e.kind())))?;
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    if cancel.is_cancelled() {
        return Err(ToolError::cancelled());
    }
    if !status.success() {
        return Err(ToolError::new(
            ErrorCode::EncodeFailed,
            &[(
                "detail",
                &format!("命令退出码 {}", status.code().unwrap_or(-1)),
            )],
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 回归测试：stderr 写满管道缓冲区时**不能死锁**。
    ///
    /// 历史 bug：只读 stdout、不读 stderr。macOS 管道约 64 KB，
    /// 一个局部损坏的 60 秒视频会让 ffmpeg 吐 345 KB 到 stderr，
    /// 子进程在 write 上阻塞，而我们阻塞在 read stdout —— 永久挂起。
    ///
    /// 重启当前测试二进制来产生大量 stderr，不依赖系统 shell 或 ffmpeg。
    #[test]
    fn stderr_flood_does_not_deadlock() {
        let binary = std::env::current_exe().unwrap();
        let args = [
            "--ignored",
            "--exact",
            "process::tests::stderr_flood_child",
            "--nocapture",
        ]
        .map(str::to_owned);
        let cancel = TaskCancel::new();

        // 放到独立线程里跑：万一回归，用超时让测试失败而不是挂死整个测试进程。
        let (tx, rx) = std::sync::mpsc::channel();
        let child_cancel = cancel.clone();
        std::thread::spawn(move || {
            let r = run_with_progress(&binary, &args, 0.0, &child_cancel, &|_p| {});
            let _ = tx.send(r);
        });

        let result = rx
            .recv_timeout(Duration::from_secs(20))
            .unwrap_or_else(|err| {
                cancel.cancel();
                panic!("stderr 写满后 run_with_progress 未返回: {err}");
            })
            .unwrap();
        assert!(result.success);
        assert!(result.stdout_tail.contains("stderr flood finished"));
    }

    #[test]
    #[ignore = "subprocess fixture for stderr_flood_does_not_deadlock"]
    fn stderr_flood_child() {
        use std::io::Write;

        let chunk = [b'x'; 8 * 1024];
        let mut stderr = std::io::stderr().lock();
        for _ in 0..128 {
            stderr.write_all(&chunk).unwrap();
        }
        println!("stderr flood finished");
    }

    #[test]
    fn spawn_missing_binary_maps_to_binary_missing() {
        let cancel = TaskCancel::new();
        let r = run_with_progress(
            Path::new("/definitely/not/a/real/ffmpeg-binary"),
            &["-version".into()],
            0.0,
            &cancel,
            &|_p| {},
        );
        assert!(r.is_err());
        let e = r.err().unwrap();
        assert_eq!(e.code, ErrorCode::BinaryMissing);
    }

    #[test]
    fn progress_parser_consumes_real_ffmpeg_line() {
        let mut p = ProgressParser::new(10.0);
        assert_eq!(p.feed_line("out_time_us=5000000"), Some(0.5));
        assert_eq!(p.feed_line("progress=end"), Some(1.0));
        assert!(p.finished);
    }

    /// 真实转码集成测试：用本机 ffmpeg（PATH 里）转一个色条源，校验进度事件与退出码。
    /// 没有 ffmpeg 的机器自动跳过（CI 的 rust job 不装 ffmpeg）。
    #[test]
    fn real_ffmpeg_transcode_reports_progress() {
        let ffmpeg = std::env::var_os("PATH").and_then(|path| {
            std::env::split_paths(&path)
                .map(|d| d.join("ffmpeg"))
                .find(|p| p.is_file())
        });
        let Some(ffmpeg) = ffmpeg else {
            eprintln!("跳过：PATH 中没有 ffmpeg");
            return;
        };
        let out = std::env::temp_dir().join(format!("mt-native-test-{}.mp4", std::process::id()));
        let args = vec![
            "-hide_banner".into(),
            "-nostdin".into(),
            "-y".into(),
            "-f".into(),
            "lavfi".into(),
            "-i".into(),
            "testsrc2=size=160x120:rate=10".into(),
            "-t".into(),
            "0.3".into(),
            "-c:v".into(),
            "mpeg4".into(),
            "-progress".into(),
            "pipe:1".into(),
            "-nostats".into(),
            out.to_string_lossy().into_owned(),
        ];
        let cancel = TaskCancel::new();
        let pcts = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let p2 = pcts.clone();
        let r = run_with_progress(&ffmpeg, &args, 0.3, &cancel, &|_p| {
            p2.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        });
        let _ = std::fs::remove_file(&out);
        assert!(r.is_ok(), "{:?}", r.err());
        assert!(r.unwrap().success);
        assert!(
            pcts.load(std::sync::atomic::Ordering::Relaxed) > 0,
            "没有收到进度事件"
        );
    }
}
