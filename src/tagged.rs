use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::collections::BTreeMap;

/// Tagged JSON value format for passing strongly-typed Minilang parameters to `/invoke`
/// and returning strongly-typed Minilang results.
///
/// Format: `{ "type": "<tag>", "value": <payload> }` (for `"nil"`, `"value"` may be omitted or `null`).
///
/// Supported tags:
/// - `nil`
/// - `boolean` (alias `bool`)
/// - `integer` (alias `int`)
/// - `real` (alias `float`)
/// - `string` (alias `str`)
/// - `symbol` (alias `method`)
/// - `list`: `[TaggedValue, ...]`
/// - `tuple`: `[TaggedValue, ...]`
/// - `set`: `[TaggedValue, ...]`
/// - `map`: `{ "<key>": TaggedValue, ... }` or `[[keyTagged, valTagged], ...]`
/// - `time`: ISO-8601 string or Unix epoch seconds (integer/real)
/// - `uuid`: UUID string
/// - `bytes`: Base64-encoded binary data
#[derive(Debug, Clone, PartialEq)]
pub enum TaggedValue {
    Nil,
    Boolean(bool),
    Integer(i64),
    Real(f64),
    String(String),
    Symbol(String),
    List(Vec<TaggedValue>),
    Tuple(Vec<TaggedValue>),
    Set(Vec<TaggedValue>),
    Map(Vec<(TaggedValue, TaggedValue)>),
    TimeIso(String),
    TimeEpoch(i64, u64),
    Uuid(String),
    Bytes(Vec<u8>),
}

impl Serialize for TaggedValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeMap;
        match self {
            TaggedValue::Nil => {
                let mut m = serializer.serialize_map(Some(1))?;
                m.serialize_entry("type", "nil")?;
                m.end()
            }
            TaggedValue::Boolean(b) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "boolean")?;
                m.serialize_entry("value", b)?;
                m.end()
            }
            TaggedValue::Integer(n) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "integer")?;
                m.serialize_entry("value", n)?;
                m.end()
            }
            TaggedValue::Real(f) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "real")?;
                m.serialize_entry("value", f)?;
                m.end()
            }
            TaggedValue::String(s) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "string")?;
                m.serialize_entry("value", s)?;
                m.end()
            }
            TaggedValue::Symbol(s) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "symbol")?;
                m.serialize_entry("value", s)?;
                m.end()
            }
            TaggedValue::List(items) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "list")?;
                m.serialize_entry("value", items)?;
                m.end()
            }
            TaggedValue::Tuple(items) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "tuple")?;
                m.serialize_entry("value", items)?;
                m.end()
            }
            TaggedValue::Set(items) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "set")?;
                m.serialize_entry("value", items)?;
                m.end()
            }
            TaggedValue::Map(entries) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "map")?;
                let all_string_keys = entries
                    .iter()
                    .all(|(k, _)| matches!(k, TaggedValue::String(_)));
                if all_string_keys {
                    let mut obj = BTreeMap::new();
                    for (k, v) in entries {
                        if let TaggedValue::String(ks) = k {
                            obj.insert(ks.clone(), v.clone());
                        }
                    }
                    m.serialize_entry("value", &obj)?;
                } else {
                    m.serialize_entry("value", entries)?;
                }
                m.end()
            }
            TaggedValue::TimeIso(iso) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "time")?;
                m.serialize_entry("value", iso)?;
                m.end()
            }
            TaggedValue::TimeEpoch(sec, nsec) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "time")?;
                if *nsec == 0 {
                    m.serialize_entry("value", sec)?;
                } else {
                    let f = *sec as f64 + (*nsec as f64) / 1_000_000_000.0;
                    m.serialize_entry("value", &f)?;
                }
                m.end()
            }
            TaggedValue::Uuid(u) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "uuid")?;
                m.serialize_entry("value", u)?;
                m.end()
            }
            TaggedValue::Bytes(b) => {
                let mut m = serializer.serialize_map(Some(2))?;
                m.serialize_entry("type", "bytes")?;
                m.serialize_entry("value", &base64_encode(b))?;
                m.end()
            }
        }
    }
}

#[derive(Deserialize)]
struct RawTagged {
    #[serde(rename = "type")]
    ty: String,
    #[serde(default)]
    value: Option<serde_json::Value>,
}

impl<'de> Deserialize<'de> for TaggedValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = RawTagged::deserialize(deserializer)?;
        parse_raw_tagged(raw).map_err(serde::de::Error::custom)
    }
}

fn parse_raw_tagged(raw: RawTagged) -> Result<TaggedValue, String> {
    let tag = raw.ty.as_str();
    match tag {
        "nil" | "null" => match raw.value {
            None | Some(serde_json::Value::Null) => Ok(TaggedValue::Nil),
            Some(_) => Err("Expected null or omitted 'value' for type 'nil'".to_string()),
        },
        "boolean" | "bool" => {
            let v = raw
                .value
                .and_then(|v| v.as_bool())
                .ok_or_else(|| "Expected boolean 'value' for type 'boolean'".to_string())?;
            Ok(TaggedValue::Boolean(v))
        }
        "integer" | "int" => {
            let v = raw
                .value
                .and_then(|v| v.as_i64())
                .ok_or_else(|| "Expected 64-bit integer 'value' for type 'integer'".to_string())?;
            Ok(TaggedValue::Integer(v))
        }
        "real" | "float" | "double" => {
            let v = raw
                .value
                .and_then(|v| v.as_f64())
                .ok_or_else(|| "Expected numeric 'value' for type 'real'".to_string())?;
            Ok(TaggedValue::Real(v))
        }
        "string" | "str" => {
            let v = raw
                .value
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .ok_or_else(|| "Expected string 'value' for type 'string'".to_string())?;
            Ok(TaggedValue::String(v))
        }
        "symbol" | "method" => {
            let v = raw
                .value
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .ok_or_else(|| "Expected string 'value' for type 'symbol'".to_string())?;
            Ok(TaggedValue::Symbol(v))
        }
        "list" => {
            let items = parse_tagged_array(raw.value, "list")?;
            Ok(TaggedValue::List(items))
        }
        "tuple" => {
            let items = parse_tagged_array(raw.value, "tuple")?;
            Ok(TaggedValue::Tuple(items))
        }
        "set" => {
            let items = parse_tagged_array(raw.value, "set")?;
            Ok(TaggedValue::Set(items))
        }
        "map" => {
            let val = raw
                .value
                .ok_or_else(|| "Expected object or [key, value] array 'value' for type 'map'".to_string())?;
            match val {
                serde_json::Value::Object(obj) => {
                    let mut entries = Vec::with_capacity(obj.len());
                    for (k, v) in obj {
                        let tv: TaggedValue = serde_json::from_value(v)
                            .map_err(|e| format!("Invalid map value for key '{}': {}", k, e))?;
                        entries.push((TaggedValue::String(k), tv));
                    }
                    Ok(TaggedValue::Map(entries))
                }
                serde_json::Value::Array(arr) => {
                    let mut entries = Vec::with_capacity(arr.len());
                    for (idx, item) in arr.into_iter().enumerate() {
                        match item {
                            serde_json::Value::Array(mut pair) if pair.len() == 2 => {
                                let v_raw = pair.pop().unwrap();
                                let k_raw = pair.pop().unwrap();
                                let k: TaggedValue = serde_json::from_value(k_raw)
                                    .map_err(|e| format!("Invalid map key at index {}: {}", idx, e))?;
                                let v: TaggedValue = serde_json::from_value(v_raw)
                                    .map_err(|e| format!("Invalid map value at index {}: {}", idx, e))?;
                                entries.push((k, v));
                            }
                            _ => {
                                return Err(format!(
                                    "Expected [key, value] pair at index {} in map entries array",
                                    idx
                                ));
                            }
                        }
                    }
                    Ok(TaggedValue::Map(entries))
                }
                _ => Err("Expected object or [key, value] array 'value' for type 'map'".to_string()),
            }
        }
        "time" => {
            let val = raw
                .value
                .ok_or_else(|| "Expected ISO-8601 string or epoch number 'value' for type 'time'".to_string())?;
            match val {
                serde_json::Value::String(s) => Ok(TaggedValue::TimeIso(s)),
                serde_json::Value::Number(n) => {
                    if let Some(i) = n.as_i64() {
                        Ok(TaggedValue::TimeEpoch(i, 0))
                    } else if let Some(f) = n.as_f64() {
                        let sec = f.floor() as i64;
                        let nsec = ((f - f.floor()) * 1_000_000_000.0).round() as u64;
                        Ok(TaggedValue::TimeEpoch(sec, nsec))
                    } else {
                        Err("Invalid numeric timestamp for type 'time'".to_string())
                    }
                }
                _ => Err("Expected ISO-8601 string or epoch number 'value' for type 'time'".to_string()),
            }
        }
        "uuid" => {
            let v = raw
                .value
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .ok_or_else(|| "Expected UUID string 'value' for type 'uuid'".to_string())?;
            Ok(TaggedValue::Uuid(v))
        }
        "bytes" => {
            let s = raw
                .value
                .and_then(|v| match v {
                    serde_json::Value::String(s) => Some(s),
                    _ => None,
                })
                .ok_or_else(|| "Expected base64 string 'value' for type 'bytes'".to_string())?;
            let bytes = base64_decode(&s)?;
            Ok(TaggedValue::Bytes(bytes))
        }
        other => Err(format!(
            "Unsupported tagged JSON type '{}'. Supported types: nil, boolean, integer, real, string, symbol, list, tuple, set, map, time, uuid, bytes",
            other
        )),
    }
}

fn parse_tagged_array(
    value: Option<serde_json::Value>,
    kind: &str,
) -> Result<Vec<TaggedValue>, String> {
    let arr = match value {
        Some(serde_json::Value::Array(a)) => a,
        _ => return Err(format!("Expected array 'value' for type '{}'", kind)),
    };
    let mut out = Vec::with_capacity(arr.len());
    for (idx, elem) in arr.into_iter().enumerate() {
        let tv: TaggedValue = serde_json::from_value(elem)
            .map_err(|e| format!("Invalid element {} in '{}': {}", idx, kind, e))?;
        out.push(tv);
    }
    Ok(out)
}

pub fn is_valid_ml_ident(s: &str) -> bool {
    let mut chars = s.chars();
    match chars.next() {
        Some(c) if c.is_ascii_alphabetic() || c == '_' => {}
        _ => return false,
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[((n >> 18) & 63) as usize] as char);
        out.push(B64_TABLE[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 {
            B64_TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}

pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut vals = Vec::with_capacity(input.len());
    for b in input.bytes() {
        if b.is_ascii_whitespace() {
            continue;
        }
        if b == b'=' {
            vals.push(64u8);
            continue;
        }
        let v = match b {
            b'A'..=b'Z' => b - b'A',
            b'a'..=b'z' => b - b'a' + 26,
            b'0'..=b'9' => b - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("Invalid base64 character '{}'", b as char)),
        };
        vals.push(v);
    }
    if vals.len() % 4 != 0 {
        return Err("Invalid base64 length".to_string());
    }
    let mut out = Vec::with_capacity(vals.len() / 4 * 3);
    for chunk in vals.chunks(4) {
        if chunk[0] == 64 || chunk[1] == 64 {
            return Err("Invalid base64 padding".to_string());
        }
        out.push((chunk[0] << 2) | (chunk[1] >> 4));
        if chunk[2] != 64 {
            out.push((chunk[1] << 4) | (chunk[2] >> 2));
            if chunk[3] != 64 {
                out.push((chunk[2] << 6) | chunk[3]);
            }
        } else if chunk[3] != 64 {
            return Err("Invalid base64 padding".to_string());
        }
    }
    Ok(out)
}
