mod common;

use common::TestServer;
use serde_json::json;

#[test]
fn test_file_crud_copy_rename_upload_zip_and_security() {
    let srv = TestServer::start(&[]);

    // Info & languages
    let info = srv.get("/api/info");
    assert_eq!(info.status, 200);
    let info_j = info.json();
    assert!(info_j["root_path"].as_str().unwrap().len() > 0);
    assert!(info_j["languages"].as_array().unwrap().len() >= 2);

    // Create folder, file, notebook, ui
    assert_eq!(srv.post_json("/api/file/new", &json!({"path": "work", "kind": "dir"})).status, 200);
    assert_eq!(srv.post_json("/api/file/new", &json!({"path": "work/a.mini", "kind": "file"})).status, 200);
    assert_eq!(srv.post_json("/api/file/new", &json!({"path": "work/nb.mnb", "kind": "notebook", "language": "minilang"})).status, 200);
    assert_eq!(srv.post_json("/api/file/new", &json!({"path": "work/app.ui", "kind": "ui"})).status, 200);
    assert_eq!(srv.put_json("/api/file", &json!({"path": "work/a.mini", "content": "let x := 123\n"})).status, 200);

    // Directory listing & hidden toggle
    std::fs::write(srv.root.join("work/.secret_dot"), "hidden").unwrap();
    let list_default = srv.get("/api/files?path=work").json();
    let names_default: Vec<&str> = list_default["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(names_default.contains(&"a.mini"));
    assert!(!names_default.contains(&".secret_dot"));

    let list_hidden = srv.get("/api/files?path=work&show_hidden=true").json();
    let names_hidden: Vec<&str> = list_hidden["entries"].as_array().unwrap().iter().map(|e| e["name"].as_str().unwrap()).collect();
    assert!(names_hidden.contains(&".secret_dot"));

    // Copy file with collision auto-naming
    let c1 = srv.post_json("/api/file/copy", &json!({"from": "work/a.mini", "to_dir": "work"}));
    assert_eq!(c1.status, 200);
    assert_eq!(c1.json()["path"], "work/a copy.mini");

    let c2 = srv.post_json("/api/file/copy", &json!({"from": "work/a.mini", "to_dir": "work"}));
    assert_eq!(c2.status, 200);
    assert_eq!(c2.json()["path"], "work/a copy 2.mini");

    // Recursive directory copy
    let dc = srv.post_json("/api/file/copy", &json!({"from": "work", "to_dir": ""}));
    assert_eq!(dc.status, 200);
    assert_eq!(dc.json()["path"], "work copy");
    let copied = srv.get("/api/file?path=work%20copy/a.mini").json();
    assert_eq!(copied["content"], "let x := 123\n");

    // Self-copy, self-move, and path traversal rejected
    assert_eq!(srv.post_json("/api/file/copy", &json!({"from": "work", "to_dir": "work"})).status, 400);
    assert_eq!(srv.post_json("/api/file/rename", &json!({"from": "work", "to": "work/inside"})).status, 400);
    assert_eq!(srv.post_json("/api/file/copy", &json!({"from": "work/a.mini", "to_dir": "../outside"})).status, 400);
    assert_eq!(srv.get("/api/file?path=../etc/passwd").status, 404);

    // Rename & delete
    assert_eq!(srv.post_json("/api/file/rename", &json!({"from": "work/a copy 2.mini", "to": "work/renamed.mini"})).status, 200);
    assert_eq!(srv.get("/api/file?path=work/renamed.mini").status, 200);
    assert_eq!(srv.delete("/api/file?path=work%20copy").status, 200);
    assert_eq!(srv.get("/api/file?path=work%20copy/a.mini").status, 404);

    // Raw upload + multipart upload
    let up_raw = srv.req(
        "POST",
        "/api/file/upload?dir=work&name=data.csv",
        &[("Content-Type", "application/octet-stream")],
        b"name,val\nalpha,10\nbeta,20\n",
    );
    assert_eq!(up_raw.status, 200);
    assert_eq!(up_raw.json()["path"], "work/data.csv");

    let csv_read = srv.get("/api/file?path=work/data.csv").json();
    assert_eq!(csv_read["is_tabular"], true);

    let boundary = "----TestBound42";
    let mp = format!(
        "--{b}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"m1.txt\"\r\nContent-Type: text/plain\r\n\r\nfirst file\r\n\
         --{b}\r\nContent-Disposition: form-data; name=\"files\"; filename=\"m2.md\"\r\nContent-Type: text/markdown\r\n\r\n# Hello Markdown\r\n\
         --{b}--\r\n",
        b = boundary
    );
    let up_mp = srv.req(
        "POST",
        "/api/file/upload?dir=work",
        &[("Content-Type", &format!("multipart/form-data; boundary={}", boundary))],
        mp.as_bytes(),
    );
    assert_eq!(up_mp.status, 200);
    let paths = up_mp.json()["paths"].as_array().unwrap().clone();
    assert_eq!(paths.len(), 2);

    // Folder ZIP download
    let zip = srv.get("/api/file/zip?path=work");
    assert_eq!(zip.status, 200);
    assert_eq!(zip.headers.get("content-type").map(String::as_str), Some("application/zip"));
    assert_eq!(&zip.body[0..4], b"PK\x03\x04");
    assert!(zip.body.windows(8).any(|w| w == b"data.csv"));
    assert!(zip.body.windows(6).any(|w| w == b"m1.txt"));
}

#[test]
fn test_media_markdown_notebook_conversion_and_grep() {
    let srv = TestServer::start(&[]);

    // Minimal valid 1x1 PNG + SVG + PDF
    let png_bytes: &[u8] = &[
        0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a,
        0x00, 0x00, 0x00, 0x0d, b'I', b'H', b'D', b'R',
        0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
        0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89,
    ];
    std::fs::write(srv.root.join("pixel.png"), png_bytes).unwrap();
    std::fs::write(srv.root.join("doc.pdf"), b"%PDF-1.4\n%%EOF\n").unwrap();
    std::fs::write(srv.root.join("readme.md"), "# Workspace Guide\nUniqueTokenAlpha in markdown\n").unwrap();
    std::fs::write(srv.root.join("notes.log"), "2026-11-24T00:00:00Z INFO Boot ok\n2026-11-24T00:01:00Z ERROR Disk full\n").unwrap();

    // Media metadata & raw streaming
    let png_meta = srv.get("/api/file?path=pixel.png").json();
    assert_eq!(png_meta["is_image"], true);
    assert_eq!(png_meta["is_binary"], true);
    let png_raw = srv.get("/api/file/raw?path=pixel.png&download=1");
    assert_eq!(png_raw.status, 200);
    assert_eq!(png_raw.headers.get("content-type").map(String::as_str), Some("image/png"));
    assert!(png_raw.headers.get("content-disposition").unwrap().contains("attachment"));
    assert_eq!(png_raw.body, png_bytes);

    let pdf_meta = srv.get("/api/file?path=doc.pdf").json();
    assert_eq!(pdf_meta["is_pdf"], true);
    let pdf_raw = srv.get("/api/file/raw?path=doc.pdf");
    assert_eq!(pdf_raw.headers.get("content-type").map(String::as_str), Some("application/pdf"));

    // Markdown & plain-text Log Viewer API
    let md_meta = srv.get("/api/file?path=readme.md").json();
    assert_eq!(md_meta["is_markdown"], true);

    let log_res = srv.get("/api/log?path=notes.log&q=Disk").json();
    assert_eq!(log_res["format"], "text");
    assert_eq!(log_res["total"], 2);
    assert_eq!(log_res["filtered"], 1);
    assert_eq!(log_res["entries"][0]["level"], "error");

    // Notebook from-script / to-script roundtrip
    let from_nb = srv.post_json(
        "/api/notebook/from-script",
        &json!({
            "title": "calc.mini",
            "language": "minilang",
            "content": ":> %% Cell 1\nlet UniqueTokenAlpha := 10\n:> %% Cell 2\nUniqueTokenAlpha * 5\n"
        }),
    );
    assert_eq!(from_nb.status, 200);
    let nb_doc = from_nb.json();
    assert_eq!(nb_doc["cells"].as_array().unwrap().len(), 2);

    srv.put_json("/api/file", &json!({"path": "calc.mnb", "content": serde_json::to_string(&nb_doc).unwrap()}));

    let to_script = srv.post_json("/api/notebook/to-script", &nb_doc);
    assert_eq!(to_script.status, 200);
    assert!(to_script.json()["script"].as_str().unwrap().contains("UniqueTokenAlpha * 5"));

    // Workspace full-text grep finds both readme.md and calc.mnb cells!
    let grep = srv.get("/api/files/grep?q=UniqueTokenAlpha").json();
    let hits = grep["matches"].as_array().unwrap();
    assert_eq!(hits.len(), 3, "expected 1 md + 2 notebook cell hits: {:?}", hits);
    assert!(hits.iter().any(|h| h["path"] == "readme.md" && h["cell_index"].is_null()));
    assert!(hits.iter().any(|h| h["path"] == "calc.mnb" && h["cell_index"] == 0));
    assert!(hits.iter().any(|h| h["path"] == "calc.mnb" && h["cell_index"] == 1));

    // Extension filter restricts to .md only
    let grep_md = srv.get("/api/files/grep?q=UniqueTokenAlpha&ext=md").json();
    assert_eq!(grep_md["count"], 1);

    // Feature #9: Notebook Checkpoints CRUD + Minilang execution memory profiling
    let cp1 = srv.post_json(
        "/api/notebook/checkpoints",
        &json!({ "path": "calc.mnb", "label": "Initial snapshot" }),
    );
    assert_eq!(cp1.status, 200, "create checkpoint failed: {}", cp1.text());
    let cp1_id = cp1.json()["checkpoint"]["id"].as_str().unwrap().to_string();
    assert_eq!(cp1.json()["checkpoint"]["cell_count"], 2);

    let cp_list = srv.get("/api/notebook/checkpoints?path=calc.mnb").json();
    assert_eq!(cp_list["ok"], true);
    assert_eq!(cp_list["checkpoints"].as_array().unwrap().len(), 1);

    let cp_detail = srv
        .get(&format!("/api/notebook/checkpoints/{}?path=calc.mnb", cp1_id))
        .json();
    assert_eq!(cp_detail["checkpoint"]["label"], "Initial snapshot");
    assert_eq!(cp_detail["checkpoint"]["doc"]["cells"].as_array().unwrap().len(), 2);

    let cp_del = srv.delete(&format!("/api/notebook/checkpoints/{}?path=calc.mnb", cp1_id));
    assert_eq!(cp_del.status, 200);
    assert_eq!(cp_del.json()["removed"], true);

    // Verify Minilang EvalResult includes Boehm GC memory profiling fields
    srv.create_kernel("prof-k", "minilang");
    let eval_res = srv.eval("prof-k", "let big := list(1 .. 5000)\nbig:count");
    assert!(eval_res["error"].is_null(), "eval error: {:?}", eval_res["error"]);
    assert!(eval_res["memory_bytes"].as_u64().unwrap_or(0) > 0, "expected memory_bytes: {:?}", eval_res);
    assert!(eval_res["memory_delta_bytes"].is_i64(), "expected memory_delta_bytes: {:?}", eval_res);
}
