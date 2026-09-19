//! EPUB 元数据与封面解析。
//!
//! EPUB 的读取路径是固定的三步：
//!   1. `META-INF/container.xml` 指出 OPF 文件的位置
//!   2. OPF 的 `<metadata>` 给出标题/作者/语言等
//!   3. OPF 的 `<manifest>` + `<guide>`/`properties="cover-image"` 指出封面
//!
//! 这里只做最小必要解析：目的是导入时能立刻拿到书名、作者和封面。

use crate::error::{Error, Result};
use quick_xml::events::Event;
use quick_xml::Reader;
use std::io::Read;
use std::path::Path;

#[derive(Debug, Default, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookMeta {
    pub title: String,
    pub author: Option<String>,
    pub language: Option<String>,
    pub publisher: Option<String>,
    pub identifier: Option<String>,
    /// 封面原图字节，由调用方决定如何加工。
    pub cover: Option<Vec<u8>>,
}

/// 读取 zip 中某个文件的文本内容。
fn read_zip_text(zip: &mut zip::ZipArchive<std::fs::File>, name: &str) -> Result<Option<String>> {
    let mut entry = match zip.by_name(name) {
        Ok(e) => e,
        Err(_) => return Ok(None),
    };
    let mut s = String::new();
    entry
        .read_to_string(&mut s)
        .map_err(|e| Error::Epub(format!("读取 {name} 失败：{e}")))?;
    Ok(Some(s))
}

/// 从 container.xml 里找出 OPF 的相对路径。
fn find_opf_path(container_xml: &str) -> Option<String> {
    let mut reader = Reader::from_str(container_xml);
    reader.config_mut().trim_text(true);
    let mut buf = Vec::new();

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(e)) | Ok(Event::Empty(e)) => {
                if e.local_name().as_ref() == b"rootfile" {
                    for attr in e.attributes().flatten() {
                        if attr.key.local_name().as_ref() == b"full-path" {
                            return attr.unescape_value().ok().map(|v| v.into_owned());
                        }
                    }
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    None
}

struct ManifestItem {
    id: String,
    href: String,
    properties: String,
}

/// 解析 OPF，返回元数据、manifest 与封面 id。
struct OpfData {
    meta: BookMeta,
    items: Vec<ManifestItem>,
    cover_id: Option<String>,
    guide_cover_href: Option<String>,
}

fn parse_opf(opf: &str) -> Result<OpfData> {
    let mut reader = Reader::from_str(opf);
    // 这里**不能**开 trim_text：它会把文本节点内部的空白也裁掉，
    // 于是 "汤姆&杰瑞 中文" 这种书名会被粘成 "汤姆&杰瑞中文"。
    // 首尾空白由 e_text() 在最后统一 trim。
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();

    let mut meta = BookMeta::default();
    let mut items = Vec::new();
    let mut cover_id = None;
    let mut guide_cover_href = None;

    // 当前所处的上下文，用于区分 dc:title 与其它 title
    let mut in_metadata = false;

    loop {
        let ev = reader
            .read_event_into(&mut buf)
            .map_err(|e| Error::Epub(format!("OPF 解析失败：{e}")))?;

        match ev {
            Event::Start(e) | Event::Empty(e) => {
                let name_bytes = e.local_name().as_ref().to_vec();
                let name = String::from_utf8_lossy(&name_bytes).to_string();

                match name.as_str() {
                    "metadata" => in_metadata = true,
                    "item" => {
                        let mut id = String::new();
                        let mut href = String::new();
                        let mut properties = String::new();
                        for attr in e.attributes().flatten() {
                            let key = attr.key.local_name().as_ref().to_vec();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key.as_slice() {
                                b"id" => id = val,
                                b"href" => href = val,
                                b"properties" => properties = val,
                                _ => {}
                            }
                        }
                        items.push(ManifestItem {
                            id,
                            href,
                            properties,
                        });
                    }
                    "meta" => {
                        // EPUB 2 用 <meta name="cover" content="封面id"/>
                        let mut mname = String::new();
                        let mut content = String::new();
                        for attr in e.attributes().flatten() {
                            let key = attr.key.local_name().as_ref().to_vec();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key.as_slice() {
                                b"name" => mname = val,
                                b"content" => content = val,
                                _ => {}
                            }
                        }
                        if mname == "cover" && !content.is_empty() {
                            cover_id = Some(content);
                        }
                    }
                    "reference" => {
                        // <guide><reference type="cover" href="..."/>
                        let mut rtype = String::new();
                        let mut href = String::new();
                        for attr in e.attributes().flatten() {
                            let key = attr.key.local_name().as_ref().to_vec();
                            let val = attr.unescape_value().unwrap_or_default().into_owned();
                            match key.as_slice() {
                                b"type" => rtype = val,
                                b"href" => href = val,
                                _ => {}
                            }
                        }
                        if rtype == "cover" && !href.is_empty() {
                            guide_cover_href = Some(href);
                        }
                    }
                    // 每个字段只取第一个出现的值（EPUB 允许多个 dc:title，
                    // 其中第一个通常是主标题）。条件写进 guard，避免嵌套 if。
                    "title" if in_metadata && meta.title.is_empty() => {
                        meta.title = e_text(&mut reader, &name)?;
                    }
                    "creator" if in_metadata && meta.author.is_none() => {
                        meta.author = Some(e_text(&mut reader, &name)?);
                    }
                    "language" if in_metadata && meta.language.is_none() => {
                        meta.language = Some(e_text(&mut reader, &name)?);
                    }
                    "publisher" if in_metadata && meta.publisher.is_none() => {
                        meta.publisher = Some(e_text(&mut reader, &name)?);
                    }
                    "identifier" if in_metadata && meta.identifier.is_none() => {
                        meta.identifier = Some(e_text(&mut reader, &name)?);
                    }
                    _ => {}
                }
            }
            Event::End(e) => {
                if e.local_name().as_ref() == b"metadata" {
                    in_metadata = false;
                }
            }
            Event::Eof => break,
            _ => {}
        }
        buf.clear();
    }

    Ok(OpfData {
        meta,
        items,
        cover_id,
        guide_cover_href,
    })
}

/// 读取当前元素的文本内容（用于 <dc:title>xxx</dc:title> 这类简单节点）。
///
/// 不能用 quick-xml 的 `read_text(QName(...))`：它按**完整名**（含命名空间前缀）匹配结束标签，
/// 而 `</dc:title>` 的完整名是 `dc:title`，与 `title` 对不上，会一路扫到文档结尾并报错。
/// 这里改为按 **local name** 匹配。
fn e_text(reader: &mut Reader<&[u8]>, elem: &str) -> Result<String> {
    let mut out = String::new();
    loop {
        match reader.read_event() {
            Ok(Event::Text(t)) => {
                let s = t
                    .xml10_content()
                    .map_err(|e| Error::Epub(format!("读取 {elem} 文本失败：{e}")))?;
                out.push_str(&s);
            }
            // quick-xml 0.38 起，`&amp;` / `&#x4E2D;` 这类引用不再混在 Text 里，
            // 而是单独发 GeneralRef 事件。不处理的话书名里的 & 会凭空消失。
            Ok(Event::GeneralRef(r)) => {
                if let Some(ch) = r
                    .resolve_char_ref()
                    .map_err(|e| Error::Epub(format!("解析字符引用失败：{e}")))?
                {
                    out.push(ch);
                } else {
                    let name = r
                        .xml10_content()
                        .map_err(|e| Error::Epub(format!("解析实体引用失败：{e}")))?;
                    match name.as_ref() {
                        "amp" => out.push('&'),
                        "lt" => out.push('<'),
                        "gt" => out.push('>'),
                        "quot" => out.push('"'),
                        "apos" => out.push('\''),
                        // 自定义实体在 EPUB 元数据里几乎不会出现；原样保留，避免静默丢字
                        other => {
                            out.push('&');
                            out.push_str(other);
                            out.push(';');
                        }
                    }
                }
            }
            Ok(Event::CData(c)) => {
                let s = c
                    .xml10_content()
                    .map_err(|e| Error::Epub(format!("读取 CDATA 失败：{e}")))?;
                out.push_str(&s);
            }
            Ok(Event::End(e)) => {
                if e.local_name().as_ref() == elem.as_bytes() {
                    break;
                }
            }
            Ok(Event::Eof) => break,
            Ok(_) => {}
            Err(e) => return Err(Error::Epub(format!("读取 {elem} 文本失败：{e}"))),
        }
    }
    Ok(out.trim().to_string())
}

/// 解析一本 EPUB，返回元数据（含封面字节）。
pub fn parse(path: &Path) -> Result<BookMeta> {
    let file = std::fs::File::open(path)?;
    let mut zip =
        zip::ZipArchive::new(file).map_err(|e| Error::Epub(format!("无法作为 zip 打开：{e}")))?;

    let container = read_zip_text(&mut zip, "META-INF/container.xml")?
        .ok_or_else(|| Error::Epub("缺少 META-INF/container.xml".into()))?;

    let opf_path = find_opf_path(&container)
        .ok_or_else(|| Error::Epub("container.xml 里没有 rootfile".into()))?;

    let opf = read_zip_text(&mut zip, &opf_path)?
        .ok_or_else(|| Error::Epub(format!("找不到 OPF 文件 {opf_path}")))?;

    let data = parse_opf(&opf)?;
    let mut meta = data.meta;

    // 书名兜底：拿文件名，避免书库里出现空白项
    if meta.title.trim().is_empty() {
        meta.title = path
            .file_stem()
            .map(|s| s.to_string_lossy().to_string())
            .unwrap_or_else(|| "未知书名".to_string());
    }

    // 封面查找优先级：
    //   1. manifest 里 properties 含 "cover-image"（EPUB 3）
    //   2. <meta name="cover" content="id"/>（EPUB 2）
    //   3. guide 里的 type="cover" 指向的文档（取其目录下的图片）
    let opf_dir = Path::new(&opf_path)
        .parent()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default();

    let mut cover_href: Option<String> = None;
    if let Some(item) = data
        .items
        .iter()
        .find(|i| i.properties.split_whitespace().any(|p| p == "cover-image"))
    {
        cover_href = Some(item.href.clone());
    }
    if cover_href.is_none() {
        if let Some(cid) = &data.cover_id {
            if let Some(item) = data.items.iter().find(|i| &i.id == cid) {
                cover_href = Some(item.href.clone());
            }
        }
    }
    if cover_href.is_none() {
        if let Some(g) = &data.guide_cover_href {
            // guide 指向的是页面，取其所在目录里第一张图片作为近似封面
            let dir = Path::new(g)
                .parent()
                .map(|p| p.to_string_lossy().to_string());
            if let Some(item) = data.items.iter().find(|i| {
                let is_image = i.href.to_lowercase().ends_with(".jpg")
                    || i.href.to_lowercase().ends_with(".jpeg")
                    || i.href.to_lowercase().ends_with(".png")
                    || i.href.to_lowercase().ends_with(".webp");
                let same_dir = match (&dir, Path::new(&i.href).parent()) {
                    (Some(d), Some(p)) => p.to_string_lossy() == d.as_str(),
                    (None, None) => true,
                    _ => false,
                };
                is_image && same_dir
            }) {
                cover_href = Some(item.href.clone());
            }
        }
    }

    if let Some(href) = cover_href {
        let full = if opf_dir.is_empty() {
            href.clone()
        } else {
            format!("{opf_dir}/{href}")
        };
        let normalized = full.replace('\\', "/");
        if let Ok(mut entry) = zip.by_name(&normalized) {
            let mut bytes = Vec::new();
            if entry.read_to_end(&mut bytes).is_ok() && !bytes.is_empty() {
                meta.cover = Some(bytes);
            }
        }
    }

    Ok(meta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn finds_opf_path_in_container() {
        let xml = r#"<?xml version="1.0"?>
        <container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
          <rootfiles>
            <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
          </rootfiles>
        </container>"#;
        assert_eq!(find_opf_path(xml).as_deref(), Some("OEBPS/content.opf"));
    }

    #[test]
    fn parses_basic_metadata() {
        let opf = r#"<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>测试书名</dc:title>
            <dc:creator>某作者</dc:creator>
            <dc:language>zh-CN</dc:language>
            <meta name="cover" content="cover-img"/>
          </metadata>
          <manifest>
            <item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>
          </manifest>
        </package>"#;
        let d = parse_opf(opf).unwrap();
        assert_eq!(d.meta.title, "测试书名");
        assert_eq!(d.meta.author.as_deref(), Some("某作者"));
        assert_eq!(d.meta.language.as_deref(), Some("zh-CN"));
        assert_eq!(d.cover_id.as_deref(), Some("cover-img"));
    }

    /// 用**真实** EPUB 做端到端验证。
    ///
    /// 合成的小样 OPF 覆盖不到真实文件的复杂度：命名空间前缀、多种封面声明方式、
    /// 实体引用、目录结构与实际打包差异。默认忽略，需要时显式跑：
    ///
    /// ```
    /// $env:INKWELL_TEST_EPUB="D:\path\to\book.epub"
    /// cargo test --lib -- --ignored parses_real_epub
    /// ```
    #[test]
    #[ignore = "需要真实 EPUB 文件，通过 INKWELL_TEST_EPUB 指定"]
    fn parses_real_epub() {
        let path =
            std::env::var("INKWELL_TEST_EPUB").expect("请设置 INKWELL_TEST_EPUB 指向一个真实 EPUB");
        let meta = parse(std::path::Path::new(&path)).expect("解析失败");

        println!("标题 = {:?}", meta.title);
        println!("作者 = {:?}", meta.author);
        println!("语言 = {:?}", meta.language);
        println!(
            "封面 = {} 字节",
            meta.cover.as_ref().map(|c| c.len()).unwrap_or(0)
        );

        assert!(!meta.title.trim().is_empty(), "标题不应为空");
        assert!(
            meta.cover.as_ref().map(|c| c.len() > 100).unwrap_or(false),
            "应能提取出封面图"
        );
    }

    #[test]
    fn unescapes_xml_entities_in_metadata() {
        let opf = r#"<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="2.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
            <dc:title>汤姆&amp;杰瑞 &#x4E2D;文</dc:title>
            <dc:creator>作者 &lt;笔名&gt;</dc:creator>
          </metadata>
        </package>"#;
        let d = parse_opf(opf).unwrap();
        assert_eq!(d.meta.title, "汤姆&杰瑞 中文");
        assert_eq!(d.meta.author.as_deref(), Some("作者 <笔名>"));
    }

    #[test]
    fn detects_epub3_cover_property() {
        let opf = r#"<?xml version="1.0"?>
        <package xmlns="http://www.idpf.org/2007/opf" version="3.0">
          <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>T</dc:title></metadata>
          <manifest>
            <item id="c" href="cover.png" media-type="image/png" properties="cover-image"/>
          </manifest>
        </package>"#;
        let d = parse_opf(opf).unwrap();
        let cover = d
            .items
            .iter()
            .find(|i| i.properties.contains("cover-image"))
            .unwrap();
        assert_eq!(cover.href, "cover.png");
    }
}
