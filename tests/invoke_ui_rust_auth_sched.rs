mod common;

use common::TestServer;
use serde_json::json;

#[test]
fn test_invoke_minilang_all_tagged_types_functions_and_errors() {
    let srv = TestServer::start(&[]);

    std::fs::create_dir_all(srv.root.join("scripts")).unwrap();
    std::fs::write(
        srv.root.join("scripts/echo.mini"),
        r#"
fun add_pair(a, b) do
    ret a + b
end
if Params["n"] then
    {
        "direct_n" is n,
        "flag" is Params["flag"],
        "pi" is Params["pi"],
        "s" is Params["s"],
        "arg1" is Args[1],
        "list_len" is Params["xs"]:count,
        "bytes_len" is Params["raw"]:size,
        "has_uuid" is (if Params["id"] then true else false end)
    }
else
    nil
end
"#,
    )
    .unwrap();
    std::fs::write(srv.root.join("scripts/hang.mini"), "loop end\n").unwrap();
    std::fs::write(srv.root.join("scripts/fail.mini"), "1 / 0\n").unwrap();

    // GET /api/scripts lists .mini scripts
    let scripts = srv.get("/api/scripts").json();
    assert!(scripts["scripts"].as_array().unwrap().iter().any(|s| s["path"] == "scripts/echo.mini"));

    // Full tagged JSON invocation (without extension -> resolves scripts/echo.mini)
    let inv = srv.post_json(
        "/invoke/echo",
        &json!({
            "params": {
                "n": {"type": "integer", "value": 7},
                "flag": {"type": "boolean", "value": true},
                "pi": {"type": "real", "value": 3.14},
                "s": {"type": "string", "value": "hello"},
                "xs": {"type": "list", "value": [{"type": "integer", "value": 1}, {"type": "integer", "value": 2}]},
                "raw": {"type": "bytes", "value": "aGVsbG8="},
                "id": {"type": "uuid", "value": "550e8400-e29b-41d4-a716-446655440000"}
            },
            "args": [{"type": "string", "value": "positional-1"}]
        }),
    );
    assert_eq!(inv.status, 200, "{}", inv.text());
    let j = inv.json();
    assert_eq!(j["ok"], true);
    assert_eq!(j["result"]["value"]["direct_n"]["value"], 7);
    assert_eq!(j["result"]["value"]["arg1"]["value"], "positional-1");
    assert_eq!(j["result"]["value"]["bytes_len"]["value"], 5);
    assert_eq!(j["result"]["value"]["list_len"]["value"], 2);

    // Call specific function via "function"
    let fn_call = srv.post_json(
        "/invoke/scripts/echo.mini",
        &json!({
            "function": "add_pair",
            "args": [{"type": "integer", "value": 19}, {"type": "integer", "value": 23}]
        }),
    );
    assert_eq!(fn_call.status, 200, "{}", fn_call.text());
    assert_eq!(fn_call.json()["result"]["value"], 42);

    // Error status codes: 408 timeout, 422 runtime error, 404 missing, 400 bad ext
    assert_eq!(srv.post_json("/invoke/hang", &json!({"timeout_ms": 250})).status, 408);
    assert_eq!(srv.post_json("/invoke/fail", &json!({})).status, 422);
    assert_eq!(srv.post_json("/invoke/does_not_exist", &json!({})).status, 404);
    std::fs::write(srv.root.join("bad.txt"), "hi").unwrap();
    assert_eq!(srv.post_json("/invoke/bad.txt", &json!({})).status, 400);
}

#[test]
fn test_rust_kernel_streaming_invoke_and_local_cargo_dep() {
    let srv = TestServer::start(&[]);

    // 1. Rust notebook kernel + SSE streaming + Variable Inspector + Autocomplete
    srv.create_kernel("rs-1", "rust");
    let sse = srv.eval_stream(
        "rs-1",
        r#"
let base_num: i64 = 20;
println!("hello from rust stream");
progress(1.0, 2.0, "Working");
base_num + 22
"#,
    );
    assert_eq!(sse.status, 200);
    let txt = sse.text();
    assert!(txt.contains("event:status") && txt.contains("hello from rust stream") && txt.contains("42"), "{}", txt);

    // Variable persists to next cell & shows in inspect
    let r2 = srv.eval("rs-1", "base_num * 3");
    assert!(r2["error"].is_null(), "{:?}", r2);
    assert_eq!(r2["results"][0]["repr"], "60");
    let insp = srv.get("/api/kernels/rs-1/inspect").json();
    assert!(insp["variables"].as_array().unwrap().iter().any(|v| v["name"] == "base_num"));

    // 2. Local path Cargo crate compiled offline via `:dep`!
    let crate_dir = srv.root.join("my_math_crate");
    std::fs::create_dir_all(crate_dir.join("src")).unwrap();
    std::fs::write(
        crate_dir.join("Cargo.toml"),
        "[package]\nname = \"my_math_crate\"\nversion = \"0.1.0\"\nedition = \"2021\"\n",
    )
    .unwrap();
    std::fs::write(
        crate_dir.join("src/lib.rs"),
        "pub fn triple(n: i64) -> i64 { n * 3 }\n",
    )
    .unwrap();

    let dep_res = srv.eval(
        "rs-1",
        ":dep my_math_crate = { path = \"my_math_crate\" }\nmy_math_crate::triple(14)",
    );
    assert!(dep_res["error"].is_null(), "cargo dep error: {:?}", dep_res["error"]);
    assert_eq!(dep_res["results"][0]["repr"], "42");

    // 3. Invocable .rs script + named function
    std::fs::create_dir_all(srv.root.join("scripts")).unwrap();
    std::fs::write(
        srv.root.join("scripts/square.rs"),
        r#"
fn sq(n: i64) -> i64 { n * n }
let n = params.get_int("n").unwrap_or(5);
Value::map([("n", Value::int(n)), ("sq", Value::int(sq(n)))])
"#,
    )
    .unwrap();

    let inv = srv.post_json("/invoke/square", &json!({"params": {"n": {"type": "integer", "value": 9}}}));
    assert_eq!(inv.status, 200, "{}", inv.text());
    assert_eq!(inv.json()["result"]["value"]["sq"]["value"], 81);

    let inv_fn = srv.post_json(
        "/invoke/scripts/square.rs",
        &json!({"function": "sq", "args": [{"type": "integer", "value": 12}]}),
    );
    assert_eq!(inv_fn.status, 200, "{}", inv_fn.text());
    assert_eq!(inv_fn.json()["result"]["value"], 144);
}

#[test]
fn test_standalone_ui_secrets_schedules_webhooks_and_auth() {
    let srv = TestServer::start(&["--secrets-key", "e2e-test-master-key"]);

    // 1. Standalone /ui/{path} (live .ui + precompiled JSON .ui)
    std::fs::create_dir_all(srv.root.join("uis")).unwrap();
    std::fs::write(
        srv.root.join("uis/hello.ui"),
        r#"ui::show(ui::card("Demo", ui::table([{"k" is 1}]), ui::chart({"type" is "bar", "data" is [1, 2]})))"#,
    )
    .unwrap();
    let ui_page = srv.get("/ui/hello");
    assert_eq!(ui_page.status, 200);
    let ui_html = ui_page.text();
    assert!(ui_html.contains("MinijsUI.mount") && ui_html.contains("minilang-ui"));

    let uis = srv.get("/api/uis").json();
    assert!(uis["uis"].as_array().unwrap().iter().any(|u| u["path"] == "uis/hello.ui"));

    // 2. Encrypted Secrets Vault + live Minilang kernel + /invoke injection
    srv.create_kernel("sec-k", "minilang");
    let set_s = srv.put_json("/api/secrets/MY_API_KEY", &json!({"value": "top-secret-5555", "description": "API"}));
    assert_eq!(set_s.status, 200);
    assert!(!set_s.text().contains("top-secret-5555"));
    assert_eq!(set_s.json()["secret"]["masked"], "••••5555");

    let live_ev = srv.eval("sec-k", r#"secret("MY_API_KEY")"#);
    assert!(live_ev["error"].is_null());
    assert_eq!(live_ev["results"][0]["repr"], "top-secret-5555");

    std::fs::create_dir_all(srv.root.join("scripts")).unwrap();
    std::fs::write(srv.root.join("scripts/sec_echo.mini"), r#"secret("MY_API_KEY") + ":" + (Params["tag"] or "none")"#).unwrap();
    let inv_sec = srv.post_json("/invoke/sec_echo", &json!({"params": {"tag": {"type": "string", "value": "ok"}}}));
    assert_eq!(inv_sec.status, 200);
    assert_eq!(inv_sec.json()["result"]["value"], "top-secret-5555:ok");

    // 3. Schedules + Manual Run + Webhook Trigger + MLOG Log Verification
    let created = srv.post_json(
        "/api/schedules",
        &json!({"name": "Secret Echo Job", "script": "scripts/sec_echo.mini", "cron": "*/30 * * * *", "enabled": true}),
    );
    assert_eq!(created.status, 200, "{}", created.text());
    let job = created.json()["schedule"].clone();
    let job_id = job["id"].as_str().unwrap();
    let token = job["webhook_token"].as_str().unwrap();
    let log_path = job["log_path"].as_str().unwrap();

    let manual = srv.post_json(&format!("/api/schedules/{}/run", job_id), &json!({}));
    assert_eq!(manual.status, 200);
    assert_eq!(manual.json()["ok"], true);

    let hook = srv.post_json(
        &format!("/api/webhooks/{}", token),
        &json!({"params": {"tag": {"type": "string", "value": "from-hook"}}}),
    );
    assert_eq!(hook.status, 200);
    assert!(hook.json()["repr"].as_str().unwrap().contains("top-secret-5555:from-hook"));
    assert_eq!(srv.post_json("/api/webhooks/invalid-token-xyz", &json!({})).status, 404);

    let log_data = srv.get(&format!("/api/log?path={}", log_path)).json();
    assert_eq!(log_data["format"], "mlog");
    assert_eq!(log_data["total"], 2);

    assert_eq!(srv.post_json(&format!("/api/schedules/{}/toggle", job_id), &json!({})).json()["schedule"]["enabled"], false);
    assert_eq!(srv.delete(&format!("/api/schedules/{}", job_id)).json()["removed"], true);

    // 4. agy status & cancel endpoints + frontend assets
    assert_eq!(srv.get("/api/agy/status").status, 200);
    assert_eq!(srv.post_json("/api/agy/cancel", &json!({"request_id": "nonexistent"})).json()["cancelled"], false);
    assert_eq!(srv.get("/").status, 200);
    assert_eq!(srv.get("/style.css").status, 200);
    assert_eq!(srv.get("/app.js").status, 200);
    assert_eq!(srv.get("/minijs_vm.js").status, 200);

    // 5. Auth middleware enforcement (--require-login)
    let auth_srv = TestServer::start(&["--require-login", "--auth-secret", "test-jwt-secret"]);
    let st = auth_srv.get("/api/auth/status").json();
    assert_eq!(st["auth_required"], true);
    assert_eq!(st["authenticated"], false);

    // Protected endpoints must reject unauthenticated calls with 401
    assert_eq!(auth_srv.get("/api/files").status, 401);
    assert_eq!(auth_srv.get("/api/secrets").status, 401);
    assert_eq!(auth_srv.post_json("/invoke/anything", &json!({})).status, 401);

    // Browser HTML navigation to /ui/... redirects to /?next=...
    let ui_redir = auth_srv.req("GET", "/ui/demo", &[("Accept", "text/html")], &[]);
    assert_eq!(ui_redir.status, 307);
    assert!(ui_redir.headers.get("location").unwrap().starts_with("/?next="));

    // Invalid credentials -> 401
    let bad_login = auth_srv.post_json("/api/auth/login", &json!({"username": "__no_user__", "password": "wrong"}));
    assert_eq!(bad_login.status, 401);
}
