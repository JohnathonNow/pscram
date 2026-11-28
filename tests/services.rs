mod common;

use common::TestServer;
use serde_json::json;
use std::io::{BufRead, BufReader, Write};
use std::net::TcpStream;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

fn write_ws_file(srv: &TestServer, rel: &str, content: &str) {
    let full = srv.root.join(rel);
    if let Some(p) = full.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::write(full, content).unwrap();
}

/// Spawns a background reader thread connected to GET /api/services/<name>/events?client_id=<cid>
/// and forwards parsed `(event_name, json_data)` tuples over a channel.
fn connect_sse_ui(
    port: u16,
    service: &str,
    client_id: &str,
) -> (mpsc::Receiver<(String, serde_json::Value)>, TcpStream) {
    let mut stream = TcpStream::connect(format!("127.0.0.1:{}", port)).expect("connect sse");
    stream.set_read_timeout(Some(Duration::from_secs(10))).unwrap();
    let req = format!(
        "GET /api/services/{}/events?client_id={} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nAccept: text/event-stream\r\n\r\n",
        service, client_id, port
    );
    stream.write_all(req.as_bytes()).unwrap();
    stream.flush().unwrap();

    let ctrl_stream = stream.try_clone().unwrap();
    let (tx, rx) = mpsc::channel();

    thread::spawn(move || {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        // Skip HTTP response headers
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {
                    if line == "\r\n" || line == "\n" {
                        break;
                    }
                }
            }
        }
        let mut cur_event = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let trimmed = line.trim_end_matches(&['\r', '\n'][..]);
                    if let Some(ev) = trimmed.strip_prefix("event:") {
                        cur_event = ev.trim().to_string();
                    } else if let Some(data) = trimmed.strip_prefix("data:") {
                        let d = data.trim();
                        if let Ok(val) = serde_json::from_str::<serde_json::Value>(d) {
                            let ev_name = if cur_event.is_empty() {
                                "message".to_string()
                            } else {
                                cur_event.clone()
                            };
                            if tx.send((ev_name, val)).is_err() {
                                break;
                            }
                        }
                        cur_event.clear();
                    }
                }
            }
        }
    });

    (rx, ctrl_stream)
}

#[test]
fn test_service_lifecycle_pubsub_direct_and_rpc_across_multiple_uis() {
    let srv = TestServer::start(&[]);

    let svc_script = r#"
var count := Params["initial"] or 0
let me := service::self()
println("Service ready:", me["name"], "initial=", count)

loop
    let msg := service::recv(5000)
    if msg then
        let topic := msg["topic"]
        let data := msg["data"]
        if topic = "inc" then
            let by := (data and data["by"]) or 1
            count := count + by
            service::broadcast("count_updated", {"count" is count, "by" is msg["from"]})
        elseif topic = "whisper" then
            service::send(msg["from"], "secret", {"only_for" is msg["from"], "count" is count})
        elseif topic = "get" then
            let connected := service::clients()
            service::reply(msg, {"count" is count, "client_count" is connected:count})
        elseif topic = "quit" then
            exit
        end
    end
end
"#;
    write_ws_file(&srv, "services/counter.mini", svc_script);

    // Start the background service with initial=10
    let start_r = srv.post_json(
        "/api/services",
        &json!({
            "name": "counter",
            "script": "services/counter.mini",
            "params": { "initial": 10 }
        }),
    );
    assert_eq!(start_r.status, 200, "start service failed: {}", start_r.text());
    let svc = &start_r.json()["service"];
    assert_eq!(svc["name"], "counter");
    assert_eq!(svc["status"], "running");

    // Connect two independent UI SSE clients: ui-alpha and ui-beta
    let (rx_alpha, sock_alpha) = connect_sse_ui(srv.port, "counter", "ui-alpha");
    let (rx_beta, sock_beta) = connect_sse_ui(srv.port, "counter", "ui-beta");

    let (ev_a, data_a) = rx_alpha.recv_timeout(Duration::from_secs(5)).expect("alpha connected");
    assert_eq!(ev_a, "connected");
    assert_eq!(data_a["client_id"], "ui-alpha");

    let (ev_b, data_b) = rx_beta.recv_timeout(Duration::from_secs(5)).expect("beta connected");
    assert_eq!(ev_b, "connected");
    assert_eq!(data_b["client_id"], "ui-beta");

    // Verify service tracks both connected UIs
    let status_r = srv.get("/api/services/counter").json();
    assert_eq!(status_r["service"]["subscriber_count"], 2);

    // UI alpha sends "inc" by 5 -> service broadcasts "count_updated" to BOTH UIs
    let send_r = srv.post_json(
        "/api/services/counter/send",
        &json!({
            "topic": "inc",
            "from": "ui-alpha",
            "data": { "by": 5 }
        }),
    );
    assert_eq!(send_r.status, 200, "send failed: {}", send_r.text());

    let (ma_ev, ma) = rx_alpha.recv_timeout(Duration::from_secs(5)).expect("alpha broadcast");
    let (mb_ev, mb) = rx_beta.recv_timeout(Duration::from_secs(5)).expect("beta broadcast");
    assert_eq!(ma_ev, "message");
    assert_eq!(mb_ev, "message");
    assert_eq!(ma["topic"], "count_updated");
    assert_eq!(mb["topic"], "count_updated");
    assert_eq!(ma["data"]["value"]["count"]["value"], 15);
    assert_eq!(mb["data"]["value"]["count"]["value"], 15);
    assert_eq!(mb["data"]["value"]["by"]["value"], "ui-alpha");

    // UI beta sends "whisper" -> service sends direct message ONLY to ui-beta!
    let w_r = srv.post_json(
        "/api/services/counter/send",
        &json!({
            "topic": "whisper",
            "from": "ui-beta",
            "data": {}
        }),
    );
    assert_eq!(w_r.status, 200);
    let (wb_ev, wb) = rx_beta.recv_timeout(Duration::from_secs(5)).expect("beta direct msg");
    assert_eq!(wb_ev, "message");
    assert_eq!(wb["topic"], "secret");
    assert_eq!(wb["data"]["value"]["only_for"]["value"], "ui-beta");
    // ui-alpha must NOT receive the direct message addressed to ui-beta
    assert!(
        rx_alpha.recv_timeout(Duration::from_millis(250)).is_err(),
        "ui-alpha should not receive ui-beta's direct message"
    );

    // Request-reply RPC call("get") returns current state + connected client count
    let call_r = srv.post_json(
        "/api/services/counter/call",
        &json!({
            "topic": "get",
            "from": "ui-alpha",
            "data": {},
            "timeout_ms": 5000
        }),
    );
    assert_eq!(call_r.status, 200, "call failed: {}", call_r.text());
    let call_body = call_r.json();
    assert_eq!(call_body["reply_plain"]["count"], 15);
    assert_eq!(call_body["reply_plain"]["client_count"], 2);

    // Close SSE sockets cleanly
    let _ = sock_alpha.shutdown(std::net::Shutdown::Both);
    let _ = sock_beta.shutdown(std::net::Shutdown::Both);

    // Stop and delete the service
    let stop_r = srv.post_json("/api/services/counter/stop", &json!({}));
    assert_eq!(stop_r.status, 200);
    assert_eq!(stop_r.json()["service"]["status"], "stopped");

    let del_r = srv.delete("/api/services/counter");
    assert_eq!(del_r.status, 200);
    assert_eq!(del_r.json()["removed"], true);
}

#[test]
fn test_service_minilang_module_and_ui_compilation() {
    let srv = TestServer::start(&[]);

    // Echo RPC service
    let echo_svc = r#"
loop
    let msg := service::recv(5000)
    if msg then
        if msg["topic"] = "ping" then
            let x := msg["data"]["x"] or 0
            service::reply(msg, {"pong" is x + 1, "from" is msg["from"]})
        end
    end
end
"#;
    write_ws_file(&srv, "services/echo.mini", echo_svc);

    // Start, call, list, and stop the service directly from Minilang kernel code!
    srv.create_kernel("svc-k", "minilang");
    let res = srv.eval(
        "svc-k",
        r#"
let started := service::start("echo", "services/echo.mini")
let reply := service::call("echo", "ping", {"x" is 41})
let all := service::list()
let stopped := service::stop("echo")
println("REPLY=", reply["pong"], "STATUS=", stopped["status"], "COUNT=", all:count)
"#,
    );
    assert!(res["error"].is_null(), "minilang service eval failed: {:?}", res["error"]);
    let stdout = res["stdout"].as_str().unwrap_or("");
    assert!(
        stdout.contains("REPLY= 42") && stdout.contains("STATUS= stopped"),
        "unexpected stdout: {}",
        stdout
    );

    // Verify a `.ui` app using `service::on`, `service::send`, `service::call`, `service::client_id`
    // compiles cleanly to MiniJS bytecode without errors!
    let ui_src = r#"
let lbl := ui::text("Waiting...")
let me := service::client_id()
service::on("echo", "updated", fun(data, msg) do
    lbl:set_text(string(data))
end)
let btn := ui::button("Send", fun() do
    service::send("echo", "ping", {"x" is 1})
    service::call("echo", "ping", {"x" is 2}, fun(res, err) do
        lbl:set_text(string(res))
    end)
end)
ui::card("Service UI", ui::vbox(lbl, btn)):show
"#;
    write_ws_file(&srv, "ui/service_demo.ui", ui_src);

    let deadline = Instant::now() + Duration::from_secs(5);
    let ui_resp = srv.get("/ui/ui/service_demo.ui");
    assert_eq!(ui_resp.status, 200, "UI compile failed: {}", ui_resp.text());
    let ui_html = ui_resp.text();
    assert!(
        ui_html.contains("const errMsg = null;"),
        "UI page had compile error:\n{}",
        ui_html
    );
    assert!(ui_html.contains("__service_subs"));
    assert!(ui_html.contains("service::send") || ui_html.contains("\"service\""));
    assert!(Instant::now() < deadline);

    // Verify workbench UI & MiniJS VM expose service controls and methods
    let index_html = srv.get("/").text();
    assert!(index_html.contains("id=\"ftb-service\""));
    assert!(index_html.contains("id=\"jobs-tab-services\""));
    assert!(index_html.contains("id=\"service-launch-form\""));

    let svc_client_js = srv.get("/js/minijs/service_client.js").text();
    assert!(svc_client_js.contains("service::on"));
    assert!(svc_client_js.contains("service::call"));
    assert!(svc_client_js.contains("service::send"));
}

#[test]
fn test_sample_workspace_taskboard_service_and_ui() {
    let srv = TestServer::start(&[]);
    let repo_root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"));

    let svc_src = std::fs::read_to_string(repo_root.join("sample_workspace/services/taskboard.mini"))
        .expect("read sample_workspace/services/taskboard.mini");
    let ui_src = std::fs::read_to_string(repo_root.join("sample_workspace/uis/taskboard.ui"))
        .expect("read sample_workspace/uis/taskboard.ui");

    write_ws_file(&srv, "services/taskboard.mini", &svc_src);
    write_ws_file(&srv, "uis/taskboard.ui", &ui_src);

    // 1. Verify the example `.ui` compiles cleanly to MiniJS bytecode
    let ui_resp = srv.get("/ui/uis/taskboard.ui");
    assert_eq!(ui_resp.status, 200, "taskboard.ui failed: {}", ui_resp.text());
    let ui_html = ui_resp.text();
    assert!(
        ui_html.contains("const errMsg = null;"),
        "taskboard.ui had compile error:\n{}",
        ui_html
    );
    assert!(ui_html.contains("service::on") || ui_html.contains("\"service\""));

    // 2. Start the example background service
    let start_r = srv.post_json(
        "/api/services",
        &json!({
            "name": "taskboard",
            "script": "services/taskboard.mini",
            "params": { "room": "Demo Room" }
        }),
    );
    assert_eq!(start_r.status, 200, "start taskboard failed: {}", start_r.text());
    assert_eq!(start_r.json()["service"]["status"], "running");

    // 3. Connect two UI SSE subscribers to verify cross-UI sync & direct messaging
    let (rx_tab1, sock_tab1) = connect_sse_ui(srv.port, "taskboard", "ui-tab1");
    let (rx_tab2, sock_tab2) = connect_sse_ui(srv.port, "taskboard", "ui-tab2");

    let (ev1, _) = rx_tab1.recv_timeout(Duration::from_secs(5)).expect("tab1 connected");
    let (ev2, _) = rx_tab2.recv_timeout(Duration::from_secs(5)).expect("tab2 connected");
    assert_eq!(ev1, "connected");
    assert_eq!(ev2, "connected");

    // 4. RPC get_state returns seeded tasks, summary, and both connected clients
    let state_r = srv.post_json(
        "/api/services/taskboard/call",
        &json!({
            "topic": "get_state",
            "from": "ui-tab1",
            "data": {},
            "timeout_ms": 5000
        }),
    );
    assert_eq!(state_r.status, 200, "get_state failed: {}", state_r.text());
    let state_plain = &state_r.json()["reply_plain"];
    assert_eq!(state_plain["room"], "Demo Room");
    assert_eq!(state_plain["summary"]["total"], 3);
    assert_eq!(state_plain["client_count"], 2);

    // 5. Add a task from tab1 -> state_changed broadcasts to BOTH tab1 and tab2
    let add_r = srv.post_json(
        "/api/services/taskboard/send",
        &json!({
            "topic": "add_task",
            "from": "ui-tab1",
            "data": { "title": "Ship service demo", "priority": "high", "author": "Alice" }
        }),
    );
    assert_eq!(add_r.status, 200);
    let (e1, m1) = rx_tab1.recv_timeout(Duration::from_secs(5)).expect("tab1 add broadcast");
    let (e2, m2) = rx_tab2.recv_timeout(Duration::from_secs(5)).expect("tab2 add broadcast");
    assert_eq!(e1, "message");
    assert_eq!(e2, "message");
    assert_eq!(m1["topic"], "state_changed");
    assert_eq!(m2["topic"], "state_changed");
    assert_eq!(m1["data"]["value"]["summary"]["value"]["total"]["value"], 4);
    assert_eq!(m2["data"]["value"]["summary"]["value"]["total"]["value"], 4);

    // 6. Cycle status of newly added task #4: open -> in_progress
    let cyc_r = srv.post_json(
        "/api/services/taskboard/call",
        &json!({
            "topic": "cycle_status",
            "from": "ui-tab2",
            "data": { "id": 4 },
            "timeout_ms": 5000
        }),
    );
    assert_eq!(cyc_r.status, 200, "cycle_status failed: {}", cyc_r.text());
    assert_eq!(cyc_r.json()["reply_plain"]["task"]["status"], "in_progress");
    let (_, _) = rx_tab1.recv_timeout(Duration::from_secs(5)).expect("tab1 cycle broadcast");
    let (_, _) = rx_tab2.recv_timeout(Duration::from_secs(5)).expect("tab2 cycle broadcast");

    // 7. Broadcast announcement reaches both tabs
    let ann_r = srv.post_json(
        "/api/services/taskboard/send",
        &json!({
            "topic": "announce",
            "from": "ui-tab1",
            "data": { "text": "Standup in 5 minutes", "author": "Alice" }
        }),
    );
    assert_eq!(ann_r.status, 200);
    let (_, a1) = rx_tab1.recv_timeout(Duration::from_secs(5)).expect("tab1 announce");
    let (_, a2) = rx_tab2.recv_timeout(Duration::from_secs(5)).expect("tab2 announce");
    assert_eq!(a1["topic"], "announcement");
    assert_eq!(a2["topic"], "announcement");
    assert_eq!(a2["data"]["value"]["text"]["value"], "Standup in 5 minutes");

    // 8. Direct ping from ui-tab2 delivers private "pong" ONLY to ui-tab2
    let ping_r = srv.post_json(
        "/api/services/taskboard/send",
        &json!({
            "topic": "ping",
            "from": "ui-tab2",
            "data": {}
        }),
    );
    assert_eq!(ping_r.status, 200);
    let (_, p2) = rx_tab2.recv_timeout(Duration::from_secs(5)).expect("tab2 direct pong");
    assert_eq!(p2["topic"], "pong");
    assert_eq!(p2["data"]["value"]["to"]["value"], "ui-tab2");
    assert!(
        rx_tab1.recv_timeout(Duration::from_millis(250)).is_err(),
        "ui-tab1 must not receive ui-tab2's direct pong"
    );

    // 9. Clear done tasks and delete a task
    let clr_r = srv.post_json(
        "/api/services/taskboard/call",
        &json!({
            "topic": "clear_done",
            "from": "ui-tab1",
            "data": {},
            "timeout_ms": 5000
        }),
    );
    assert_eq!(clr_r.status, 200);
    assert_eq!(clr_r.json()["reply_plain"]["cleared"], 1);
    let (_, _) = rx_tab1.recv_timeout(Duration::from_secs(5)).expect("tab1 clear broadcast");
    let (_, _) = rx_tab2.recv_timeout(Duration::from_secs(5)).expect("tab2 clear broadcast");

    let del_r = srv.post_json(
        "/api/services/taskboard/call",
        &json!({
            "topic": "delete_task",
            "from": "ui-tab1",
            "data": { "id": 4 },
            "timeout_ms": 5000
        }),
    );
    assert_eq!(del_r.status, 200);
    assert_eq!(del_r.json()["reply_plain"]["ok"], true);
    let (_, _) = rx_tab1.recv_timeout(Duration::from_secs(5)).expect("tab1 delete broadcast");
    let (_, _) = rx_tab2.recv_timeout(Duration::from_secs(5)).expect("tab2 delete broadcast");

    // 10. Clean shutdown
    let _ = sock_tab1.shutdown(std::net::Shutdown::Both);
    let _ = sock_tab2.shutdown(std::net::Shutdown::Both);
    let stop_r = srv.post_json("/api/services/taskboard/stop", &json!({}));
    assert_eq!(stop_r.status, 200);
    assert_eq!(stop_r.json()["service"]["status"], "stopped");
}
