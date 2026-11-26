//! PDF 结构操作（合并 / 拆分 / 旋转 / 提取）。
//!
//! 全部是纯字节操作：输入 `&[u8]`，输出 `Vec<u8>`，不碰文件路径/网络/线程。
//! 用 `lopdf`（MIT），它是纯 Rust，wasm32 可用。
//!
//! 渲染（PDF→图片）**不在这里** —— 那走 pdf.js（浏览器原生 Canvas），
//! 见 `docs/OWNERSHIP.md` §3 的归属决定。

use media_ports::{ErrorCode, Limits, Result, ToolError};
use std::collections::BTreeMap;

/// 页码范围（1-based，闭区间）。
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRange {
    pub from: u32,
    pub to_inclusive: u32,
}

impl PageRange {
    pub fn single(n: u32) -> Self {
        PageRange {
            from: n,
            to_inclusive: n,
        }
    }

    pub fn contains(&self, page: u32) -> bool {
        page >= self.from && page <= self.to_inclusive
    }

    pub fn len(&self) -> usize {
        if self.to_inclusive >= self.from {
            (self.to_inclusive - self.from + 1) as usize
        } else {
            0
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// 页面选择器：范围列表 + 奇/偶页过滤。
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageSelector {
    pub ranges: Vec<PageRange>,
    pub odd_only: bool,
    pub even_only: bool,
}

impl PageSelector {
    pub fn all() -> Self {
        PageSelector {
            ranges: vec![],
            odd_only: false,
            even_only: false,
        }
    }

    pub fn ranges(ranges: Vec<PageRange>) -> Self {
        PageSelector {
            ranges,
            odd_only: false,
            even_only: false,
        }
    }

    pub fn matches(&self, one_based_page: u32) -> bool {
        let in_range =
            self.ranges.is_empty() || self.ranges.iter().any(|r| r.contains(one_based_page));
        if !in_range {
            return false;
        }
        if self.odd_only && one_based_page % 2 == 0 {
            return false;
        }
        if self.even_only && one_based_page % 2 == 1 {
            return false;
        }
        true
    }
}

/// 只读探测 PDF 信息（不解码内容流）。
pub fn probe_pdf(data: &[u8]) -> Result<PdfMeta> {
    if !data.starts_with(b"%PDF-") {
        return Err(ToolError::new(
            ErrorCode::UnsupportedFormat,
            &[("detail", "不是 PDF 文件（缺少 %PDF- 文件头）")],
        ));
    }
    let doc = lopdf::Document::load_mem(data)
        .map_err(|e| ToolError::new(ErrorCode::DecodeFailed, &[]).with_detail(e.to_string()))?;
    let pages = doc.get_pages().len() as u32;

    Ok(PdfMeta {
        pages,
        bytes: data.len() as u64,
        encrypted: doc.is_encrypted(),
        version: doc.version.clone(),
    })
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfMeta {
    pub pages: u32,
    pub bytes: u64,
    pub encrypted: bool,
    pub version: String,
}

/// Validate merge input count before reading or copying byte buffers.
pub fn check_merge_count(count: usize, limits: &Limits) -> Result<()> {
    if count < 2 {
        return Err(ToolError::invalid("合并至少需要 2 个 PDF"));
    }
    if count > limits.max_batch as usize {
        return Err(ToolError::invalid(format!(
            "合并最多支持 {} 个 PDF（当前 {count} 个）",
            limits.max_batch
        )));
    }
    Ok(())
}

/// 合并多个 PDF，按输入顺序拼接页面。
pub fn pdf_merge(inputs: &[Vec<u8>], limits: &Limits) -> Result<Vec<u8>> {
    check_merge_count(inputs.len(), limits)?;
    let total_bytes = inputs
        .iter()
        .fold(0u64, |total, data| total.saturating_add(data.len() as u64));
    crate::common::limits_check::check_bytes(total_bytes, limits)?;

    // Validate the full page count before copying any page object trees.
    let mut documents = Vec::with_capacity(inputs.len());
    let mut total_pages = 0usize;
    for data in inputs {
        let doc = lopdf::Document::load_mem(data)
            .map_err(|e| ToolError::new(ErrorCode::DecodeFailed, &[]).with_detail(e.to_string()))?;
        if doc.is_encrypted() {
            return Err(ToolError::new(ErrorCode::DecodeFailed, &[])
                .with_detail("加密 PDF 暂不支持合并；请先在阅读器中解密"));
        }

        let ids = ordered_page_ids(&doc);
        total_pages = total_pages.saturating_add(ids.len());
        check_page_limit(total_pages, limits)?;
        documents.push((doc, ids));
    }

    let mut out = lopdf::Document::new();
    out.version = "1.7".into();
    let mut page_ids = Vec::with_capacity(total_pages);
    for (doc, ids) in documents {
        for pid in ids {
            page_ids.push(copy_object_tree(&doc, pid, &mut out)?);
        }
    }

    build_pages_tree(&mut out, &page_ids)?;
    save_to_bytes(&mut out)
}

/// 拆分 PDF：每个选中的页范围输出一个独立 PDF。
pub fn pdf_split(
    src: &[u8],
    ranges: &[PageRange],
    limits: &Limits,
) -> Result<Vec<(String, Vec<u8>)>> {
    let doc = load(src)?;
    let pages = ordered_page_ids(&doc);
    check_page_limit(pages.len(), limits)?;

    let mut out = Vec::new();
    for (i, r) in ranges.iter().enumerate() {
        let selected: Vec<usize> = (r.from..=r.to_inclusive)
            .filter(|&p| p >= 1 && (p as usize) <= pages.len())
            .map(|p| p as usize - 1)
            .collect();
        if selected.is_empty() {
            return Err(ToolError::invalid(format!(
                "页码范围 {}-{} 超出文档",
                r.from, r.to_inclusive
            )));
        }

        let mut sub = lopdf::Document::new();
        sub.version = doc.version.clone();
        let mut ids = Vec::new();
        for &idx in &selected {
            ids.push(copy_object_tree(&doc, pages[idx], &mut sub)?);
        }
        build_pages_tree(&mut sub, &ids)?;

        let name = format!("part-{}", i + 1);
        out.push((name, save_to_bytes(&mut sub)?));
    }
    Ok(out)
}

/// 旋转选中页（累加到现有 /Rotate，取模 360）。
pub fn pdf_rotate(
    src: &[u8],
    pages: &PageSelector,
    degrees: i32,
    limits: &Limits,
) -> Result<Vec<u8>> {
    if !matches!(degrees, 90 | 180 | 270 | -90 | -180 | -270) {
        return Err(ToolError::invalid("旋转角度必须是 ±90 / ±180 / ±270"));
    }
    let mut doc = load(src)?;
    let ids = ordered_page_ids(&doc);
    check_page_limit(ids.len(), limits)?;

    for (i, pid) in ids.iter().enumerate() {
        let one_based = i as u32 + 1;
        if !pages.matches(one_based) {
            continue;
        }
        let obj = doc
            .get_object_mut(*pid)
            .map_err(|e| ToolError::internal(format!("读取页面失败: {e}")))?;
        if let lopdf::Object::Dictionary(dict) = obj {
            let current = dict.get(b"Rotate").and_then(|v| v.as_i64()).unwrap_or(0) as i32;
            let next = (current + degrees).rem_euclid(360);
            dict.set("Rotate", lopdf::Object::Integer(next as i64));
        }
    }
    save_to_bytes(&mut doc)
}

/// 提取选中页组成新 PDF。
pub fn pdf_extract_pages(src: &[u8], pages: &PageSelector, limits: &Limits) -> Result<Vec<u8>> {
    let doc = load(src)?;
    let ids = ordered_page_ids(&doc);
    check_page_limit(ids.len(), limits)?;

    let selected: Vec<_> = ids
        .iter()
        .enumerate()
        .filter(|(i, _)| pages.matches(*i as u32 + 1))
        .map(|(_, id)| *id)
        .collect();
    if selected.is_empty() {
        return Err(ToolError::invalid("没有选中的页面"));
    }

    let mut out = lopdf::Document::new();
    out.version = doc.version.clone();
    let mut new_ids = Vec::new();
    for pid in selected {
        new_ids.push(copy_object_tree(&doc, pid, &mut out)?);
    }
    build_pages_tree(&mut out, &new_ids)?;
    save_to_bytes(&mut out)
}

/// 提取文本（内容流里的 Tj / TJ 字符串，简单启发式）。
///
/// 保真度声明（规格 §15）：**不还原排版**。
/// 扫描件没有文本层会返回空字符串；UI 需据此提示「这是图片型 PDF」。
pub fn pdf_extract_text(src: &[u8], pages: &PageSelector, limits: &Limits) -> Result<String> {
    let doc = load(src)?;
    let ids = ordered_page_ids(&doc);
    check_page_limit(ids.len(), limits)?;

    let mut out = String::new();
    for (i, pid) in ids.iter().enumerate() {
        if !pages.matches(i as u32 + 1) {
            continue;
        }
        let content = doc.get_page_content(*pid);
        out.push_str(&extract_strings_from_content(&content));
        out.push('\n');
    }
    Ok(out)
}

/// 提取图片（XObject /Image 的原始流，重新封装成 PNG/JPEG 等）。
pub fn pdf_extract_images(
    src: &[u8],
    pages: &PageSelector,
    limits: &Limits,
) -> Result<Vec<(String, Vec<u8>)>> {
    let doc = load(src)?;
    let ids = ordered_page_ids(&doc);
    check_page_limit(ids.len(), limits)?;

    let mut out = Vec::new();
    for (i, pid) in ids.iter().enumerate() {
        if !pages.matches(i as u32 + 1) {
            continue;
        }
        let images = doc
            .get_page_images(*pid)
            .map_err(|e| ToolError::internal(format!("读取图片失败: {e}")))?;
        for (n, img) in images.iter().enumerate() {
            // lopdf::PdfImage 的 raw 数据即原始图像内容（JPEG/Flate 等），
            // 这里不重新编码，只做最小封装：交给上层用 image crate 解码再编码。
            let data = img.content.to_vec();
            let filter = img
                .filters
                .as_ref()
                .and_then(|f| f.first())
                .cloned()
                .unwrap_or_else(|| "raw".into());
            out.push((format!("p{}-img{}-{}", i + 1, n + 1, filter), data));
        }
    }
    Ok(out)
}

// ---------- 内部辅助 ----------

/// 从键值对构造字典（避免依赖 lopdf 的 `dictionary!` 宏；
/// 该宏在 `default-features = false` 下某些版本不可见）。
fn dict(pairs: &[(&str, lopdf::Object)]) -> lopdf::Dictionary {
    let mut d = lopdf::Dictionary::new();
    for (k, v) in pairs {
        d.set(k.as_bytes(), v.clone());
    }
    d
}

fn load(data: &[u8]) -> Result<lopdf::Document> {
    if !data.starts_with(b"%PDF-") {
        return Err(ToolError::new(
            ErrorCode::UnsupportedFormat,
            &[("detail", "不是 PDF 文件")],
        ));
    }
    lopdf::Document::load_mem(data)
        .map_err(|e| ToolError::new(ErrorCode::DecodeFailed, &[]).with_detail(e.to_string()))
}

fn check_page_limit(n: usize, limits: &Limits) -> Result<()> {
    if n > limits.max_pages as usize {
        let limit = limits.max_pages.to_string();
        // 带上实际页数，否则用户只知道「超限」却不知道自己有多少页
        // （与 common::limits_check::check_pages 的措辞保持一致）。
        let detail = format!("当前 {n} 页，上限 {} 页", limits.max_pages);
        return Err(ToolError::new(ErrorCode::PageLimit, &[("limit", &limit)]).with_detail(detail));
    }
    Ok(())
}

/// 按 PDF 页面树顺序返回 page object id（get_pages 的 BTreeMap 按 id 排，不保证页序）。
fn ordered_page_ids(doc: &lopdf::Document) -> Vec<lopdf::ObjectId> {
    // 递归遍历 /Root /Pages /Kids，保持真实页序
    fn walk(
        doc: &lopdf::Document,
        id: lopdf::ObjectId,
        out: &mut Vec<lopdf::ObjectId>,
        depth: usize,
    ) {
        if depth > 64 {
            return;
        }
        let Ok(obj) = doc.get_object(id) else { return };
        let Ok(dict) = obj.as_dict() else { return };
        let type_ = dict
            .get(b"Type")
            .and_then(|t| t.as_name())
            .unwrap_or_default();
        if type_ == b"Page" {
            out.push(id);
            return;
        }
        if type_ != b"Pages" {
            return;
        }
        let Ok(kids) = dict.get(b"Kids") else { return };
        let Ok(kids) = kids.as_array() else { return };
        for kid in kids {
            if let Ok(kid_id) = kid.as_reference() {
                walk(doc, kid_id, out, depth + 1);
            }
        }
    }

    let mut out = Vec::new();
    if let Ok(catalog) = doc.catalog() {
        if let Ok(pages) = catalog.get(b"Pages") {
            if let Ok(id) = pages.as_reference() {
                walk(doc, id, &mut out, 0);
            }
        }
    }
    if out.is_empty() {
        // 兜底：get_pages 按 id 排序（不一定正确，但总比没有好）
        out = doc.get_pages().values().copied().collect();
    }
    out
}

/// 深拷贝对象树（页面 + 其引用的 Resources/Contents）到目标文档。
fn copy_object_tree(
    src: &lopdf::Document,
    root: lopdf::ObjectId,
    dst: &mut lopdf::Document,
) -> Result<lopdf::ObjectId> {
    let mut map: BTreeMap<lopdf::ObjectId, lopdf::ObjectId> = BTreeMap::new();
    fn copy(
        src: &lopdf::Document,
        dst: &mut lopdf::Document,
        old: lopdf::ObjectId,
        map: &mut BTreeMap<lopdf::ObjectId, lopdf::ObjectId>,
        depth: usize,
    ) -> Result<lopdf::ObjectId> {
        if depth > 64 {
            return Err(ToolError::internal("PDF 对象树过深"));
        }
        if let Some(&new) = map.get(&old) {
            return Ok(new);
        }
        let obj = src
            .get_object(old)
            .map_err(|e| ToolError::internal(format!("读取对象失败: {e}")))?
            .clone();
        let new_id = dst.add_object(lopdf::Object::Null);
        map.insert(old, new_id);

        let rewritten = rewrite_refs(src, dst, &obj, map, depth)?;
        dst.set_object(new_id, rewritten);
        Ok(new_id)
    }

    fn rewrite_refs(
        src: &lopdf::Document,
        dst: &mut lopdf::Document,
        obj: &lopdf::Object,
        map: &mut BTreeMap<lopdf::ObjectId, lopdf::ObjectId>,
        depth: usize,
    ) -> Result<lopdf::Object> {
        Ok(match obj {
            lopdf::Object::Reference(r) => {
                lopdf::Object::Reference(copy(src, dst, *r, map, depth + 1)?)
            }
            lopdf::Object::Array(a) => lopdf::Object::Array(
                a.iter()
                    .map(|x| rewrite_refs(src, dst, x, map, depth + 1))
                    .collect::<Result<Vec<_>>>()?,
            ),
            lopdf::Object::Dictionary(d) => {
                let mut nd = d.clone();
                for (_k, v) in nd.iter_mut() {
                    *v = rewrite_refs(src, dst, v, map, depth + 1)?;
                }
                lopdf::Object::Dictionary(nd)
            }
            lopdf::Object::Stream(s) => {
                let mut ns = s.clone();
                for (_k, v) in ns.dict.iter_mut() {
                    *v = rewrite_refs(src, dst, v, map, depth + 1)?;
                }
                lopdf::Object::Stream(ns)
            }
            other => other.clone(),
        })
    }

    copy(src, dst, root, &mut map, 0)
}

fn build_pages_tree(doc: &mut lopdf::Document, page_ids: &[lopdf::ObjectId]) -> Result<()> {
    let root_pages = doc.add_object(lopdf::Object::Null);
    let mut kids = Vec::new();
    for &pid in page_ids {
        // 让每个 page 的 /Parent 指向新的 Pages 根
        if let Ok(lopdf::Object::Dictionary(d)) = doc.get_object_mut(pid) {
            d.set("Parent", lopdf::Object::Reference(root_pages));
        }
        kids.push(lopdf::Object::Reference(pid));
    }
    let mut pages_dict = dict(&[
        ("Type", lopdf::Object::Name(b"Pages".to_vec())),
        ("Kids", lopdf::Object::Array(kids)),
        ("Count", lopdf::Object::Integer(page_ids.len() as i64)),
    ]);
    pages_dict.set("Parent", lopdf::Object::Reference(root_pages)); // 自引用会被根字典覆盖
    doc.set_object(root_pages, lopdf::Object::Dictionary(pages_dict));

    let root_catalog = doc.add_object(dict(&[
        ("Type", lopdf::Object::Name(b"Catalog".to_vec())),
        ("Pages", lopdf::Object::Reference(root_pages)),
    ]));
    doc.trailer
        .set("Root", lopdf::Object::Reference(root_catalog));
    Ok(())
}

fn save_to_bytes(doc: &mut lopdf::Document) -> Result<Vec<u8>> {
    let mut out = Vec::new();
    doc.save_to(&mut out)
        .map_err(|e| ToolError::new(ErrorCode::EncodeFailed, &[("detail", &e.to_string())]))?;
    Ok(out)
}

/// 从内容流里粗略提取文本字符串（Tj / TJ 的操作数）。
fn extract_strings_from_content(content: &[u8]) -> String {
    let s = String::from_utf8_lossy(content);
    let mut out = String::new();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'(' {
            let mut j = i + 1;
            let mut depth = 1;
            let mut buf = Vec::new();
            while j < bytes.len() && depth > 0 {
                match bytes[j] {
                    b'\\' if j + 1 < bytes.len() => {
                        buf.push(bytes[j + 1]);
                        j += 2;
                    }
                    b'(' => {
                        depth += 1;
                        buf.push(bytes[j]);
                        j += 1;
                    }
                    b')' => {
                        depth -= 1;
                        if depth > 0 {
                            buf.push(bytes[j]);
                        }
                        j += 1;
                    }
                    c => {
                        buf.push(c);
                        j += 1;
                    }
                }
            }
            if let Ok(text) = String::from_utf8(buf) {
                out.push_str(&text);
            }
            i = j;
        } else {
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_pdf(n_pages: usize) -> Vec<u8> {
        let mut doc = lopdf::Document::with_version("1.7");
        let pages_id = doc.new_object_id();
        let mut kids = Vec::new();
        for i in 0..n_pages {
            let content_id = doc.add_object(lopdf::Object::Stream(lopdf::Stream::new(
                dict(&[]),
                format!("BT (Page {}) Tj ET", i + 1).into_bytes(),
            )));
            let pid = doc.add_object(dict(&[
                ("Type", lopdf::Object::Name(b"Page".to_vec())),
                ("Parent", lopdf::Object::Reference(pages_id)),
                (
                    "MediaBox",
                    lopdf::Object::Array(vec![
                        lopdf::Object::Integer(0),
                        lopdf::Object::Integer(0),
                        lopdf::Object::Integer(612),
                        lopdf::Object::Integer(792),
                    ]),
                ),
                ("Resources", lopdf::Object::Dictionary(dict(&[]))),
                ("Contents", lopdf::Object::Reference(content_id)),
            ]));
            kids.push(lopdf::Object::Reference(pid));
        }
        doc.set_object(
            pages_id,
            dict(&[
                ("Type", lopdf::Object::Name(b"Pages".to_vec())),
                ("Kids", lopdf::Object::Array(kids)),
                ("Count", lopdf::Object::Integer(n_pages as i64)),
            ]),
        );
        let root = doc.add_object(dict(&[
            ("Type", lopdf::Object::Name(b"Catalog".to_vec())),
            ("Pages", lopdf::Object::Reference(pages_id)),
        ]));
        doc.trailer.set("Root", lopdf::Object::Reference(root));

        let mut out = Vec::new();
        doc.save_to(&mut out).unwrap();
        out
    }

    #[test]
    fn probe_reads_page_count() {
        let pdf = make_pdf(3);
        let meta = probe_pdf(&pdf).unwrap();
        assert_eq!(meta.pages, 3);
        assert!(!meta.encrypted);
        assert_eq!(meta.version, "1.7");
    }

    #[test]
    fn probe_rejects_non_pdf() {
        assert_eq!(
            probe_pdf(b"not a pdf").unwrap_err().code,
            ErrorCode::UnsupportedFormat
        );
    }

    #[test]
    fn merge_two_documents() {
        let a = make_pdf(2);
        let b = make_pdf(3);
        let merged = pdf_merge(&[a, b], &Limits::DESKTOP).unwrap();
        assert_eq!(probe_pdf(&merged).unwrap().pages, 5);
    }

    #[test]
    fn merge_accumulated_pages_trip_limit() {
        // 单份都在上限内，但累积超限必须中止（回归：此前 merge 完全不校验页数）
        let doc = make_pdf(40);
        let inputs: Vec<Vec<u8>> = (0..4).map(|_| doc.clone()).collect();
        let err = pdf_merge(&inputs, &Limits::WEB).unwrap_err();
        assert_eq!(err.code, ErrorCode::PageLimit);
    }

    #[test]
    fn test_pdf_merge_rejects_cumulative_bytes_before_decoding() {
        let limits = Limits {
            max_bytes: 10,
            ..Limits::WEB
        };
        let inputs = [vec![0; 6], vec![0; 5]];
        let err = pdf_merge(&inputs, &limits).unwrap_err();
        assert_eq!(err.code, ErrorCode::InputTooLarge);
    }

    #[test]
    fn test_pdf_merge_rejects_excessive_file_count_before_decoding() {
        let limits = Limits {
            max_batch: 2,
            ..Limits::WEB
        };
        let inputs = [vec![], vec![], vec![]];
        let err = pdf_merge(&inputs, &limits).unwrap_err();
        assert_eq!(err.code, ErrorCode::InvalidParams);
    }

    #[test]
    fn test_pdf_merge_checks_total_pages_before_copying_objects() {
        let mut broken = lopdf::Document::load_mem(&make_pdf(1)).unwrap();
        let page_id = ordered_page_ids(&broken)[0];
        broken
            .get_object_mut(page_id)
            .unwrap()
            .as_dict_mut()
            .unwrap()
            .set("Contents", lopdf::Object::Reference((9999, 0)));
        let broken = save_to_bytes(&mut broken).unwrap();
        let limits = Limits {
            max_pages: 1,
            ..Limits::WEB
        };
        let err = pdf_merge(&[broken, make_pdf(1)], &limits).unwrap_err();
        assert_eq!(err.code, ErrorCode::PageLimit);
    }

    #[test]
    fn merge_within_limit_is_allowed() {
        let doc = make_pdf(30);
        let inputs: Vec<Vec<u8>> = (0..3).map(|_| doc.clone()).collect();
        let merged = pdf_merge(&inputs, &Limits::WEB).unwrap();
        assert_eq!(probe_pdf(&merged).unwrap().pages, 90);
    }

    #[test]
    fn split_into_ranges() {
        let pdf = make_pdf(6);
        let parts = pdf_split(
            &pdf,
            &[
                PageRange {
                    from: 1,
                    to_inclusive: 2,
                },
                PageRange {
                    from: 5,
                    to_inclusive: 6,
                },
            ],
            &Limits::DESKTOP,
        )
        .unwrap();
        assert_eq!(parts.len(), 2);
        assert_eq!(probe_pdf(&parts[0].1).unwrap().pages, 2);
        assert_eq!(probe_pdf(&parts[1].1).unwrap().pages, 2);
    }

    #[test]
    fn extract_pages() {
        let pdf = make_pdf(5);
        let sel = PageSelector::ranges(vec![PageRange {
            from: 2,
            to_inclusive: 4,
        }]);
        let out = pdf_extract_pages(&pdf, &sel, &Limits::DESKTOP).unwrap();
        assert_eq!(probe_pdf(&out).unwrap().pages, 3);
    }

    #[test]
    fn rotate_selected_pages() {
        let pdf = make_pdf(3);
        let sel = PageSelector::ranges(vec![PageRange::single(2)]);
        let out = pdf_rotate(&pdf, &sel, 90, &Limits::DESKTOP).unwrap();
        let doc = lopdf::Document::load_mem(&out).unwrap();
        let ids = ordered_page_ids(&doc);
        assert_eq!(ids.len(), 3);
        // 第二页的 /Rotate 应为 90
        let rot = doc
            .get_object(ids[1])
            .unwrap()
            .as_dict()
            .unwrap()
            .get(b"Rotate")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);
        assert_eq!(rot, 90);
    }

    #[test]
    fn web_limit_rejects_large_pdf() {
        let pdf = make_pdf(101);
        assert_eq!(probe_pdf(&pdf).unwrap().pages, 101);
        let e = pdf_extract_pages(&pdf, &PageSelector::all(), &Limits::WEB).unwrap_err();
        assert_eq!(e.code, ErrorCode::PageLimit);
    }

    #[test]
    fn extract_text_gets_page_content() {
        let pdf = make_pdf(2);
        let text = pdf_extract_text(&pdf, &PageSelector::all(), &Limits::DESKTOP).unwrap();
        assert!(text.contains("Page 1"));
        assert!(text.contains("Page 2"));
    }

    #[test]
    fn selector_odd_even() {
        let s = PageSelector {
            ranges: vec![],
            odd_only: true,
            even_only: false,
        };
        assert!(s.matches(1));
        assert!(!s.matches(2));
        assert!(s.matches(3));
        let s2 = PageSelector {
            ranges: vec![PageRange {
                from: 2,
                to_inclusive: 5,
            }],
            odd_only: false,
            even_only: true,
        };
        assert!(!s2.matches(1));
        assert!(s2.matches(2));
        assert!(!s2.matches(3));
        assert!(s2.matches(4));
    }

    #[test]
    fn page_range_len_and_contains() {
        let r = PageRange {
            from: 2,
            to_inclusive: 5,
        };
        assert_eq!(r.len(), 4);
        assert!(r.contains(2));
        assert!(r.contains(5));
        assert!(!r.contains(1));
    }
}
