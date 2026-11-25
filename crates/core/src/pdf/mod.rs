//! PDF 结构操作：合并 / 拆分 / 旋转 / 提取（lopdf，纯 Rust）。
//!
//! 渲染（PDF→图片）走 pdf.js，不在此模块（见 docs/OWNERSHIP.md §3）。

#[cfg(feature = "pdf")]
pub mod ops;
#[cfg(feature = "pdf")]
pub mod pages;

#[cfg(feature = "pdf")]
pub use ops::{
    pdf_extract_images, pdf_extract_pages, pdf_extract_text, pdf_merge, pdf_rotate, pdf_split,
    probe_pdf, PageRange, PageSelector, PdfMeta,
};
