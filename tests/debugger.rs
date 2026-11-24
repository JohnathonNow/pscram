mod common;

use common::TestServer;
use serde_json::{json, Value};

fn find_local<'a>(locals: &'a [Value], name: &str) -> Option<&'a Value> {
    locals.iter().find(|v| v["name"].as_str() == Some(name))
}

fn write_ws_file(srv: &TestServer, rel: &str, content: &str) {
    let full = srv.root.join(rel);
    if let Some(p) = full.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(full, content).unwrap();
}

#[test]
fn test_debug_breakpoints_locals_and_dynamic_update() {
    let srv = TestServer::start(&[]);

    // Write a multi-line Minilang script
    let script = [
        "var total := 0",
        "for i in 1 .. 4 do",
        "    total := total + i",
        "    println(\"step\", i, total)",
        "end",
        "total * 10",
    ]
    .join("\n");
    write_ws_file(&srv, "scripts/sum.mini", &script);

    // Start with breakpoint at line 3 (`total := total + i`), stop_on_entry = false
    let r = srv.post_json(
        "/api/debug/start",
        &json!({
            "path": "scripts/sum.mini",
            "breakpoints": { "scripts/sum.mini": [3] },
            "stop_on_entry": false,
            "break_on_error": true
        }),
    );
    assert_eq!(r.status, 200, "start failed: {}", r.text());
    let body = r.json();
    let sess = &body["session"];
    let id = sess["id"].as_str().expect("session id").to_string();

    assert_eq!(sess["status"], "paused");
    assert_eq!(sess["reason"], "breakpoint");
    assert_eq!(sess["current_source"], "scripts/sum.mini");
    assert_eq!(sess["current_line"], 3);

    // Before line 3 runs on first iteration: total == 0, i == 1
    let locals = sess["locals"].as_array().expect("locals array");
    assert_eq!(find_local(locals, "total").unwrap()["value"], "0");
    assert_eq!(find_local(locals, "i").unwrap()["value"], "1");

    // Continue -> should hit line 3 again on iteration 2 (total == 1, i == 2)
    let r2 = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "continue" }));
    assert_eq!(r2.status, 200);
    let s2 = &r2.json()["session"];
    assert_eq!(s2["status"], "paused");
    assert_eq!(s2["current_line"], 3);
    assert!(s2["stdout"].as_str().unwrap_or("").contains("step 1 1"));
    let locals2 = s2["locals"].as_array().unwrap();
    assert_eq!(find_local(locals2, "total").unwrap()["value"], "1");
    assert_eq!(find_local(locals2, "i").unwrap()["value"], "2");

    // Dynamically move breakpoint from line 3 to line 6 (`total * 10`)
    let bp_r = srv.post_json(
        &format!("/api/debug/{}/breakpoints", id),
        &json!({ "source": "scripts/sum.mini", "lines": [6] }),
    );
    assert_eq!(bp_r.status, 200);

    // Continue -> skips remaining iterations of line 3 and pauses at line 6 with total == 10
    let r3 = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "continue" }));
    assert_eq!(r3.status, 200);
    let s3 = &r3.json()["session"];
    assert_eq!(s3["status"], "paused");
    assert_eq!(s3["current_line"], 6);
    let locals3 = s3["locals"].as_array().unwrap();
    assert_eq!(find_local(locals3, "total").unwrap()["value"], "10");

    // Continue to completion -> result should be 100
    let r4 = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "continue" }));
    assert_eq!(r4.status, 200);
    let s4 = &r4.json()["session"];
    assert_eq!(s4["status"], "completed");
    assert_eq!(s4["result"]["repr"], "100");
    assert_eq!(s4["result"]["type_name"], "integer");
    assert!(s4["stdout"].as_str().unwrap().contains("step 4 10"));
}

#[test]
fn test_debug_stepping_call_stack_and_frame_eval() {
    let srv = TestServer::start(&[]);

    let code = [
        "fun compute(n) do",
        "    let doubled := n * 2",
        "    let boosted := doubled + 5",
        "    ret boosted",
        "end",
        "var base := 10",
        "var ans := compute(base)",
        "ans + 1",
    ]
    .join("\n");

    // Start with stop_on_entry = true
    let r = srv.post_json(
        "/api/debug/start",
        &json!({
            "source": "inline_cell.mini",
            "code": code,
            "stop_on_entry": true,
            "break_on_error": true
        }),
    );
    assert_eq!(r.status, 200, "start failed: {}", r.text());
    let mut sess = r.json()["session"].clone();
    let id = sess["id"].as_str().unwrap().to_string();
    assert_eq!(sess["status"], "paused");

    // Step over until we reach line 7 (`var ans := compute(base)`)
    let mut guard = 0;
    while sess["current_line"].as_u64() != Some(7) && guard < 10 {
        let step_r = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "step_over" }));
        assert_eq!(step_r.status, 200);
        sess = step_r.json()["session"].clone();
        assert_eq!(sess["status"], "paused");
        guard += 1;
    }
    assert_eq!(sess["current_line"], 7, "expected to pause on call line 7, got {:?}", sess);

    // Step IN into `compute(base)` -> should enter `compute` with >= 2 stack frames!
    let in_r = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "step_in" }));
    assert_eq!(in_r.status, 200);
    sess = in_r.json()["session"].clone();
    assert_eq!(sess["status"], "paused");
    let frames = sess["frames"].as_array().unwrap();
    assert!(frames.len() >= 2, "expected at least 2 frames, got {:?}", frames);
    assert_eq!(frames[1]["line"], 7);

    // Step over until line 3 (`let boosted := doubled + 5`), where `doubled == 20`
    let mut inner_guard = 0;
    while sess["current_line"].as_u64() != Some(3) && inner_guard < 5 {
        let ov_r = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "step_over" }));
        assert_eq!(ov_r.status, 200);
        sess = ov_r.json()["session"].clone();
        assert_eq!(sess["status"], "paused");
        inner_guard += 1;
    }
    assert_eq!(sess["current_line"], 3, "expected line 3 inside compute, got {:?}", sess);

    // Inspect locals of frame 0 (`compute`)
    let loc0 = srv.get(&format!("/api/debug/{}/locals?depth=0", id)).json();
    let l0 = loc0["locals"].as_array().unwrap();
    assert_eq!(find_local(l0, "n").unwrap()["value"], "10");
    assert_eq!(find_local(l0, "doubled").unwrap()["value"], "20");

    // Inspect locals of frame 1 (caller)
    let loc1 = srv.get(&format!("/api/debug/{}/locals?depth=1", id)).json();
    let l1 = loc1["locals"].as_array().unwrap();
    assert_eq!(find_local(l1, "base").unwrap()["value"], "10");

    // Evaluate expression in frame 0 referencing locals `n` and `doubled`
    let ev0 = srv
        .post_json(
            &format!("/api/debug/{}/eval", id),
            &json!({ "expr": "doubled + n + 7", "depth": 0 }),
        )
        .json();
    assert_eq!(ev0["ok"], true, "eval0 failed: {:?}", ev0);
    assert_eq!(ev0["result"]["repr"], "37");

    // Evaluate expression in caller frame 1 referencing `base`
    let ev1 = srv
        .post_json(
            &format!("/api/debug/{}/eval", id),
            &json!({ "expr": "base * 3", "depth": 1 }),
        )
        .json();
    assert_eq!(ev1["ok"], true, "eval1 failed: {:?}", ev1);
    assert_eq!(ev1["result"]["repr"], "30");

    // Step OUT of `compute` back to caller, then continue to completion
    let out_r = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "step_out" }));
    assert_eq!(out_r.status, 200);
    sess = out_r.json()["session"].clone();
    assert_eq!(sess["status"], "paused");

    let fin_r = srv.post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "continue" }));
    assert_eq!(fin_r.status, 200);
    let fin = &fin_r.json()["session"];
    assert_eq!(fin["status"], "completed");
    assert_eq!(fin["result"]["repr"], "26");
}

#[test]
fn test_debug_explicit_break_and_break_on_error() {
    let srv = TestServer::start(&[]);

    // 1. Explicit `break()` statement
    let break_code = [
        "var x := 41",
        "break()",
        "x := x + 1",
        "x",
    ]
    .join("\n");
    let r = srv.post_json(
        "/api/debug/start",
        &json!({
            "source": "brk.mini",
            "code": break_code,
            "stop_on_entry": false,
            "break_on_error": false
        }),
    );
    assert_eq!(r.status, 200);
    let s = &r.json()["session"];
    let id = s["id"].as_str().unwrap().to_string();
    assert_eq!(s["status"], "paused");
    assert_eq!(s["reason"], "break");
    assert_eq!(s["current_line"], 2);
    assert_eq!(find_local(s["locals"].as_array().unwrap(), "x").unwrap()["value"], "41");

    let c = srv
        .post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "continue" }))
        .json();
    assert_eq!(c["session"]["status"], "completed");
    assert_eq!(c["session"]["result"]["repr"], "42");

    // 2. Break on runtime error
    let err_code = [
        "var a := 10",
        "var b := 0",
        "let boom := a / b",
        "boom",
    ]
    .join("\n");
    let er = srv.post_json(
        "/api/debug/start",
        &json!({
            "source": "err.mini",
            "code": err_code,
            "stop_on_entry": false,
            "break_on_error": true
        }),
    );
    assert_eq!(er.status, 200);
    let es = &er.json()["session"];
    let eid = es["id"].as_str().unwrap().to_string();
    assert_eq!(es["status"], "paused");
    assert_eq!(es["reason"], "error");
    assert!(es["error"].is_object(), "expected error details: {:?}", es);
    // Inspect local variables at crash site!
    let elocals = es["locals"].as_array().unwrap();
    assert_eq!(find_local(elocals, "a").unwrap()["value"], "10");
    assert_eq!(find_local(elocals, "b").unwrap()["value"], "0");

    // Continue past error -> finishes in error status
    let efin = srv
        .post_json(&format!("/api/debug/{}/step", eid), &json!({ "action": "continue" }))
        .json();
    assert_eq!(efin["session"]["status"], "error");
}

#[test]
fn test_debug_imported_module_terminate_and_ui_assets() {
    let srv = TestServer::start(&[]);

    write_ws_file(
        &srv,
        "scripts/helper.mini",
        "export: fun triple(v) do\n    let out := v * 3\n    ret out\nend\n",
    );
    write_ws_file(
        &srv,
        "scripts/main.mini",
        "let h := import(\"./helper.mini\")\nlet res := h::triple(7)\nres\n",
    );

    // Set a breakpoint inside the imported module `scripts/helper.mini` line 2!
    let r = srv.post_json(
        "/api/debug/start",
        &json!({
            "path": "scripts/main.mini",
            "breakpoints": { "scripts/helper.mini": [2] },
            "stop_on_entry": false,
            "break_on_error": true
        }),
    );
    assert_eq!(r.status, 200, "start failed: {}", r.text());
    let s = &r.json()["session"];
    let id = s["id"].as_str().unwrap().to_string();
    assert_eq!(s["status"], "paused");
    assert_eq!(s["current_source"], "scripts/helper.mini");
    assert_eq!(s["current_line"], 2);
    assert_eq!(find_local(s["locals"].as_array().unwrap(), "v").unwrap()["value"], "7");

    // List active debug sessions
    let list = srv.get("/api/debug/sessions").json();
    assert_eq!(list["active"], 1);

    // Terminate the paused debug session cleanly
    let del = srv.delete(&format!("/api/debug/{}", id));
    assert_eq!(del.status, 200);
    assert_eq!(del.json()["session"]["status"], "terminated");

    let list_after = srv.get("/api/debug/sessions").json();
    assert_eq!(list_after["active"], 0);

    // Verify UI assets expose debugger drawer & controls + Params editors
    let html = srv.get("/").text();
    assert!(html.contains("id=\"debug-drawer\""));
    assert!(html.contains("id=\"btn-toggle-debug\""));
    assert!(html.contains("id=\"ftb-debug\""));
    assert!(html.contains("id=\"ftb-params\""));
    assert!(html.contains("id=\"file-params-panel\""));
    assert!(html.contains("id=\"dbg-params-textarea\""));
    assert!(html.contains("id=\"dbg-eval-form\""));
}

#[test]
fn test_run_and_debug_with_params() {
    let srv = TestServer::start(&[]);

    let script = [
        "let who := Params[\"name\"] or \"world\"",
        "let n := repeat or 1",
        "var msg := who",
        "for i in 1 .. n do msg := msg + \"!\" end",
        "println(msg)",
        "msg",
    ]
    .join("\n");
    write_ws_file(&srv, "scripts/param_test.mini", &script);

    // 1. Run via POST /api/kernels/:id/execute with plain + tagged JSON Params
    srv.create_kernel("param-run-k", "minilang");
    let run_resp = srv.post_json(
        "/api/kernels/param-run-k/execute",
        &json!({
            "code": script,
            "source": "param_test.mini",
            "language": "minilang",
            "params": {
                "name": "Ada",
                "repeat": { "type": "integer", "value": 3 }
            }
        }),
    );
    assert_eq!(run_resp.status, 200, "execute with params failed: {}", run_resp.text());
    let run_body = run_resp.json();
    assert!(run_body["error"].is_null(), "unexpected error: {:?}", run_body["error"]);
    assert!(run_body["stdout"].as_str().unwrap_or("").contains("Ada!!!"));

    // 2. Debug via POST /api/debug/start with Params, inspect locals + eval Params at breakpoint
    let dbg_resp = srv.post_json(
        "/api/debug/start",
        &json!({
            "path": "scripts/param_test.mini",
            "params": {
                "name": "Grace",
                "repeat": 2
            },
            "breakpoints": { "scripts/param_test.mini": [5] },
            "stop_on_entry": false,
            "break_on_error": true
        }),
    );
    assert_eq!(dbg_resp.status, 200, "debug start with params failed: {}", dbg_resp.text());
    let sess = &dbg_resp.json()["session"];
    let id = sess["id"].as_str().unwrap().to_string();
    assert_eq!(sess["status"], "paused");
    assert_eq!(sess["current_line"], 5);

    let locals = sess["locals"].as_array().unwrap();
    assert_eq!(find_local(locals, "who").unwrap()["value"], "Grace");
    assert_eq!(find_local(locals, "msg").unwrap()["value"], "Grace!!");

    // Debug Console can also inspect Params directly
    let ev = srv
        .post_json(
            &format!("/api/debug/{}/eval", id),
            &json!({ "expr": "Params[\"name\"]", "depth": 0 }),
        )
        .json();
    assert_eq!(ev["ok"], true);
    assert_eq!(ev["result"]["repr"], "Grace");

    // Continue to completion
    let fin = srv
        .post_json(&format!("/api/debug/{}/step", id), &json!({ "action": "continue" }))
        .json();
    assert_eq!(fin["session"]["status"], "completed");
    assert_eq!(fin["session"]["result"]["repr"], "Grace!!");
    assert!(fin["session"]["stdout"].as_str().unwrap().contains("Grace!!"));
}
