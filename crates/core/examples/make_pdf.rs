// 生成测试用 PDF（3 页），供前端 e2e 使用。
fn main() {
    let mut doc = lopdf::Document::with_version("1.7");
    let pages_id = doc.new_object_id();
    let mut kids = Vec::new();
    for i in 0..3 {
        let content_id = doc.add_object(lopdf::Object::Stream(lopdf::Stream::new(
            lopdf::Dictionary::new(),
            format!("BT /F1 24 Tf (Hello Page {}) Tj ET", i + 1).into_bytes(),
        )));
        let mut page = lopdf::Dictionary::new();
        page.set("Type", lopdf::Object::Name(b"Page".to_vec()));
        page.set("Parent", lopdf::Object::Reference(pages_id));
        page.set(
            "MediaBox",
            lopdf::Object::Array(vec![
                lopdf::Object::Integer(0),
                lopdf::Object::Integer(0),
                lopdf::Object::Integer(612),
                lopdf::Object::Integer(792),
            ]),
        );
        page.set("Contents", lopdf::Object::Reference(content_id));
        let pid = doc.add_object(page);
        kids.push(lopdf::Object::Reference(pid));
    }
    let mut pages = lopdf::Dictionary::new();
    pages.set("Type", lopdf::Object::Name(b"Pages".to_vec()));
    pages.set("Kids", lopdf::Object::Array(kids));
    pages.set("Count", lopdf::Object::Integer(3));
    doc.set_object(pages_id, pages);
    let mut catalog = lopdf::Dictionary::new();
    catalog.set("Type", lopdf::Object::Name(b"Catalog".to_vec()));
    catalog.set("Pages", lopdf::Object::Reference(pages_id));
    let root = doc.add_object(catalog);
    doc.trailer.set("Root", lopdf::Object::Reference(root));
    let mut out = Vec::new();
    doc.save_to(&mut out).unwrap();
    std::fs::write("tests/fixtures/sample.pdf", &out).unwrap();
    println!("wrote {} bytes", out.len());
}
