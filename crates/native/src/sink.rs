//! 文件输入源与文件输出目标。
//!
//! 一个关键细节：**非 UTF-8 文件名**。Linux 上文件名是任意字节序列，
//! `Path::to_str()` 会返回 `None`。这里用 `to_string_lossy()` 做「显示名字」，
//! 但读写一律走 `Path`/`OsStr`，不经过 `String` —— 否则中文/emoji/日文文件名会直接失败。

use media_ports::error::{ErrorCode, Result, ToolError};
use media_ports::{Sink, Source};
use std::fs::File;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

fn io_err(e: std::io::Error, path: &Path) -> ToolError {
    let code = match e.kind() {
        std::io::ErrorKind::PermissionDenied => ErrorCode::PermissionDenied,
        std::io::ErrorKind::NotFound => ErrorCode::Io,
        _ => ErrorCode::Io,
    };
    // 只暴露文件名，不暴露完整路径（隐私约束）
    let name = path
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    ToolError::new(code, &[("detail", &format!("{name}: {e}"))])
}

/// 磁盘文件输入。
#[derive(Debug)]
pub struct FileSource {
    path: PathBuf,
    /// 显示名（已做 lossy 转换，仅用于 UI/日志）。
    display: String,
    /// 文件大小（open 时就取，避免 read_all 前再 stat 一次）。
    size: Option<u64>,
}

impl FileSource {
    pub fn open(path: impl AsRef<Path>) -> Result<Self> {
        let path = path.as_ref().to_path_buf();
        let meta = std::fs::metadata(&path).map_err(|e| io_err(e, &path))?;
        let display = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        Ok(FileSource {
            path,
            display,
            size: Some(meta.len()),
        })
    }

    /// 不 stat 的构造（大小未知）。用于管道/标准输入等场景。
    pub fn open_unknown_size(path: impl AsRef<Path>) -> Self {
        let path = path.as_ref().to_path_buf();
        let display = path
            .file_name()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_else(|| path.to_string_lossy().into_owned());
        FileSource {
            path,
            display,
            size: None,
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }
}

impl Source for FileSource {
    fn name(&self) -> &str {
        &self.display
    }

    fn len(&self) -> Option<u64> {
        self.size
    }

    fn read_all(&mut self) -> Result<Vec<u8>> {
        let mut f = File::open(&self.path).map_err(|e| io_err(e, &self.path))?;
        // 预分配：知道大小时一次性分配，避免多次 realloc（20 MB 文件差别明显）
        let mut buf = Vec::with_capacity(self.size.unwrap_or(0) as usize);
        f.read_to_end(&mut buf).map_err(|e| io_err(e, &self.path))?;
        Ok(buf)
    }
}

/// 磁盘文件输出。**先写临时文件再 rename**，避免中途失败留下半个文件。
pub struct FileSink {
    final_path: PathBuf,
    temp_path: PathBuf,
    file: Option<File>,
    written: u64,
}

impl FileSink {
    pub fn create(path: impl AsRef<Path>) -> Result<Self> {
        let final_path = path.as_ref().to_path_buf();
        // 同目录下的临时文件，保证 rename 是同一文件系统内（跨设备 rename 会失败）
        let temp_path = final_path.with_extension(format!(
            "{}.tmp",
            final_path
                .extension()
                .map(|e| e.to_string_lossy().into_owned())
                .unwrap_or_default()
        ));
        if let Some(parent) = final_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent).map_err(|e| io_err(e, parent))?;
            }
        }
        let file = File::create(&temp_path).map_err(|e| io_err(e, &temp_path))?;
        Ok(FileSink {
            final_path,
            temp_path,
            file: Some(file),
            written: 0,
        })
    }
}

impl Sink for FileSink {
    fn write(&mut self, data: &[u8]) -> Result<()> {
        let f = self
            .file
            .as_mut()
            .ok_or_else(|| ToolError::internal("sink 已关闭"))?;
        f.write_all(data).map_err(|e| io_err(e, &self.temp_path))?;
        self.written += data.len() as u64;
        Ok(())
    }

    fn finish(&mut self) -> Result<()> {
        if let Some(mut f) = self.file.take() {
            f.flush().map_err(|e| io_err(e, &self.temp_path))?;
            // 落盘：断电后 rename 才不会指向空文件
            f.sync_all().map_err(|e| io_err(e, &self.temp_path))?;
            drop(f);
            std::fs::rename(&self.temp_path, &self.final_path)
                .map_err(|e| io_err(e, &self.final_path))?;
        }
        Ok(())
    }

    fn written(&self) -> u64 {
        self.written
    }
}

impl Drop for FileSink {
    fn drop(&mut self) {
        // 未 finish 就 drop = 失败路径，清理临时文件
        if self.file.is_some() {
            let _ = std::fs::remove_file(&self.temp_path);
        }
    }
}

/// 原子写文件（一步到位，用于小输出）。
pub fn write_atomic(path: impl AsRef<Path>, data: &[u8]) -> Result<()> {
    let mut sink = FileSink::create(path)?;
    sink.write(data)?;
    sink.finish()
}

/// 读整个文件（带大小上限检查）。
pub fn read_limited(path: impl AsRef<Path>, max_bytes: u64) -> Result<Vec<u8>> {
    let mut src = FileSource::open(path)?;
    src.check_limit(max_bytes)?;
    src.read_all()
}

/// 输出路径的冲突处理：`a.jpg` 已存在 → `a-1.jpg` → `a-2.jpg`。
///
/// 返回**保证不存在**的路径；调用方若想覆盖，直接用自己的路径而不调本函数。
pub fn unique_path(path: impl AsRef<Path>) -> PathBuf {
    let path = path.as_ref();
    if !path.exists() {
        return path.to_path_buf();
    }
    let stem = path
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    let ext = path.extension().map(|s| s.to_string_lossy().into_owned());
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    for i in 1..=9999 {
        let name = match &ext {
            Some(e) => format!("{stem}-{i}.{e}"),
            None => format!("{stem}-{i}"),
        };
        let candidate = parent.join(name);
        if !candidate.exists() {
            return candidate;
        }
    }
    // 极端情况：加时间戳后缀
    parent.join(format!(
        "{stem}-{}.{}",
        std::process::id(),
        ext.unwrap_or_default()
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmpdir() -> tempfile::TempDir {
        tempfile::tempdir().unwrap()
    }

    #[test]
    fn write_then_read_roundtrip() {
        let d = tmpdir();
        let p = d.path().join("out.bin");
        write_atomic(&p, b"hello world").unwrap();
        let mut s = FileSource::open(&p).unwrap();
        assert_eq!(s.len(), Some(11));
        assert_eq!(s.read_all().unwrap(), b"hello world".to_vec());
    }

    #[test]
    fn sink_is_atomic_on_drop_without_finish() {
        let d = tmpdir();
        let p = d.path().join("partial.bin");
        {
            let mut sink = FileSink::create(&p).unwrap();
            sink.write(b"abc").unwrap();
            // 故意不 finish
        }
        assert!(!p.exists(), "未 finish 不应留下目标文件");
        // 临时文件也应被清理
        let leftovers: Vec<_> = std::fs::read_dir(d.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        assert!(leftovers.is_empty(), "残留: {leftovers:?}");
    }

    #[test]
    fn sink_finish_creates_file() {
        let d = tmpdir();
        let p = d.path().join("done.bin");
        let mut sink = FileSink::create(&p).unwrap();
        sink.write(b"xyz").unwrap();
        assert_eq!(sink.written(), 3);
        sink.finish().unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"xyz".to_vec());
    }

    #[test]
    fn utf8_filename_works() {
        let d = tmpdir();
        let p = d.path().join("中文 文件名-😀.txt");
        write_atomic(&p, b"ok").unwrap();
        assert!(p.exists());
        let mut s = FileSource::open(&p).unwrap();
        assert_eq!(s.name(), "中文 文件名-😀.txt");
        assert_eq!(s.read_all().unwrap(), b"ok".to_vec());
    }

    #[test]
    fn missing_file_reports_io_error_with_name() {
        let d = tmpdir();
        let e = FileSource::open(d.path().join("nope.bin")).unwrap_err();
        assert_eq!(e.code, ErrorCode::Io);
        assert!(e.message.contains("nope.bin"));
    }

    #[test]
    fn read_limited_rejects_large_file() {
        let d = tmpdir();
        let p = d.path().join("big.bin");
        std::fs::write(&p, vec![0u8; 2048]).unwrap();
        let e = read_limited(&p, 1024).unwrap_err();
        assert_eq!(e.code, ErrorCode::InputTooLarge);
    }

    #[test]
    fn unique_path_adds_suffix() {
        let d = tmpdir();
        let p = d.path().join("a.jpg");
        std::fs::write(&p, b"x").unwrap();
        let u = unique_path(&p);
        assert_eq!(u.file_name().unwrap().to_string_lossy(), "a-1.jpg");
        std::fs::write(&u, b"x").unwrap();
        assert_eq!(
            unique_path(&p).file_name().unwrap().to_string_lossy(),
            "a-2.jpg"
        );
    }

    #[test]
    fn unique_path_returns_original_when_free() {
        let d = tmpdir();
        let p = d.path().join("free.jpg");
        assert_eq!(unique_path(&p), p);
    }

    #[test]
    fn sink_creates_parent_dirs() {
        let d = tmpdir();
        let p = d.path().join("a/b/c/out.bin");
        write_atomic(&p, b"nested").unwrap();
        assert!(p.exists());
    }
}
