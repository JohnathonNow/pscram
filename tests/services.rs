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
