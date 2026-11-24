mod common;

use common::TestServer;
use serde_json::json;
use std::io::{Read, Write};
use std::net::TcpListener;
use std::os::unix::fs::PermissionsExt;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;

fn spawn_mock_gemini_server() -> (
    u16,
    Arc<AtomicBool>,
    Arc<Mutex<Vec<(String, String, String)>>>,
    thread::JoinHandle<()>,
) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let port = listener.local_addr().unwrap().port();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_flag = stop.clone();
    let captured: Arc<Mutex<Vec<(String, String, String)>>> = Arc::new(Mutex::new(Vec::new()));
    let cap_clone = captured.clone();

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

            // Read HTTP headers + full Content-Length body
            let mut raw = Vec::new();
            let mut buf = [0u8; 4096];
            let mut header_end = None;
            let mut content_len = 0usize;
            loop {
                match stream.read(&mut buf) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        raw.extend_from_slice(&buf[..n]);
                        if header_end.is_none() {
                            if let Some(pos) = raw.windows(4).position(|w| w == b"\r\n\r\n") {
                                header_end = Some(pos + 4);
                                let hdr_str = String::from_utf8_lossy(&raw[..pos]);
                                for line in hdr_str.lines() {
                                    if let Some((k, v)) = line.split_once(':') {
                                        if k.trim().eq_ignore_ascii_case("content-length") {
                                            content_len = v.trim().parse().unwrap_or(0);
                                        }
                                    }
                                }
                            }
                        }
                        if let Some(he) = header_end {
                            if raw.len() >= he + content_len {
                                break;
                            }
                        }
                    }
                }
            }

            let he = header_end.unwrap_or(raw.len());
            let hdr_str = String::from_utf8_lossy(&raw[..he]).into_owned();
            let body_str = String::from_utf8_lossy(&raw[he..]).into_owned();
            let first_line = hdr_str.lines().next().unwrap_or("");
            let mut parts = first_line.split_whitespace();
            let method = parts.next().unwrap_or("GET").to_string();
            let path = parts.next().unwrap_or("/").to_string();

            let mut api_key_hdr = String::new();
            for line in hdr_str.lines().skip(1) {
                if let Some((k, v)) = line.split_once(':') {
                    if k.trim().eq_ignore_ascii_case("x-goog-api-key") {
                        api_key_hdr = v.trim().to_string();
                    }
                }
            }

            cap_clone
                .lock()
                .unwrap()
                .push((format!("{} {}", method, path), api_key_hdr.clone(), body_str.clone()));

            let (status, resp_body) = if api_key_hdr == "bad-key" {
                (
                    "401 Unauthorized",
                    json!({ "error": { "code": 401, "message": "Invalid API key" } }).to_string(),
                )
            } else if path.ends_with("/models") && method == "GET" {
                (
                    "200 OK",
                    json!({
                        "models": [
                            { "name": "models/gemini-2.5-flash", "displayName": "Gemini 2.5 Flash" },
                            { "name": "models/gemini-2.5-pro", "displayName": "Gemini 2.5 Pro" }
                        ]
                    })
                    .to_string(),
                )
            } else if path.contains(":embedContent") {
                (
                    "200 OK",
                    json!({
                        "embedding": { "values": [0.125, -0.25, 0.5] }
                    })
                    .to_string(),
                )
            } else if path.contains(":generateContent") {
                let req_json: serde_json::Value = serde_json::from_str(&body_str).unwrap_or(json!({}));
                let want_json = req_json
                    .pointer("/generationConfig/responseMimeType")
                    .and_then(|v| v.as_str())
                    == Some("application/json");
                let turn_count = req_json
                    .get("contents")
                    .and_then(|v| v.as_array())
                    .map(|a| a.len())
                    .unwrap_or(0);
                let has_image = body_str.contains("\"inlineData\"") && body_str.contains("\"image/png\"");
                let has_sys = req_json.get("systemInstruction").is_some();

                let reply_text = if want_json {
                    r#"{"answer": 42, "ok": true}"#.to_string()
                } else {
                    format!(
                        "GEMINI_OK turns={} sys={} img={}",
                        turn_count, has_sys, has_image
                    )
                };
                (
                    "200 OK",
                    json!({
                        "candidates": [{
                            "finishReason": "STOP",
                            "content": {
                                "role": "model",
                                "parts": [
                                    { "text": "internal thought...", "thought": true },
                                    { "text": reply_text }
                                ]
                            }
                        }],
                        "usageMetadata": {
                            "promptTokenCount": 11,
                            "candidatesTokenCount": 7,
                            "totalTokenCount": 18
                        }
                    })
                    .to_string(),
                )
            } else {
                ("404 Not Found", json!({"error": {"message": "not found"}}).to_string())
            };

            let resp = format!(
                "HTTP/1.1 {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                status,
                resp_body.len(),
                resp_body
            );
            let _ = stream.write_all(resp.as_bytes());
            let _ = stream.flush();
        }
    });

    (port, stop, captured, handle)
}

#[test]
fn test_minilang_ai_agy_and_gemini_modules() {
    // 1. Create a deterministic mock `agy` CLI script in a temp directory
    let mock_dir = std::env::temp_dir().join(format!("mlnb-mock-agy-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&mock_dir).unwrap();
    let mock_agy = mock_dir.join("mock_agy.py");
    std::fs::write(
        &mock_agy,
        r#"#!/usr/bin/env python3
import json, sys

args = sys.argv[1:]
prompt = ""
conv = None
model = None
effort = None
mode = None
i = 0
while i < len(args):
    a = args[i]
    if a == "--print" and i + 1 < len(args):
        prompt = args[i + 1]; i += 2
    elif a == "--conversation" and i + 1 < len(args):
        conv = args[i + 1]; i += 2
    elif a == "--model" and i + 1 < len(args):
        model = args[i + 1]; i += 2
    elif a == "--effort" and i + 1 < len(args):
        effort = args[i + 1]; i += 2
    elif a == "--mode" and i + 1 < len(args):
        mode = args[i + 1]; i += 2
    else:
        i += 1

if "RETURN_JSON" in prompt:
    text = '```json\n{"sum": 99, "provider": "agy"}\n```'
else:
    text = f"AGY_REPLY conv={conv or 'new'} model={model or 'def'} effort={effort or 'def'} mode={mode or 'def'} :: {prompt}"
    text += "\n```minilang\nlet x := 42\n```"

out_conv = conv or "conv-mock-123"
print(json.dumps({"result": text, "conversation_id": out_conv}))
"#,
    )
    .unwrap();
    let mut perms = std::fs::metadata(&mock_agy).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(&mock_agy, perms).unwrap();

    let (gem_port, gem_stop, gem_reqs, gem_handle) = spawn_mock_gemini_server();

    let agy_bin_str = mock_agy.to_string_lossy().into_owned();
    let srv = TestServer::start(&[
        "--agy-bin",
        &agy_bin_str,
        "--agy-model",
        "mock-default-model",
        "--secrets-key",
        "ai-test-key",
    ]);

    // Store GEMINI_API_KEY in the Secrets Vault so gemini::* picks it up automatically!
    let set_key = srv.put_json("/api/secrets/GEMINI_API_KEY", &json!({"value": "secret-gem-key-123"}));
    assert_eq!(set_key.status, 200);

    // Create a tiny PNG file inside the workspace for multimodal image testing
    let png_bytes: [u8; 16] = [
        0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A, 0, 0, 0, 0, 0, 0, 0, 0,
    ];
    std::fs::write(srv.root.join("sample.png"), png_bytes).unwrap();

    srv.create_kernel("ml-ai", "minilang");

    // 2. Test `agy` module (status, prompt, complete, json mode, chat, multi-turn session)
    let agy_code = r#"
let st := agy::status()
let p1 := agy::prompt("Hello agy", system is "Be crisp", model is "pro-x", effort is "low")
let comp := agy::complete("Hello complete")
let js := agy::prompt("RETURN_JSON", json is true)
let ch := agy::chat([
    {"role" is "system", "content" is "Sys rule"},
    {"role" is "user", "content" is "Ping"}
])
let sess := agy::session(system is "Track turns")
let t1 := sess("Turn one")
let c1 := sess:conversation_id
let t2 := sess:ask("Turn two")
let hlen := sess:history:count
sess:clear
let hlen_after := sess:history:count
{
    "avail" is st["available"],
    "def_model" is st["default_model"],
    "p1" is p1,
    "comp_conv" is comp["conversation_id"],
    "comp_code" is comp["suggested_code"],
    "js_sum" is js["sum"],
    "ch" is ch,
    "t1" is t1,
    "c1" is c1,
    "t2" is t2,
    "hlen" is hlen,
    "hlen_after" is hlen_after
}
"#;
    let agy_res = srv.eval("ml-ai", agy_code);
    assert!(agy_res["error"].is_null(), "agy module error: {:?}", agy_res["error"]);
    let agy_repr = agy_res["results"].as_array().unwrap().last().unwrap()["repr"]
        .as_str()
        .unwrap();
    assert!(agy_repr.contains("avail is true"), "{}", agy_repr);
    assert!(agy_repr.contains("def_model is mock-default-model"), "{}", agy_repr);
    assert!(agy_repr.contains("model=pro-x") && agy_repr.contains("effort=low"), "{}", agy_repr);
    assert!(agy_repr.contains("comp_conv is conv-mock-123"), "{}", agy_repr);
    assert!(agy_repr.contains("comp_code is let x := 42"), "{}", agy_repr);
    assert!(agy_repr.contains("js_sum is 99"), "{}", agy_repr);
    assert!(agy_repr.contains("Sys rule") && agy_repr.contains("Ping"), "{}", agy_repr);
    assert!(agy_repr.contains("c1 is conv-mock-123"), "{}", agy_repr);
    assert!(agy_repr.contains("conv=conv-mock-123") && agy_repr.contains("Turn two"), "{}", agy_repr);
    assert!(agy_repr.contains("hlen is 4") && agy_repr.contains("hlen_after is 0"), "{}", agy_repr);

    // 3. Test `gemini` + unified `ai` module against mock Gemini REST server
    let gem_base = format!("http://127.0.0.1:{}/v1beta", gem_port);
    let gem_code = format!(
        r#"
env::set("GEMINI_API_BASE", "{base}")
let gst := gemini::status()
let gp := gemini::prompt("Hello Gemini", system is "Helpful", temperature is 0.2, max_tokens is 64)
let gjson := gemini::prompt("Give json", json is true)
let gfull := gemini::complete("Full reply")
let gimg := gemini::prompt("Describe image", image is "sample.png")
let gchat := gemini::chat([
    {{"role" is "system", "content" is "Expert"}},
    {{"role" is "user", "content" is "Hi"}},
    {{"role" is "assistant", "content" is "Hello!"}},
    {{"role" is "user", "content" is "Follow up"}}
])
let gs := gemini::session(model is "gemini-2.5-pro", system is "Brief")
let gt1 := gs("First question")
let gt2 := gs:ask("Second question")
let gs_hist := gs:history:count
let emb := gemini::embed("hello world")
let embs := gemini::embed(["a", "b"])
let mods := gemini::models()

:> Unified `ai` module
let aist := ai::status()
let ai_auto := ai::prompt("Auto routes to gemini")
let ai_agy := ai::prompt("Explicit agy", provider is "agy")
let ai_sub := ai::agy::prompt("Via sub-module")
{{
    "configured" is gst["configured"],
    "gp" is gp,
    "gjson_ans" is gjson["answer"],
    "gfull_finish" is gfull["finish_reason"],
    "gfull_toks" is gfull["usage"]["totalTokenCount"],
    "gimg" is gimg,
    "gchat" is gchat,
    "gt1" is gt1,
    "gt2" is gt2,
    "gs_hist" is gs_hist,
    "emb_len" is emb:count,
    "embs_len" is embs:count,
    "mods_len" is mods:count,
    "ai_agy_avail" is aist["agy"]["available"],
    "ai_gem_cfg" is aist["gemini"]["configured"],
    "ai_auto" is ai_auto,
    "ai_agy" is ai_agy,
    "ai_sub" is ai_sub
}}
"#,
        base = gem_base
    );

    let gem_res = srv.eval("ml-ai", &gem_code);
    assert!(gem_res["error"].is_null(), "gemini/ai module error: {:?}", gem_res["error"]);
    let gem_repr = gem_res["results"].as_array().unwrap().last().unwrap()["repr"]
        .as_str()
        .unwrap();
    assert!(gem_repr.contains("configured is true"), "{}", gem_repr);
    assert!(gem_repr.contains("gp is GEMINI_OK turns=1 sys=true img=false"), "{}", gem_repr);
    assert!(gem_repr.contains("gjson_ans is 42"), "{}", gem_repr);
    assert!(gem_repr.contains("gfull_finish is STOP") && gem_repr.contains("gfull_toks is 18"), "{}", gem_repr);
    assert!(gem_repr.contains("gimg is GEMINI_OK turns=1 sys=false img=true"), "{}", gem_repr);
    assert!(gem_repr.contains("gchat is GEMINI_OK turns=3 sys=true img=false"), "{}", gem_repr);
    assert!(gem_repr.contains("gt1 is GEMINI_OK turns=1 sys=true") && gem_repr.contains("gt2 is GEMINI_OK turns=3 sys=true"), "{}", gem_repr);
    assert!(gem_repr.contains("gs_hist is 4"), "{}", gem_repr);
    assert!(gem_repr.contains("emb_len is 3") && gem_repr.contains("embs_len is 2"), "{}", gem_repr);
    assert!(gem_repr.contains("mods_len is 2"), "{}", gem_repr);
    assert!(gem_repr.contains("ai_agy_avail is true") && gem_repr.contains("ai_gem_cfg is true"), "{}", gem_repr);
    assert!(gem_repr.contains("ai_auto is GEMINI_OK"), "{}", gem_repr);
    assert!(gem_repr.contains("ai_agy is AGY_REPLY") && gem_repr.contains("ai_sub is AGY_REPLY"), "{}", gem_repr);

    // 4. Error handling: bad API key surfaces clean GeminiError
    let err_res = srv.eval("ml-ai", r#"gemini::prompt("Should fail", api_key is "bad-key")"#);
    assert!(!err_res["error"].is_null(), "expected GeminiError");
    assert_eq!(err_res["error"]["error_type"], "GeminiError");
    assert!(
        err_res["error"]["message"]
            .as_str()
            .unwrap_or("")
            .contains("Invalid API key"),
        "{:?}",
        err_res["error"]
    );

    // Verify API key from Secrets Vault was sent via x-goog-api-key header
    {
        let reqs = gem_reqs.lock().unwrap();
        assert!(reqs.iter().any(|(_, k, _)| k == "secret-gem-key-123"));
        assert!(reqs.iter().any(|(ep, _, _)| ep.contains("/models/gemini-2.5-pro:generateContent")));
        assert!(reqs.iter().any(|(ep, _, _)| ep.contains("/models/text-embedding-004:embedContent")));
    }

    gem_stop.store(true, Ordering::Relaxed);
    gem_handle.join().unwrap();
    let _ = std::fs::remove_dir_all(&mock_dir);
}
