//! 文档结构化转换的辅助（纯逻辑）。
//!
//! 重要（规格 §15）：浏览器内 **没有 LibreOffice**，无法高保真。
//! Web 端 Word→PDF 走 `mammoth`（读 docx）+ `pdf-lib`（生成 PDF）；
//! PDF→Word 走本模块的文本抽取 + 前端 `docx` 库生成结构化 docx。
//!
//! 本模块只做「不依赖浏览器 API 的纯逻辑」：
//!  - 从 PDF 文本抽取结果组织成段落结构
//!  - 生成结构化 docx 所需的文本段落列表
//!
//! 保真度声明由 UI 常驻显示，本模块**不承诺无损**。

use media_ports::{Result, ToolError};

/// 结构化的段落（来自 PDF 文本抽取）。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Paragraph {
    pub text: String,
    /// 0 = 正文，1..=6 = 标题层级（启发式判断）
    pub heading_level: u8,
}

/// 把 PDF 抽取的文本按空行切成段落，并启发式识别标题。
///
/// 启发式：独占一行、长度 < 80、不以句号/逗号结尾 → 视为标题。
/// 这是**启发式**，必然有误判；UI 必须常驻「结构化转换可能丢失排版」声明。
pub fn structure_text(raw: &str) -> Vec<Paragraph> {
    let mut out = Vec::new();
    for block in raw.split("\n\n") {
        for line in block.lines() {
            let t = line.trim();
            if t.is_empty() {
                continue;
            }
            let is_heading = t.len() < 80
                && !t.ends_with(['。', '，', '.', ',', '；', ';'])
                && !t.starts_with("http");
            out.push(Paragraph {
                text: t.to_string(),
                heading_level: if is_heading { 1 } else { 0 },
            });
        }
    }
    out
}

/// 把段落转换为「结构化 docx 生成」需要的 JSON（前端 docx 库消费）。
pub fn paragraphs_to_json(paragraphs: &[Paragraph]) -> Result<String> {
    let v: Vec<serde_json::Value> = paragraphs
        .iter()
        .map(|p| {
            serde_json::json!({
                "text": p.text,
                "headingLevel": p.heading_level,
            })
        })
        .collect();
    serde_json::to_string(&v).map_err(|e| ToolError::internal(format!("段落序列化失败: {e}")))
}

/// 估计结构化转换的信息损失等级（用于 UI 提示）。
pub fn fidelity_note(direction: FidelityDirection) -> &'static str {
    match direction {
        FidelityDirection::DocxToPdf => "浏览器内没有 LibreOffice：仅转换文本与简单表格，会丢失嵌入字体、分栏、浮动图形、页眉页脚、批注、复杂排版。",
        FidelityDirection::PdfToDocx => "仅还原文本段落与简单表格：会丢失原版式、图片位置、字体、合并单元格。扫描件需先 OCR（本项目不做）。",
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FidelityDirection {
    DocxToPdf,
    PdfToDocx,
}

#[cfg(all(test, feature = "office"))]
mod tests {
    use super::*;

    #[test]
    fn structure_text_splits_paragraphs() {
        let raw = "标题\n\n正文第一行。\n正文第二行。\n\n另一个标题\n更多正文。";
        let p = structure_text(raw);
        assert_eq!(p.len(), 5);
        assert_eq!(p[0].text, "标题");
        assert_eq!(p[0].heading_level, 1);
        assert_eq!(p[1].text, "正文第一行。");
        assert_eq!(p[1].heading_level, 0);
    }

    #[test]
    fn urls_are_not_headings() {
        let p = structure_text("https://example.com/a/b/c");
        assert_eq!(p[0].heading_level, 0);
    }

    #[test]
    fn long_lines_are_not_headings() {
        let long = "x".repeat(100);
        let p = structure_text(&long);
        assert_eq!(p[0].heading_level, 0);
    }

    #[test]
    fn json_has_expected_shape() {
        let p = structure_text("标题\n正文。");
        let s = paragraphs_to_json(&p).unwrap();
        let v: serde_json::Value = serde_json::from_str(&s).unwrap();
        assert_eq!(v[0]["headingLevel"], 1);
        assert_eq!(v[1]["headingLevel"], 0);
    }

    #[test]
    fn fidelity_notes_mention_loss() {
        assert!(fidelity_note(FidelityDirection::DocxToPdf).contains("丢失"));
        assert!(fidelity_note(FidelityDirection::PdfToDocx).contains("丢失"));
    }
}
