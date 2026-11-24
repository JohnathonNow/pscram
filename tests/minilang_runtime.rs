mod common;

use common::TestServer;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::thread;

fn spawn_local_http_mock() -> (u16, Arc<AtomicBool>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let handle = thread::spawn(move || {
        while !stop_flag.load(Ordering::Relaxed) {
            let mut stream = match listener.accept() {
                Ok((s, _)) => s,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(std::time::Duration::from_millis(10));
                    continue;
                }
                Err(_) => break,
            };
            let _ = stream.set_nonblocking(false);
            let _ = stream.set_read_timeout(Some(std::time::Duration::from_secs(5)));
            let mut buf = [0u8; 8192];
            let n = stream.read(&mut buf).unwrap_or(0);
            let req = String::from_utf8_lossy(&buf[..n]).into_owned();
            let first_line = req.lines().next().unwrap_or("");
            let mut parts = first_line.split_whitespace();
            let method = parts.next().unwrap_or("GET");
            let path = parts.next().unwrap_or("/");
            let body_part = req.split("\r\n\r\n").nth(1).unwrap_or("");

            let (status, ct, body) = if path.starts_with("/json") {
                (
                    "200 OK",
                    "application/json",
                    json!({ "method": method, "path": path, "body": body_part }).to_string(),
                )
            } else if path.starts_with("/text") {
                ("200 OK", "text/plain", format!("TEXT:{} {}", method, path))
            } else if path.starts_with("/status404") {
                ("404 Not Found", "text/plain", "not found here".to_string())
            } else if path.starts_with("/status500") {
                ("500 Internal Server Error", "text/plain", "boom".to_string())
            } else {
                ("200 OK", "application/octet-stream", "RAWBYTES123".to_string())
            };

            let resp = format!(
                "HTTP/1.1 {}\r\nContent-Type: {}\r\nX-Mock-Header: ok\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                ct,
                body.len(),
                body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });
    (port, stop, handle)
}

#[test]
fn test_minilang_kernel_lifecycle_inspect_complete_interrupt_restart() {
    let srv = TestServer::start(&[]);
    let st = srv.create_kernel("ml-life", "minilang");
    assert_eq!(st["alive"], true);
    assert_eq!(st["language"], "minilang");

    // Persist variables across cells
    let r1 = srv.eval("ml-life", "var counter := 10\nlet my_special_var := 42\nfun double_it(x) x * 2");
    assert!(r1["error"].is_null());
    let r2 = srv.eval("ml-life", "counter := counter + double_it(5)\ncounter");
    assert_eq!(r2["results"].as_array().unwrap().last().unwrap()["repr"], "20");

    // Inspect variables
    let insp = srv.get("/api/kernels/ml-life/inspect").json();
    let vars = insp["variables"].as_array().unwrap();
    assert!(vars.iter().any(|v| v["name"] == "counter" && v["preview"] == "20"));
    assert!(vars.iter().any(|v| v["name"] == "my_special_var"));

    // Autocomplete
    let comp = srv.post_json("/api/kernels/ml-life/complete", &json!({"prefix": "my_spec"})).json();
    assert!(comp["items"].as_array().unwrap().iter().any(|i| i["label"] == "my_special_var"));

    // Restart clears user state
    assert_eq!(srv.post_json("/api/kernels/ml-life/restart", &json!({})).status, 200);
    let after_restart = srv.eval("ml-life", "counter");
    assert!(!after_restart["error"].is_null());

    // Interrupt an infinite loop cleanly
    let port = srv.port;
    let t = thread::spawn(move || {
        thread::sleep(std::time::Duration::from_millis(300));
        if let Ok(mut s) = std::net::TcpStream::connect(format!("127.0.0.1:{}", port)) {
            let req = format!(
                "POST /api/kernels/ml-life/interrupt HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                port
            );
            let _ = s.write_all(req.as_bytes());
            let _ = s.flush();
            let mut resp_buf = Vec::new();
            let _ = s.read_to_end(&mut resp_buf);
        }
    });
    let intr = srv.eval("ml-life", "loop end");
    t.join().unwrap();
    assert_eq!(intr["error"]["error_type"], "KeyboardInterrupt");

    // Kernel auto-respawns and stays usable after interrupt
    let recovered = srv.eval("ml-life", "7 * 6");
    assert!(recovered["error"].is_null());
    assert_eq!(recovered["results"][0]["repr"], "42");

    // Delete kernel
    assert_eq!(srv.delete("/api/kernels/ml-life").status, 200);
}

#[test]
fn test_minilang_store_http_imports_and_logs() {
    let srv = TestServer::start(&[]);
    srv.create_kernel("ml-io", "minilang");

    // 1. store module (CBOR, raw/bytes, string/text, create, exists, delete)
    let store_code = r#"
let v := {"a" is 1, "b" is [true, "hi", 3.5]}
store::put("data/val.cbor", v)
let v2 := store::get("data/val.cbor")
var calls := 0
let c1 := store::create("data/cached.cbor"; p) do
    calls := calls + 1
    {"path" is p, "n" is 77}
end
let c2 := store::create("data/cached.cbor"; p) do
    calls := calls + 1
    {"path" is p, "n" is 999}
end
store::put_string("data/note.txt", "hello text")
let s1 := store::get_text("data/note.txt")
store::put_raw("data/raw.bin", "ABCD")
let b1 := store::get_bytes("data/raw.bin")
let ex1 := store::exists("data/raw.bin")
let del := store::delete("data/raw.bin")
let ex2 := store::exists("data/raw.bin")
{
    "cbor_ok" is (v2["a"] = 1 and v2["b"][2] = "hi"),
    "cache_calls" is calls,
    "cache_val" is c2["n"],
    "str" is s1,
    "raw_len" is b1:size,
    "existed" is (if ex1 then true else false end),
    "deleted" is (if del = true then (if ex2 then false else true end) else false end)
}
"#;
    let res = srv.eval("ml-io", store_code);
    assert!(res["error"].is_null(), "store error: {:?}", res["error"]);
    let repr = res["results"].as_array().unwrap().last().unwrap()["repr"].as_str().unwrap();
    assert!(repr.contains("cache_calls is 1"), "{}", repr);
    assert!(repr.contains("cache_val is 77"), "{}", repr);
    assert!(repr.contains("str is hello text"), "{}", repr);
    assert!(repr.contains("raw_len is 4"), "{}", repr);
    assert!(repr.contains("deleted is true"), "{}", repr);

    // 2. http module against local mock HTTP server
    let (mock_port, mock_stop, mock_handle) = spawn_local_http_mock();
    let http_code = format!(r#"
let j := http::get("http://127.0.0.1:{p}/json", "json", {{"q" is "a b", "tag" is ["x", "y"]}}, {{"X-Test" is "1"}})
let t := http::get("http://127.0.0.1:{p}/text", "text")
let r := http::get("http://127.0.0.1:{p}/raw", "raw")
let f := http::get("http://127.0.0.1:{p}/raw", "file", file is "data/dl.bin")
f:close
let dl := store::get_string("data/dl.bin")
let p1 := http::post("http://127.0.0.1:{p}/json", "json", nil, nil, {{"hello" is 42}})
let resp404 := http::get("http://127.0.0.1:{p}/status404", "response")
let put_r := http::put("http://127.0.0.1:{p}/json", "json", nil, nil, "plain")
let del_r := http::delete("http://127.0.0.1:{p}/text", "text")
{{
    "get_path" is j["path"],
    "text" is t,
    "raw_size" is r:size,
    "dl" is dl,
    "post_method" is p1["method"],
    "post_body" is p1["body"],
    "st404" is resp404["status"],
    "hdr" is resp404["headers"]["x-mock-header"],
    "put_m" is put_r["method"],
    "del_t" is del_r
}}
"#, p = mock_port);
    let hres = srv.eval("ml-io", &http_code);
    mock_stop.store(true, Ordering::Relaxed);
    mock_handle.join().unwrap();
    assert!(hres["error"].is_null(), "http error: {:?}", hres["error"]);
    let hrepr = hres["results"].as_array().unwrap().last().unwrap()["repr"].as_str().unwrap();
    assert!(hrepr.contains("tag=x") && hrepr.contains("tag=y"), "{}", hrepr);
    assert!(hrepr.contains("dl is RAWBYTES123"), "{}", hrepr);
    assert!(hrepr.contains("post_method is POST"), "{}", hrepr);
    assert!(hrepr.contains("st404 is 404"), "{}", hrepr);
    assert!(hrepr.contains("hdr is ok"), "{}", hrepr);
    assert!(hrepr.contains("put_m is PUT"), "{}", hrepr);

    // 3. import / export + string(import)
    std::fs::create_dir_all(srv.root.join("mods")).unwrap();
    std::fs::write(srv.root.join("mods/calc.mini"), "export: let FACTOR := 3\nexport: fun mul(x) x * FACTOR\n").unwrap();
    let imp_code = r#"
import: c1("./mods/calc")
import: c2("./mods/calc.mini")
let dir_str := string(import)
let interp := '{import}/mods/calc.mini'
{"a" is c1::mul(7), "b" is c2::FACTOR, "has_dir" is (if dir_str:length > 0 then true else false end), "interp_ok" is (if store::exists(interp) then true else false end)}
"#;
    let ires = srv.eval("ml-io", imp_code);
    assert!(ires["error"].is_null(), "import error: {:?}", ires["error"]);
    let irepr = ires["results"].as_array().unwrap().last().unwrap()["repr"].as_str().unwrap();
    assert!(irepr.contains("a is 21") && irepr.contains("b is 3") && irepr.contains("interp_ok is true"), "{}", irepr);

    // 4. First-class log type (in-memory + persistent MLOG + Log Viewer API)
    let log_code = r#"
let mem := log()
mem("hello", 123)
mem:put({"k" is "v"})
let p := log("logs/events.mlog", "w")
p({"level" is "info", "msg" is "started", "n" is 1})
p:push({"level" is "warn", "msg" is "slow", "n" is 2})
p:write({"level" is "error", "msg" is "failed", "n" is 3})
p:flush
let ro := log("logs/events.mlog", "r")
p({"level" is "info", "msg" is "recovered", "n" is 4})
let added := ro:reload
let vals := list(ro; v) v["n"]
let slice := ro[2, 4]
p:close
ro:close
{
    "mem_count" is mem:count,
    "ro_count" is ro:count,
    "added" is added,
    "first_n" is ro:first["n"],
    "last_n" is ro:last["n"],
    "neg_idx" is ro[-1]["msg"],
    "vals" is vals,
    "slice_len" is slice:count
}
"#;
    let lres = srv.eval("ml-io", log_code);
    assert!(lres["error"].is_null(), "log error: {:?}", lres["error"]);
    let lrepr = lres["results"].as_array().unwrap().last().unwrap()["repr"].as_str().unwrap();
    assert!(lrepr.contains("mem_count is 3") && lrepr.contains("ro_count is 4") && lrepr.contains("added is 1"), "{}", lrepr);
    assert!(lrepr.contains("neg_idx is recovered") && lrepr.contains("slice_len is 2"), "{}", lrepr);

    // Log Viewer API reads the binary MLOG file written by Minilang!
    let lv = srv.get("/api/log?path=logs/events.mlog&q=slow").json();
    assert_eq!(lv["format"], "mlog");
    assert_eq!(lv["total"], 4);
    assert_eq!(lv["filtered"], 1);
    assert_eq!(lv["entries"][0]["level"], "warn");
}

#[test]
fn test_minilang_sqlite_db_rich_displays_and_sse_streaming() {
    let srv = TestServer::start(&[]);
    srv.create_kernel("ml-db", "minilang");

    // SQLite transactions, positional + named binds, shorthand db::query/exec, BLOB & NULL
    let db_code = r#"
let conn := db::open("app.sqlite")
conn:exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, score REAL, bio TEXT)")
conn:begin
conn:exec("INSERT INTO users (name, score, bio) VALUES (?, ?, ?)", ["Temp", 1.0, nil])
conn:rollback
conn:begin
conn:exec("INSERT INTO users (name, score, bio) VALUES (?, ?, ?)", ["Ada", 98.5, "Mathematician"])
conn:exec("INSERT INTO users (name, score, bio) VALUES (:name, :score, :bio)", {"name" is "Grace", "score" is 99.5, "bio" is nil})
conn:commit
let rows := conn:query("SELECT name, score, bio FROM users ORDER BY id")
let one := conn:one("SELECT COUNT(*) AS n FROM users")
let tbls := conn:tables
let sch := conn:schema("users")
conn:close
let quick := db::query("app.sqlite", "SELECT name FROM users WHERE score > ?", [99.0])
{
    "count" is one["n"],
    "first" is rows[1]["name"],
    "second_bio_nil" is (if rows[2]["bio"] then false else true end),
    "tables" is tbls,
    "schema_len" is sch:count,
    "quick" is quick[1]["name"]
}
"#;
    let dres = srv.eval("ml-db", db_code);
    assert!(dres["error"].is_null(), "db error: {:?}", dres["error"]);
    let drepr = dres["results"].as_array().unwrap().last().unwrap()["repr"].as_str().unwrap();
    assert!(drepr.contains("count is 2") && drepr.contains("first is Ada") && drepr.contains("second_bio_nil is true") && drepr.contains("quick is Grace"), "{}", drepr);

    // SQLite Browser API
    let schema = srv.get("/api/sqlite/schema?path=app.sqlite").json();
    assert_eq!(schema["tables"][0]["name"], "users");
    assert_eq!(schema["tables"][0]["row_count"], 2);

    let q_ok = srv.post_json("/api/sqlite/query", &json!({"path": "app.sqlite", "sql": "SELECT name FROM users ORDER BY score DESC"}));
    assert_eq!(q_ok.status, 200);
    assert_eq!(q_ok.json()["rows"][0][0], "Grace");

    // Read-only default blocks writes; allow_write=true permits writes
    assert_eq!(srv.post_json("/api/sqlite/query", &json!({"path": "app.sqlite", "sql": "DELETE FROM users"})).status, 400);
    let q_wr = srv.post_json("/api/sqlite/query", &json!({"path": "app.sqlite", "sql": "DELETE FROM users WHERE name = 'Ada'", "allow_write": true}));
    assert_eq!(q_wr.status, 200);
    assert_eq!(q_wr.json()["changes"], 1);

    // Rich outputs: table(), chart(), ui::table, ui::chart, SSE streaming + progress()
    let sse = srv.eval_stream(
        "ml-db",
        r#"
println("chunk A")
progress(1, 3, "Loading")
table([{"k" is "x", "v" is 10}, {"k" is "y", "v" is 20}], "Metrics")
chart({"type" is "line", "title" is "Trend", "data" is [1, 3, 2, 5]})
progress(3, 3, "Complete")
println("chunk B")
"done"
"#,
    );
    assert_eq!(sse.status, 200);
    let txt = sse.text();
    assert!(txt.contains("event:stdout") && txt.contains("chunk A") && txt.contains("chunk B"), "{}", txt);
    assert!(txt.contains("event:progress") && txt.contains("Loading") && txt.contains("Complete"), "{}", txt);
    assert!(txt.contains("application/vnd.minilang.table+json") && txt.contains("Metrics"), "{}", txt);
    assert!(txt.contains("application/vnd.minilang.chart+json") && txt.contains("Trend"), "{}", txt);
    assert!(txt.contains("event:result") && txt.contains("\"done\""), "{}", txt);

    // SQLite Cluster Graph API: scalar 2D + string color grouping, multidimensional JSON & BLOB vectors (PCA, t-SNE, K-Means+PCA, Per-Col PCA), continuous colors, and full row payloads
    let seed_cluster = r#"
let cdb := db::open("clusters.sqlite")
cdb:exec("CREATE TABLE embeddings (id INTEGER PRIMARY KEY, label TEXT, category TEXT, metric REAL, x REAL, y REAL, vec_json TEXT, vec_y TEXT, vec_blob BLOB)")
cdb:begin
for i in 1 .. 24 do
    let grp := if i <= 8 then "alpha" elseif i <= 16 then "beta" else "gamma" end
    let base := if i <= 8 then 10.0 elseif i <= 16 then 50.0 else 90.0 end
    let vx := base + (i % 5) * 1.1
    let vy := base * 0.5 + (i % 4) * 1.3
    let jv := '[{vx}, {vy}, {vx * 0.3 + 2.0}, {vy * 0.7 - 1.0}, {base * 0.2}]'
    let jvy := '[{vy}, {vx * 0.4}, {base * 0.1 + i}]'
    cdb:exec(
        "INSERT INTO embeddings (id, label, category, metric, x, y, vec_json, vec_y, vec_blob) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [i, 'row-{i}', (if i = 24 then nil else grp end), i * 1.5, vx, vy, jv, jvy, nil]
    )
end
cdb:commit
cdb:close
"seeded"
"#;
    let sc_res = srv.eval("ml-db", seed_cluster);
    assert!(sc_res["error"].is_null(), "seed cluster db error: {:?}", sc_res["error"]);

    // 1. Direct 2 scalar columns + arbitrary string color column (with NULL)
    let cl_direct = srv.post_json(
        "/api/sqlite/cluster",
        &json!({
            "path": "clusters.sqlite",
            "table": "embeddings",
            "x_col": "x",
            "y_col": "y",
            "color_col": "category",
            "algorithm": "auto"
        }),
    );
    assert_eq!(cl_direct.status, 200, "{}", cl_direct.text());
    let jd = cl_direct.json();
    assert_eq!(jd["algorithm_used"], "direct");
    assert_eq!(jd["points"].as_array().unwrap().len(), 24);
    assert_eq!(jd["rows"].as_array().unwrap().len(), 24);
    assert_eq!(jd["columns"].as_array().unwrap().len(), 9);
    assert_eq!(jd["color"]["mode"], "categorical");
    let cats = jd["color"]["categories"].as_array().unwrap();
    assert!(cats.iter().any(|c| c["label"] == "alpha"));
    assert!(cats.iter().any(|c| c["label"] == "beta"));
    assert!(cats.iter().any(|c| c["label"] == "(NULL)"));

    // 2. Multidimensional JSON vectors with Auto -> PCA 2D & continuous numeric color column
    let cl_pca = srv.post_json(
        "/api/sqlite/cluster",
        &json!({
            "path": "clusters.sqlite",
            "table": "embeddings",
            "x_col": "vec_json",
            "y_col": "vec_y",
            "color_col": "metric",
            "algorithm": "auto"
        }),
    );
    assert_eq!(cl_pca.status, 200, "{}", cl_pca.text());
    let jp = cl_pca.json();
    assert_eq!(jp["algorithm_used"], "pca");
    assert_eq!(jp["x_dim"], 5);
    assert_eq!(jp["y_dim"], 3);
    assert_eq!(jp["total_dim"], 8);
    assert_eq!(jp["color"]["mode"], "continuous");
    assert!(jp["explained_variance"].is_array());

    // 3. K-Means + PCA clustering on single multidimensional embedding column
    let cl_km = srv.post_json(
        "/api/sqlite/cluster",
        &json!({
            "path": "clusters.sqlite",
            "table": "embeddings",
            "x_col": "vec_json",
            "y_col": "__same__",
            "color_col": "__cluster__",
            "algorithm": "kmeans_pca",
            "k": 3
        }),
    );
    assert_eq!(cl_km.status, 200, "{}", cl_km.text());
    let jk = cl_km.json();
    assert_eq!(jk["algorithm_used"], "kmeans_pca");
    assert_eq!(jk["color"]["mode"], "cluster");
    assert_eq!(jk["centroids"].as_array().unwrap().len(), 3);

    // 4. t-SNE 2D & Per-Column PCA
    let cl_tsne = srv.post_json(
        "/api/sqlite/cluster",
        &json!({
            "path": "clusters.sqlite",
            "table": "embeddings",
            "x_col": "vec_json",
            "color_col": "category",
            "algorithm": "tsne"
        }),
    );
    assert_eq!(cl_tsne.status, 200, "{}", cl_tsne.text());
    assert_eq!(cl_tsne.json()["algorithm_used"], "tsne");

    let cl_per = srv.post_json(
        "/api/sqlite/cluster",
        &json!({
            "path": "clusters.sqlite",
            "table": "embeddings",
            "x_col": "vec_json",
            "y_col": "vec_y",
            "color_col": "category",
            "algorithm": "per_col_pca"
        }),
    );
    assert_eq!(cl_per.status, 200, "{}", cl_per.text());
    assert_eq!(cl_per.json()["algorithm_used"], "per_col_pca");
}
