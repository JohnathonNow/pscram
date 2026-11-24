#![allow(dead_code)]

use serde_json::Value;
use std::collections::HashMap;
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

pub struct HttpResp {
    pub status: u16,
    pub headers: HashMap<String, String>,
    pub body: Vec<u8>,
}

impl HttpResp {
    pub fn text(&self) -> String {
        String::from_utf8_lossy(&self.body).into_owned()
    }

    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or_else(|e| {
            panic!(
                "Expected JSON body (status {}), err: {}\nBody:\n{}",
                self.status,
                e,
                self.text()
            )
        })
    }
}

pub struct TestServer {
    pub port: u16,
    pub root: PathBuf,
    child: Child,
}

impl TestServer {
    pub fn start(extra_args: &[&str]) -> Self {
        let root = std::env::temp_dir().join(format!("mlnb_e2e_{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).expect("failed to create temp test workspace");
        Self::start_in_dir(root, extra_args)
    }

    pub fn start_in_dir(root: PathBuf, extra_args: &[&str]) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind ephemeral port");
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let bin = env!("CARGO_BIN_EXE_minilang-notebook");
        let mut cmd = Command::new(bin);
        cmd.arg("--host")
            .arg("127.0.0.1")
            .arg("--port")
            .arg(port.to_string())
            .arg("--root")
            .arg(&root)
            .args(extra_args)
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        let child = cmd.spawn().expect("failed to spawn minilang-notebook");
        let server = Self { port, root, child };

        let deadline = Instant::now() + Duration::from_secs(10);
        while Instant::now() < deadline {
            if let Ok(resp) = server.try_request("GET", "/api/auth/status", &[], &[]) {
                if resp.status == 200 {
                    return server;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        panic!("TestServer on port {} failed to become ready in time", port);
    }

    pub fn try_request(
        &self,
        method: &str,
        path: &str,
        headers: &[(&str, &str)],
        body: &[u8],
    ) -> std::io::Result<HttpResp> {
        let mut stream = TcpStream::connect(format!("127.0.0.1:{}", self.port))?;
        stream.set_read_timeout(Some(Duration::from_secs(30)))?;
        stream.set_write_timeout(Some(Duration::from_secs(10)))?;

        let mut req = format!(
            "{} {} HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\nContent-Length: {}\r\n",
            method,
            path,
            self.port,
            body.len()
        );
        for (k, v) in headers {
            req.push_str(&format!("{}: {}\r\n", k, v));
        }
        req.push_str("\r\n");

        stream.write_all(req.as_bytes())?;
        if !body.is_empty() {
            stream.write_all(body)?;
        }
        stream.flush()?;

        let mut raw = Vec::new();
        stream.read_to_end(&mut raw)?;

        let sep = raw
            .windows(4)
            .position(|w| w == b"\r\n\r\n")
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidData, "incomplete HTTP response"))?;
        let head = String::from_utf8_lossy(&raw[..sep]);
        let mut lines = head.lines();
        let status_line = lines.next().unwrap_or("");
        let status = status_line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .unwrap_or(0);

        let mut hdr_map = HashMap::new();
        for line in lines {
            if let Some((k, v)) = line.split_once(':') {
                hdr_map.insert(k.trim().to_lowercase(), v.trim().to_string());
            }
        }

        let raw_body = &raw[sep + 4..];
        let body_bytes = if hdr_map
            .get("transfer-encoding")
            .map(|v| v.to_lowercase().contains("chunked"))
            .unwrap_or(false)
        {
            decode_chunked(raw_body)
        } else {
            raw_body.to_vec()
        };

        Ok(HttpResp {
            status,
            headers: hdr_map,
            body: body_bytes,
        })
    }

    pub fn req(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &[u8]) -> HttpResp {
        self.try_request(method, path, headers, body)
            .unwrap_or_else(|e| panic!("HTTP {} {} failed: {}", method, path, e))
    }

    pub fn get(&self, path: &str) -> HttpResp {
        self.req("GET", path, &[], &[])
    }

    pub fn delete(&self, path: &str) -> HttpResp {
        self.req("DELETE", path, &[], &[])
    }

    pub fn post_json(&self, path: &str, val: &Value) -> HttpResp {
        let bytes = serde_json::to_vec(val).unwrap();
        self.req("POST", path, &[("Content-Type", "application/json")], &bytes)
    }

    pub fn put_json(&self, path: &str, val: &Value) -> HttpResp {
        let bytes = serde_json::to_vec(val).unwrap();
        self.req("PUT", path, &[("Content-Type", "application/json")], &bytes)
    }

    pub fn create_kernel(&self, id: &str, language: &str) -> Value {
        let resp = self.post_json(
            "/api/kernels",
            &serde_json::json!({ "session_id": id, "language": language }),
        );
        assert_eq!(resp.status, 200, "create_kernel failed: {}", resp.text());
        resp.json()
    }

    pub fn eval(&self, kernel_id: &str, code: &str) -> Value {
        let resp = self.post_json(
            &format!("/api/kernels/{}/execute", kernel_id),
            &serde_json::json!({ "code": code }),
        );
        assert_eq!(resp.status, 200, "eval failed: {}", resp.text());
        resp.json()
    }

    pub fn eval_stream(&self, kernel_id: &str, code: &str) -> HttpResp {
        self.post_json(
            &format!("/api/kernels/{}/execute-stream", kernel_id),
            &serde_json::json!({ "code": code }),
        )
    }
}

impl Drop for TestServer {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn decode_chunked(mut src: &[u8]) -> Vec<u8> {
    let mut out = Vec::new();
    loop {
        let Some(pos) = src.windows(2).position(|w| w == b"\r\n") else {
            break;
        };
        let size_str = String::from_utf8_lossy(&src[..pos]);
        let size_hex = size_str.split(';').next().unwrap_or("").trim();
        let Ok(len) = usize::from_str_radix(size_hex, 16) else {
            break;
        };
        src = &src[pos + 2..];
        if len == 0 {
            break;
        }
        let take = len.min(src.len());
        out.extend_from_slice(&src[..take]);
        src = &src[take..];
        if src.starts_with(b"\r\n") {
            src = &src[2..];
        }
    }
    out
}
