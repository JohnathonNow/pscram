mod common;

use common::TestServer;
use std::collections::{BTreeSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Command;

fn write_ws_file(srv: &TestServer, rel: &str, content: &str) {
    let full = srv.root.join(rel);
    if let Some(p) = full.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(full, content).unwrap();
}

fn resolve_url_import(from_url: &str, rel: &str) -> String {
    if rel.starts_with('/') {
        return rel.to_string();
    }
    let dir = Path::new(from_url)
        .parent()
        .unwrap_or(Path::new("/"));
    let joined = dir.join(rel);
    let mut parts: Vec<String> = Vec::new();
    for comp in joined.components() {
        match comp {
            std::path::Component::RootDir | std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                parts.pop();
            }
            std::path::Component::Normal(s) => {
                parts.push(s.to_string_lossy().into_owned());
            }
            _ => {}
        }
    }
    format!("/{}", parts.join("/"))
}

fn extract_js_imports(js_src: &str) -> Vec<String> {
    let mut out = Vec::new();
    let bytes = js_src.as_bytes();
    let mut idx = 0;
    while idx < bytes.len() {
        let at_line_start = idx == 0 || bytes[idx - 1] == b'\n';
        if at_line_start
            && (js_src[idx..].starts_with("import ")
                || js_src[idx..].starts_with("export * from "))
        {
            let end = js_src[idx..]
                .find(';')
                .map(|p| idx + p)
                .unwrap_or(js_src.len());
            let stmt = &js_src[idx..end];
            if let Some(pos) = stmt.find("from ") {
                let after = stmt[pos + 5..].trim();
                if let Some(q) = after.chars().next().filter(|&c| c == '"' || c == '\'') {
                    if let Some(spec) = after[1..].split(q).next() {
                        out.push(spec.to_string());
                    }
                }
            } else if let Some(rest) = stmt.strip_prefix("import ") {
                let trimmed = rest.trim();
                if let Some(q) = trimmed.chars().next().filter(|&c| c == '"' || c == '\'') {
                    if let Some(spec) = trimmed[1..].split(q).next() {
                        out.push(spec.to_string());
                    }
                }
            }
            idx = end + 1;
            continue;
        }
        idx += 1;
    }
    out
}

fn seed_e2e_workspace(srv: &TestServer) {
    // 1. Notebook fixture (mirrors notebooks/custom_ui.mnb)
    let nb_json = serde_json::json!({
        "format": "minilang-notebook",
        "version": 1,
        "title": "custom_ui.mnb",
        "language": "minilang",
        "cells": [
            {
                "id": "cell-1",
                "cell_type": "code",
                "source": "var nb_answer := 42\nprintln(\"hello-from-notebook\", nb_answer)\nnb_answer",
                "execution_count": null,
                "output": null
            },
            {
                "id": "cell-2",
                "cell_type": "markdown",
                "source": "# Custom UI Notebook\nAutomated browser test fixture.",
                "execution_count": null,
                "output": null
            }
        ]
    });
    write_ws_file(
        srv,
        "notebooks/custom_ui.mnb",
        &serde_json::to_string_pretty(&nb_json).unwrap(),
    );

    // 2. Script fixture using Params
    let greet_script = [
        "let who := Params[\"name\"] or \"world\"",
        "let n := repeat or 1",
        "var msg := who",
        "for i in 1 .. n do msg := msg + \"!\" end",
        "println(msg)",
        "msg",
    ]
    .join("\n");
    write_ws_file(srv, "scripts/greet.mini", &greet_script);

    // 3. Background service fixture
    let counter_svc = r#"
var count := Params["initial"] or 0
loop
    let msg := service::recv(5000)
    if msg then
        if msg["topic"] = "inc" then
            count := count + ((msg["data"] and msg["data"]["by"]) or 1)
            service::broadcast("count_updated", {"count" is count})
        elseif msg["topic"] = "get" then
            service::reply(msg, {"count" is count})
        end
    end
end
"#;
    write_ws_file(srv, "services/counter.mini", counter_svc);

    // 4. Standalone .ui fixture connected to the background service
    let counter_ui = r#"
let lbl := ui::heading("Count: ?", 2)
service::on("counter", "count_updated", fun(data, msg) do
    lbl:set_text("Count: " + string(data["count"]))
end)
let btn := ui::button("+1", fun() do
    service::send("counter", "inc", {"by" is 1})
end)
ui::card("Shared Counter", ui::vbox(lbl, btn), on_mount is fun() do
    service::call("counter", "get", {}, fun(res, err) do
        if res then lbl:set_text("Count: " + string(res["count"])) end
    end)
end):show
"#;
    write_ws_file(srv, "ui/counter.ui", counter_ui);

    // 5. Markdown & CSV fixtures (including anchor, external, workspace, and inline-code links)
    write_ws_file(
        srv,
        "README.md",
        "# E2E Workspace\n\nSee [Details](#details), [Docs](https://example.com/docs?a=1&b=2 \"Docs\"), [Greet](scripts/greet.mini), and `[not-a-link](https://nope.test)`.\n\n## Details\n\nAutomated test fixture.\n",
    );
    write_ws_file(srv, "data.csv", "name,score\nAlice,99\nBob,87\n");
}

/// Always-on live HTTP crawl verifying the entire ES module dependency graph served by
/// `GET /` and `GET /ui/...` resolves with HTTP 200, proper MIME type, and valid syntax.
#[test]
fn test_web_live_es_module_graph_crawl() {
    let srv = TestServer::start(&[]);
    seed_e2e_workspace(&srv);

    // 1. Fetch `/` and extract `<script type="module" src="...">`
    let index_resp = srv.get("/");
    assert_eq!(index_resp.status, 200);
    let index_html = index_resp.text();
    assert!(
        index_html.contains("<script type=\"module\" src=\"/js/main.js\"></script>"),
        "index.html should load /js/main.js as an ES module"
    );

    // 2. Crawl every transitive ES module import over live HTTP from `/js/main.js`
    let mut visited: BTreeSet<String> = BTreeSet::new();
    let mut queue: VecDeque<String> = VecDeque::new();
    queue.push_back("/js/main.js".to_string());

    while let Some(url) = queue.pop_front() {
        if !visited.insert(url.clone()) {
            continue;
        }
        let resp = srv.get(&url);
        assert_eq!(
            resp.status, 200,
            "Module {} failed to serve (HTTP {})",
            url, resp.status
        );
        let ct = resp
            .headers
            .get("content-type")
            .map(String::as_str)
            .unwrap_or("");
        assert!(
            ct.contains("javascript"),
            "Module {} returned unexpected Content-Type '{}'",
            url,
            ct
        );
        let body = resp.text();
        assert!(!body.trim().is_empty(), "Module {} body is empty", url);
        for spec in extract_js_imports(&body) {
            let next_url = resolve_url_import(&url, &spec);
            if !visited.contains(&next_url) {
                queue.push_back(next_url);
            }
        }
    }

    assert!(
        visited.len() >= 20,
        "Expected at least 20 ES modules reachable from /js/main.js, found {}: {:?}",
        visited.len(),
        visited
    );

    // 3. Verify path traversal protection on /js/*
    let bad = srv.get("/js/../../Cargo.toml");
    assert_eq!(bad.status, 404);

    // 4. Verify standalone /ui/ui/counter.ui loads /js/minijs/index.js cleanly
    let ui_resp = srv.get("/ui/ui/counter.ui");
    assert_eq!(ui_resp.status, 200);
    let ui_html = ui_resp.text();
    assert!(ui_html.contains("const errMsg = null;"), "Standalone UI compile error:\n{}", ui_html);
    assert!(ui_html.contains("from \"/js/minijs/index.js\""));
}

/// Real headless browser E2E test suite (`tests/web_e2e.py`).
/// Runs automatically when Python Playwright is installed; set `REQUIRE_BROWSER_E2E=1`
/// in CI to fail if Playwright is missing.
#[test]
fn test_web_browser_e2e_automation() {
    let has_playwright = Command::new("python3")
        .args(["-c", "import playwright"])
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);

    let require = std::env::var("REQUIRE_BROWSER_E2E")
        .map(|v| v == "1" || v.eq_ignore_ascii_case("true"))
        .unwrap_or(false);

    if !has_playwright {
        if require {
            panic!(
                "REQUIRE_BROWSER_E2E=1 but Python Playwright is not installed. \
                 Install with: pip install playwright && playwright install chromium"
            );
        }
        eprintln!(
            "Skipping headless browser E2E (Python Playwright not installed; \
             install with `pip install playwright && playwright install chromium` or run `python3 tests/web_e2e.py --url ...`)."
        );
        return;
    }

    let srv = TestServer::start(&[]);
    seed_e2e_workspace(&srv);

    let script = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("tests/web_e2e.py");
    let out = Command::new("python3")
        .arg(&script)
        .arg("--url")
        .arg(format!("http://127.0.0.1:{}", srv.port))
        .output()
        .expect("failed to launch tests/web_e2e.py");

    assert!(
        out.status.success(),
        "Browser E2E suite failed!\n--- stdout ---\n{}\n--- stderr ---\n{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
}
