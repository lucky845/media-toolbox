//! PDF 结构操作：合并 / 拆分 / 旋转 / 提取（lopdf，纯 Rust）。
//!
//! 渲染（PDF→图片）走 pdf.js，不在此模块（见 docs/OWNERSHIP.md §3）。

#[cfg(feature = "pdf")]
pub mod ops;
// 说明：这里曾有一个 `pages` 子模块，但只含一行文档注释、无任何实现，
// 页面选择逻辑实际在 ops.rs 的 PageSelector / PageRange 里。已删除以免误导。

#[cfg(feature = "pdf")]
pub use ops::{
    pdf_decrypt, pdf_encrypt, pdf_extract_images, pdf_extract_pages, pdf_extract_text, pdf_merge,
    pdf_reorder, pdf_rotate, pdf_split, probe_pdf, PageRange, PageSelector, PdfMeta,
};
