mod common;

use common::TestServer;
use serde_json::json;

#[test]
fn test_minilang_jobs_module_start_wait_progress_output_stop_and_clear() {
    let srv = TestServer::start(&[]);
    srv.create_kernel("jobs-nb", "minilang");

    std::fs::create_dir_all(srv.root.join("scripts")).unwrap();
    // Fast worker script that prints stdout, updates progress, and returns a map
    std::fs::write(
        srv.root.join("scripts/worker.mini"),
        r#"
let n := Params["n"] or 3
let label := Params["label"] or "job"
println('starting {label}')
var total := 0
for i in 1 .. n do
    total := total + i
    progress(i, n, 'Step {i}/{n}')
end
println('finished {label}')
{"label" is label, "sum" is total}
"#,
    )
    .unwrap();

    // Long-running worker script to verify live running status & cancellation via jobs::stop
    std::fs::write(
        srv.root.join("scripts/long_worker.mini"),
        r#"
println("long_started")
for i in 1 .. 100 do
    progress(i, 100, 'tick {i}')
    sleep(0.1)
end
"completed"
"#,
    )
    .unwrap();

    // 1. Launch from Minilang with params + named `name`, wait for result, inspect output & list
    let run_code = r#"
let j := jobs::start("scripts/worker.mini", {"n" is 5, "label" is "alpha"}, name is "AlphaSum")
let id := j:id
let res := j:wait(10000)
let out := j:stdout
let st := j:status
let all := jobs::list()
{
    "id" is id,
    "sum" is res["sum"],
    "label" is res["label"],
    "status" is st["status"],
    "has_out" is (if out:find("finished alpha") then true else false end),
    "list_len" is all:count
}
"#;
    let ev = srv.eval("jobs-nb", run_code);
    assert!(ev["error"].is_null(), "jobs::start error: {:?}", ev["error"]);
    let repr = ev["results"].as_array().unwrap().last().unwrap()["repr"].as_str().unwrap();
    assert!(repr.contains("sum is 15"), "{}", repr);
    assert!(repr.contains("label is alpha"), "{}", repr);
    assert!(repr.contains("status is completed"), "{}", repr);
    assert!(repr.contains("has_out is true"), "{}", repr);
    assert!(repr.contains("list_len is 1"), "{}", repr);

    // 2. Verify MLOG file was generated and is readable via /api/log
    let list_api = srv.get("/api/jobs").json();
    assert_eq!(list_api["total"], 1);
    let log_path = list_api["jobs"][0]["log_path"].as_str().unwrap();
    let log_view = srv.get(&format!("/api/log?path={}", log_path)).json();
    assert_eq!(log_view["format"], "mlog");
    assert_eq!(log_view["total"], 1);

    // 3. Launch long-running job, verify it reports running, then cancel via j:stop
    let cancel_code = r#"
let lg := jobs::start("scripts/long_worker.mini", nil, "LongTask")
sleep(0.25)
let was_running := (if lg:running then true else false end)
let stopped := lg:stop
let still_running := (if lg:running then true else false end)
{
    "was_running" is was_running,
    "stopped_status" is stopped["status"],
    "still_running" is still_running
}
"#;
    let ev2 = srv.eval("jobs-nb", cancel_code);
    assert!(ev2["error"].is_null(), "jobs::stop error: {:?}", ev2["error"]);
    let repr2 = ev2["results"].as_array().unwrap().last().unwrap()["repr"].as_str().unwrap();
    assert!(repr2.contains("was_running is true"), "{}", repr2);
    assert!(repr2.contains("stopped_status is cancelled"), "{}", repr2);
    assert!(repr2.contains("still_running is false"), "{}", repr2);

    // 4. Clear finished jobs via jobs::clear()
    let ev3 = srv.eval("jobs-nb", "jobs::clear()");
    assert!(ev3["error"].is_null());
    let after_clear = srv.get("/api/jobs").json();
    assert_eq!(after_clear["total"], 0);
}

#[test]
fn test_jobs_rest_api_sessions_management_and_ui_assets() {
    let srv = TestServer::start(&[]);
    srv.create_kernel("sess-a", "minilang");
    srv.create_kernel("sess-b", "rust");

    // Sessions listing returns both active kernels
    let ks = srv.get("/api/kernels").json();
    let arr = ks["kernels"].as_array().unwrap();
    assert_eq!(arr.len(), 2);
    assert!(arr.iter().any(|k| k["id"] == "sess-a" && k["language"] == "minilang"));
    assert!(arr.iter().any(|k| k["id"] == "sess-b" && k["language"] == "rust"));

    // Launch job directly via POST /api/jobs with plain JSON params
    std::fs::create_dir_all(srv.root.join("scripts")).unwrap();
    std::fs::write(
        srv.root.join("scripts/ui_job.mini"),
        r#"let x := Params["x"] or 1; println('x={x}'); x * 10"#,
    )
    .unwrap();

    let started = srv.post_json(
        "/api/jobs",
        &json!({"script": "scripts/ui_job.mini", "name": "UI Launch", "params": {"x": 7}, "source": "ui"}),
    );
    assert_eq!(started.status, 200, "{}", started.text());
    let job_id = started.json()["job"]["id"].as_str().unwrap().to_string();

    let waited = srv.post_json(&format!("/api/jobs/{}/wait", job_id), &json!({"timeout_ms": 5000}));
    assert_eq!(waited.status, 200);
    let wj = waited.json()["job"].clone();
    assert_eq!(wj["status"], "completed");
    assert_eq!(wj["result_plain"], 70);
    assert!(wj["stdout"].as_str().unwrap().contains("x=7"));

    // Delete job & kill session
    assert_eq!(srv.delete(&format!("/api/jobs/{}", job_id)).json()["removed"], true);
    assert_eq!(srv.delete("/api/kernels/sess-b").json()["ok"], true);
    assert_eq!(srv.get("/api/kernels").json()["kernels"].as_array().unwrap().len(), 1);

    // Verify Jobs & Sessions Manager UI markup & handlers are served
    let html = srv.get("/").text();
    assert!(html.contains("jobs-modal-overlay") && html.contains("btn-open-jobs") && html.contains("sessions-list"));
    let js = srv.get("/app.js").text();
    assert!(js.contains("openJobsModal") && js.contains("loadJobsAndSessions") && js.contains("Run in Background"));
}
