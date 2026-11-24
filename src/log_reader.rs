use chrono::{DateTime, Utc};
use serde::Serialize;
use serde_json::{json, Value};
use std::fs;
use std::path::Path;

const MLOG_MAGIC: &[u8; 4] = b"MLOG";
const MLOG_HEADER_SIZE: usize = 20;

#[derive(Debug, Clone, Serialize)]
pub struct LogEntryView {
    pub index: usize,
    pub timestamp: Option<String>,
    pub epoch_ms: Option<i64>,
    pub type_name: String,
    pub level: Option<String>,
    pub repr: String,
    pub value: Value,
}

#[derive(Debug, Clone, Serialize)]
pub struct LogReadResponse {
    pub path: String,
    pub name: String,
    pub format: String, // "mlog" | "text"
    pub size: u64,
    pub total: usize,
    pub filtered: usize,
    pub offset: usize,
    pub limit: usize,
    pub types: Vec<String>,
    pub entries: Vec<LogEntryView>,
}

pub fn has_mlog_magic(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 4];
    matches!(f.read_exact(&mut buf), Ok(()) if &buf == MLOG_MAGIC)
}

pub fn read_log_file(
    abs: &Path,
    rel_path: &str,
    query: Option<&str>,
    type_filter: Option<&str>,
    reverse: bool,
    offset: usize,
    limit: usize,
) -> Result<LogReadResponse, String> {
    if abs.is_dir() {
        return Err("Cannot open directory as a log file".to_string());
    }
    let meta = fs::metadata(abs).map_err(|e| format!("stat failed: {}", e))?;
    if meta.len() > 64 * 1024 * 1024 {
        return Err("Log file exceeds 64 MB viewer limit".to_string());
    }
    let bytes = fs::read(abs).map_err(|e| format!("read failed: {}", e))?;
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel_path.to_string());

    let (format, mut all_entries) = if bytes.len() >= 4 && &bytes[..4] == MLOG_MAGIC {
        ("mlog".to_string(), parse_mlog_frames(&bytes))
    } else {
        ("text".to_string(), parse_text_log(&bytes))
    };

    let total = all_entries.len();

    let mut type_set = std::collections::BTreeSet::new();
    for e in &all_entries {
        type_set.insert(e.type_name.clone());
    }
    let types: Vec<String> = type_set.into_iter().collect();

    if reverse {
        all_entries.reverse();
    }

    let q_lower = query
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty());
    let tf = type_filter
        .map(|s| s.trim().to_lowercase())
        .filter(|s| !s.is_empty() && s != "all");

    let filtered_entries: Vec<LogEntryView> = all_entries
        .into_iter()
        .filter(|e| {
            if let Some(ref want_ty) = tf {
                if e.type_name.to_lowercase() != *want_ty {
                    return false;
                }
            }
            if let Some(ref q) = q_lower {
                let in_repr = e.repr.to_lowercase().contains(q);
                let in_type = e.type_name.to_lowercase().contains(q);
                let in_ts = e
                    .timestamp
                    .as_deref()
                    .map(|t| t.to_lowercase().contains(q))
                    .unwrap_or(false);
                let in_lvl = e
                    .level
                    .as_deref()
                    .map(|l| l.to_lowercase().contains(q))
                    .unwrap_or(false);
                if !(in_repr || in_type || in_ts || in_lvl) {
                    return false;
                }
            }
            true
        })
        .collect();

    let filtered = filtered_entries.len();
    let clamped_limit = limit.clamp(1, 2000);
    let page: Vec<LogEntryView> = filtered_entries
        .into_iter()
        .skip(offset)
        .take(clamped_limit)
        .collect();

    Ok(LogReadResponse {
        path: rel_path.to_string(),
        name,
        format,
        size: meta.len(),
        total,
        filtered,
        offset,
        limit: clamped_limit,
        types,
        entries: page,
    })
}

fn parse_mlog_frames(bytes: &[u8]) -> Vec<LogEntryView> {
    let mut out = Vec::new();
    let mut pos = 0usize;
    let mut idx = 0usize;

    while pos + MLOG_HEADER_SIZE <= bytes.len() {
        if &bytes[pos..pos + 4] != MLOG_MAGIC {
            break;
        }
        let sec = i64::from_le_bytes(bytes[pos + 4..pos + 12].try_into().unwrap());
        let nsec = u32::from_le_bytes(bytes[pos + 12..pos + 16].try_into().unwrap());
        let cbor_len = u32::from_le_bytes(bytes[pos + 16..pos + 20].try_into().unwrap()) as usize;
        pos += MLOG_HEADER_SIZE;
        if cbor_len == 0 || pos + cbor_len > bytes.len() {
            break;
        }
        let payload = &bytes[pos..pos + cbor_len];
        pos += cbor_len;
        idx += 1;

        let dt = DateTime::<Utc>::from_timestamp(sec, nsec.min(999_999_999));
        let timestamp = dt.map(|d| d.to_rfc3339_opts(chrono::SecondsFormat::Millis, true));
        let epoch_ms = Some(sec.saturating_mul(1000).saturating_add((nsec / 1_000_000) as i64));

        let mut dec = CborDecoder::new(payload);
        let (type_name, value) = match dec.decode() {
            Ok(pair) => pair,
            Err(err) => ("error".to_string(), json!(format!("<CBOR decode error: {}>", err))),
        };
        let level = infer_level_from_value(&value);
        let repr = format_value_repr(&type_name, &value);

        out.push(LogEntryView {
            index: idx,
            timestamp,
            epoch_ms,
            type_name,
            level,
            repr,
            value,
        });
    }

    out
}

fn parse_text_log(bytes: &[u8]) -> Vec<LogEntryView> {
    let text = String::from_utf8_lossy(bytes);
    let mut out = Vec::new();
    for (i, line) in text.lines().enumerate() {
        let level = infer_level_from_str(line);
        let ts = extract_leading_iso_timestamp(line);
        out.push(LogEntryView {
            index: i + 1,
            timestamp: ts,
            epoch_ms: None,
            type_name: "text".to_string(),
            level,
            repr: line.to_string(),
            value: json!(line),
        });
    }
    out
}

fn infer_level_from_str(s: &str) -> Option<String> {
    let up = s.to_ascii_uppercase();
    if up.contains("FATAL") || up.contains("ERROR") || up.contains("[ERR]") {
        Some("error".to_string())
    } else if up.contains("WARN") {
        Some("warn".to_string())
    } else if up.contains("DEBUG") || up.contains("TRACE") {
        Some("debug".to_string())
    } else if up.contains("INFO") {
        Some("info".to_string())
    } else {
        None
    }
}

fn infer_level_from_value(v: &Value) -> Option<String> {
    if let Some(obj) = v.as_object() {
        for key in ["level", "severity", "lvl"] {
            if let Some(s) = obj.get(key).and_then(|x| x.as_str()) {
                return infer_level_from_str(s).or_else(|| Some(s.to_lowercase()));
            }
        }
        if obj.contains_key("error") {
            return Some("error".to_string());
        }
    }
    None
}

fn extract_leading_iso_timestamp(line: &str) -> Option<String> {
    let t = line.trim_start().trim_start_matches('[');
    if t.len() >= 19 {
        let b = t.as_bytes();
        if b[4] == b'-' && b[7] == b'-' && (b[10] == b'T' || b[10] == b' ') && b[13] == b':' && b[16] == b':' {
            let end = t
                .find(|c: char| c.is_whitespace() && t.as_bytes().get(10) != Some(&(c as u8)) || c == ']')
                .unwrap_or_else(|| t.len().min(32));
            let cand = &t[..end.min(35)];
            if cand.len() >= 19 {
                return Some(cand.to_string());
            }
        }
    }
    None
}

fn format_value_repr(type_name: &str, v: &Value) -> String {
    match type_name {
        "nil" => "nil".to_string(),
        "string" => v.as_str().unwrap_or("").to_string(),
        "integer" | "real" | "boolean" => v.to_string(),
        _ => serde_json::to_string_pretty(v).unwrap_or_else(|_| v.to_string()),
    }
}

// ============================================================================
// Lightweight Self-Contained RFC 8949 CBOR Decoder (handles Minilang tags)
// ============================================================================

struct CborDecoder<'a> {
    b: &'a [u8],
    pos: usize,
    string_refs: Vec<String>,
    shared_refs: Vec<(String, Value)>,
}

impl<'a> CborDecoder<'a> {
    fn new(b: &'a [u8]) -> Self {
        Self {
            b,
            pos: 0,
            string_refs: Vec::new(),
            shared_refs: Vec::new(),
        }
    }

    fn read_byte(&mut self) -> Result<u8, String> {
        if self.pos >= self.b.len() {
            return Err("unexpected EOF".to_string());
        }
        let v = self.b[self.pos];
        self.pos += 1;
        Ok(v)
    }

    fn read_slice(&mut self, n: usize) -> Result<&'a [u8], String> {
        if self.pos + n > self.b.len() {
            return Err("unexpected EOF".to_string());
        }
        let s = &self.b[self.pos..self.pos + n];
        self.pos += n;
        Ok(s)
    }

    fn read_uint(&mut self, ai: u8) -> Result<u64, String> {
        match ai {
            0..=23 => Ok(ai as u64),
            24 => Ok(self.read_byte()? as u64),
            25 => Ok(u16::from_be_bytes(self.read_slice(2)?.try_into().unwrap()) as u64),
            26 => Ok(u32::from_be_bytes(self.read_slice(4)?.try_into().unwrap()) as u64),
            27 => Ok(u64::from_be_bytes(self.read_slice(8)?.try_into().unwrap())),
            _ => Err(format!("invalid CBOR additional info {}", ai)),
        }
    }

    fn decode(&mut self) -> Result<(String, Value), String> {
        self.decode_depth(0)
    }

    fn decode_depth(&mut self, depth: usize) -> Result<(String, Value), String> {
        if depth > 64 {
            return Ok(("any".to_string(), json!("<max depth>")));
        }
        let first = self.read_byte()?;
        let major = first >> 5;
        let ai = first & 0x1f;

        match major {
            0 => {
                let n = self.read_uint(ai)?;
                Ok(("integer".to_string(), json!(n)))
            }
            1 => {
                let n = self.read_uint(ai)?;
                let signed = -1i128 - (n as i128);
                if let Ok(v) = i64::try_from(signed) {
                    Ok(("integer".to_string(), json!(v)))
                } else {
                    Ok(("integer".to_string(), json!(signed.to_string())))
                }
            }
            2 => {
                let bytes = self.read_bytes_or_indef(ai)?;
                let preview = if bytes.len() <= 64 {
                    let hex: String = bytes.iter().map(|x| format!("{:02x}", x)).collect();
                    format!("<bytes ({} B): {}>", bytes.len(), hex)
                } else {
                    let hex: String = bytes[..32].iter().map(|x| format!("{:02x}", x)).collect();
                    format!("<bytes ({} B): {}...>", bytes.len(), hex)
                };
                Ok(("bytes".to_string(), json!(preview)))
            }
            3 => {
                let s = self.read_string_or_indef(ai)?;
                if s.len() >= 3 {
                    self.string_refs.push(s.clone());
                }
                Ok(("string".to_string(), json!(s)))
            }
            4 => {
                let mut arr = Vec::new();
                if ai == 31 {
                    while self.pos < self.b.len() && self.b[self.pos] != 0xff {
                        let (_, v) = self.decode_depth(depth + 1)?;
                        arr.push(v);
                    }
                    if self.pos < self.b.len() && self.b[self.pos] == 0xff {
                        self.pos += 1;
                    }
                } else {
                    let len = self.read_uint(ai)? as usize;
                    for _ in 0..len {
                        let (_, v) = self.decode_depth(depth + 1)?;
                        arr.push(v);
                    }
                }
                Ok(("list".to_string(), Value::Array(arr)))
            }
            5 => {
                let mut map = serde_json::Map::new();
                if ai == 31 {
                    while self.pos < self.b.len() && self.b[self.pos] != 0xff {
                        let (_, k) = self.decode_depth(depth + 1)?;
                        let (_, v) = self.decode_depth(depth + 1)?;
                        map.insert(json_key_string(&k), v);
                    }
                    if self.pos < self.b.len() && self.b[self.pos] == 0xff {
                        self.pos += 1;
                    }
                } else {
                    let len = self.read_uint(ai)? as usize;
                    for _ in 0..len {
                        let (_, k) = self.decode_depth(depth + 1)?;
                        let (_, v) = self.decode_depth(depth + 1)?;
                        map.insert(json_key_string(&k), v);
                    }
                }
                Ok(("map".to_string(), Value::Object(map)))
            }
            6 => {
                let tag = self.read_uint(ai)?;
                match tag {
                    0 => {
                        let (_, v) = self.decode_depth(depth + 1)?;
                        Ok(("time".to_string(), v))
                    }
                    1 => {
                        let (_, v) = self.decode_depth(depth + 1)?;
                        if let Some(secs) = v.as_f64() {
                            let s = secs.trunc() as i64;
                            let ns = ((secs.fract().abs()) * 1e9) as u32;
                            if let Some(dt) = DateTime::<Utc>::from_timestamp(s, ns.min(999_999_999)) {
                                return Ok((
                                    "time".to_string(),
                                    json!(dt.to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
                                ));
                            }
                        }
                        Ok(("time".to_string(), v))
                    }
                    25 => {
                        // stringref
                        let (_, v) = self.decode_depth(depth + 1)?;
                        if let Some(i) = v.as_u64() {
                            if let Some(s) = self.string_refs.get(i as usize) {
                                return Ok(("string".to_string(), json!(s)));
                            }
                        }
                        Ok(("string".to_string(), v))
                    }
                    28 => {
                        // shareable
                        let slot = self.shared_refs.len();
                        self.shared_refs.push(("any".to_string(), Value::Null));
                        let pair = self.decode_depth(depth + 1)?;
                        self.shared_refs[slot] = pair.clone();
                        Ok(pair)
                    }
                    29 => {
                        // sharedref
                        let (_, v) = self.decode_depth(depth + 1)?;
                        if let Some(i) = v.as_u64() {
                            if let Some(pair) = self.shared_refs.get(i as usize) {
                                return Ok(pair.clone());
                            }
                        }
                        Ok(("ref".to_string(), v))
                    }
                    37 => {
                        // UUID (16 raw bytes)
                        let peek = self.read_byte()?;
                        if (peek >> 5) == 2 {
                            let raw = self.read_bytes_or_indef(peek & 0x1f)?;
                            if raw.len() == 16 {
                                let uuid_str = format!(
                                    "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
                                    raw[0], raw[1], raw[2], raw[3],
                                    raw[4], raw[5], raw[6], raw[7],
                                    raw[8], raw[9], raw[10], raw[11],
                                    raw[12], raw[13], raw[14], raw[15]
                                );
                                return Ok(("uuid".to_string(), json!(uuid_str)));
                            }
                        }
                        self.pos -= 1;
                        let (_, v) = self.decode_depth(depth + 1)?;
                        Ok(("uuid".to_string(), v))
                    }
                    256 => {
                        // stringref namespace
                        let saved = std::mem::take(&mut self.string_refs);
                        let res = self.decode_depth(depth + 1);
                        self.string_refs = saved;
                        res
                    }
                    258 => {
                        let (_, v) = self.decode_depth(depth + 1)?;
                        Ok(("set".to_string(), v))
                    }
                    296 => {
                        // sharedref namespace
                        let saved = std::mem::take(&mut self.shared_refs);
                        let res = self.decode_depth(depth + 1);
                        self.shared_refs = saved;
                        res
                    }
                    _ => {
                        let (t, v) = self.decode_depth(depth + 1)?;
                        if tag == 27 {
                            Ok(("object".to_string(), v))
                        } else {
                            Ok((t, v))
                        }
                    }
                }
            }
            7 => match ai {
                20 => Ok(("boolean".to_string(), Value::Bool(false))),
                21 => Ok(("boolean".to_string(), Value::Bool(true))),
                22 | 23 => Ok(("nil".to_string(), Value::Null)),
                25 => {
                    let bits = u16::from_be_bytes(self.read_slice(2)?.try_into().unwrap());
                    let f = f16_to_f64(bits);
                    Ok(("real".to_string(), json!(f)))
                }
                26 => {
                    let bits = u32::from_be_bytes(self.read_slice(4)?.try_into().unwrap());
                    let f = f32::from_bits(bits) as f64;
                    Ok(("real".to_string(), json!(f)))
                }
                27 => {
                    let bits = u64::from_be_bytes(self.read_slice(8)?.try_into().unwrap());
                    let f = f64::from_bits(bits);
                    Ok(("real".to_string(), json!(f)))
                }
                _ => Ok(("simple".to_string(), json!(ai))),
            },
            _ => Err("invalid CBOR major type".to_string()),
        }
    }

    fn read_bytes_or_indef(&mut self, ai: u8) -> Result<Vec<u8>, String> {
        if ai == 31 {
            let mut out = Vec::new();
            while self.pos < self.b.len() && self.b[self.pos] != 0xff {
                let h = self.read_byte()?;
                let n = self.read_uint(h & 0x1f)? as usize;
                out.extend_from_slice(self.read_slice(n)?);
            }
            if self.pos < self.b.len() && self.b[self.pos] == 0xff {
                self.pos += 1;
            }
            Ok(out)
        } else {
            let n = self.read_uint(ai)? as usize;
            Ok(self.read_slice(n)?.to_vec())
        }
    }

    fn read_string_or_indef(&mut self, ai: u8) -> Result<String, String> {
        let bytes = self.read_bytes_or_indef(ai)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}

fn json_key_string(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => other.to_string(),
    }
}

fn f16_to_f64(bits: u16) -> f64 {
    let sign = ((bits >> 15) & 1) as i32;
    let exp = ((bits >> 10) & 0x1f) as i32;
    let frac = (bits & 0x3ff) as u32;
    let val = if exp == 0 {
        (frac as f64) * 2f64.powi(-24)
    } else if exp == 31 {
        if frac == 0 { f64::INFINITY } else { f64::NAN }
    } else {
        (1.0 + (frac as f64) / 1024.0) * 2f64.powi(exp - 15)
    };
    if sign != 0 { -val } else { val }
}
