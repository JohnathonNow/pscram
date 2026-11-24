use serde::Serialize;
use serde_json::{json, Value};
use std::ffi::{CStr, CString};
use std::fs;
use std::os::raw::{c_char, c_int, c_void};
use std::path::Path;
use std::sync::OnceLock;
use std::time::Instant;

const SQLITE_OK: c_int = 0;
const SQLITE_ROW: c_int = 100;
const SQLITE_DONE: c_int = 101;
const SQLITE_INTEGER: c_int = 1;
const SQLITE_FLOAT: c_int = 2;
const SQLITE_TEXT: c_int = 3;
const SQLITE_BLOB: c_int = 4;
const SQLITE_NULL: c_int = 5;

const SQLITE_OPEN_READONLY: c_int = 0x0000_0001;
const SQLITE_OPEN_READWRITE: c_int = 0x0000_0002;
const SQLITE_OPEN_URI: c_int = 0x0000_0040;

type FnOpenV2 = unsafe extern "C" fn(*const c_char, *mut *mut c_void, c_int, *const c_char) -> c_int;
type FnCloseV2 = unsafe extern "C" fn(*mut c_void) -> c_int;
type FnErrmsg = unsafe extern "C" fn(*mut c_void) -> *const c_char;
type FnBusyTimeout = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type FnChanges = unsafe extern "C" fn(*mut c_void) -> c_int;
type FnPrepareV2 = unsafe extern "C" fn(*mut c_void, *const c_char, c_int, *mut *mut c_void, *mut *const c_char) -> c_int;
type FnFinalize = unsafe extern "C" fn(*mut c_void) -> c_int;
type FnStep = unsafe extern "C" fn(*mut c_void) -> c_int;
type FnColumnCount = unsafe extern "C" fn(*mut c_void) -> c_int;
type FnColumnName = unsafe extern "C" fn(*mut c_void, c_int) -> *const c_char;
type FnColumnType = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;
type FnColumnInt64 = unsafe extern "C" fn(*mut c_void, c_int) -> i64;
type FnColumnDouble = unsafe extern "C" fn(*mut c_void, c_int) -> f64;
type FnColumnText = unsafe extern "C" fn(*mut c_void, c_int) -> *const u8;
type FnColumnBlob = unsafe extern "C" fn(*mut c_void, c_int) -> *const u8;
type FnColumnBytes = unsafe extern "C" fn(*mut c_void, c_int) -> c_int;

struct SqliteApi {
    open_v2: FnOpenV2,
    close_v2: FnCloseV2,
    errmsg: FnErrmsg,
    busy_timeout: Option<FnBusyTimeout>,
    changes: Option<FnChanges>,
    prepare_v2: FnPrepareV2,
    finalize: FnFinalize,
    step: FnStep,
    column_count: FnColumnCount,
    column_name: FnColumnName,
    column_type: FnColumnType,
    column_int64: FnColumnInt64,
    column_double: FnColumnDouble,
    column_text: FnColumnText,
    column_blob: FnColumnBlob,
    column_bytes: FnColumnBytes,
}

unsafe impl Send for SqliteApi {}
unsafe impl Sync for SqliteApi {}

static SQLITE_API: OnceLock<Result<SqliteApi, String>> = OnceLock::new();

fn api() -> Result<&'static SqliteApi, String> {
    SQLITE_API
        .get_or_init(|| unsafe {
            let names = ["libsqlite3.so.0\0", "libsqlite3.so\0"];
            let mut handle: *mut c_void = std::ptr::null_mut();
            for n in &names {
                handle = libc::dlopen(n.as_ptr() as *const c_char, libc::RTLD_LAZY | libc::RTLD_LOCAL);
                if !handle.is_null() {
                    break;
                }
            }
            if handle.is_null() {
                return Err("Could not load libsqlite3.so.0".to_string());
            }
            macro_rules! sym {
                ($name:expr, $ty:ty) => {{
                    let p = libc::dlsym(handle, concat!($name, "\0").as_ptr() as *const c_char);
                    if p.is_null() {
                        return Err(format!("libsqlite3 missing symbol {}", $name));
                    }
                    std::mem::transmute::<*mut c_void, $ty>(p)
                }};
            }
            let busy_p = libc::dlsym(handle, b"sqlite3_busy_timeout\0".as_ptr() as *const c_char);
            let changes_p = libc::dlsym(handle, b"sqlite3_changes\0".as_ptr() as *const c_char);
            Ok(SqliteApi {
                open_v2: sym!("sqlite3_open_v2", FnOpenV2),
                close_v2: sym!("sqlite3_close_v2", FnCloseV2),
                errmsg: sym!("sqlite3_errmsg", FnErrmsg),
                busy_timeout: if busy_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnBusyTimeout>(busy_p))
                },
                changes: if changes_p.is_null() {
                    None
                } else {
                    Some(std::mem::transmute::<*mut c_void, FnChanges>(changes_p))
                },
                prepare_v2: sym!("sqlite3_prepare_v2", FnPrepareV2),
                finalize: sym!("sqlite3_finalize", FnFinalize),
                step: sym!("sqlite3_step", FnStep),
                column_count: sym!("sqlite3_column_count", FnColumnCount),
                column_name: sym!("sqlite3_column_name", FnColumnName),
                column_type: sym!("sqlite3_column_type", FnColumnType),
                column_int64: sym!("sqlite3_column_int64", FnColumnInt64),
                column_double: sym!("sqlite3_column_double", FnColumnDouble),
                column_text: sym!("sqlite3_column_text", FnColumnText),
                column_blob: sym!("sqlite3_column_blob", FnColumnBlob),
                column_bytes: sym!("sqlite3_column_bytes", FnColumnBytes),
            })
        })
        .as_ref()
        .map_err(Clone::clone)
}

pub fn is_sqlite_ext(ext: &str) -> bool {
    matches!(ext, "db" | "sqlite" | "sqlite3" | "db3")
}

pub fn has_sqlite_magic(path: &Path) -> bool {
    use std::io::Read;
    let Ok(mut f) = fs::File::open(path) else {
        return false;
    };
    let mut buf = [0u8; 16];
    matches!(f.read_exact(&mut buf), Ok(()) if &buf == b"SQLite format 3\0")
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteColumnInfo {
    pub name: String,
    pub col_type: String,
    pub notnull: bool,
    pub pk: bool,
    pub default_value: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteTableInfo {
    pub kind: String, // "table" | "view"
    pub name: String,
    pub row_count: Option<i64>,
    pub sql: Option<String>,
    pub columns: Vec<SqliteColumnInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteSchemaResponse {
    pub path: String,
    pub name: String,
    pub size: u64,
    pub tables: Vec<SqliteTableInfo>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteQueryResponse {
    pub path: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub row_count: usize,
    pub truncated: bool,
    pub changes: i32,
    pub duration_ms: f64,
}

struct DbGuard {
    api: &'static SqliteApi,
    db: *mut c_void,
}

impl DbGuard {
    fn open(abs: &Path, read_only: bool) -> Result<Self, String> {
        let a = api()?;
        let c_path = CString::new(abs.to_string_lossy().as_ref())
            .map_err(|_| "Invalid SQLite path".to_string())?;
        let mut db: *mut c_void = std::ptr::null_mut();
        let flags = if read_only {
            SQLITE_OPEN_READONLY | SQLITE_OPEN_URI
        } else {
            SQLITE_OPEN_READWRITE | SQLITE_OPEN_URI
        };
        let rc = unsafe { (a.open_v2)(c_path.as_ptr(), &mut db, flags, std::ptr::null()) };
        if rc != SQLITE_OK || db.is_null() {
            let msg = if !db.is_null() {
                let s = unsafe { CStr::from_ptr((a.errmsg)(db)).to_string_lossy().into_owned() };
                unsafe { (a.close_v2)(db) };
                s
            } else {
                "Failed to open SQLite database".to_string()
            };
            return Err(msg);
        }
        if let Some(bt) = a.busy_timeout {
            unsafe { bt(db, 5000) };
        }
        Ok(Self { api: a, db })
    }

    fn errmsg(&self) -> String {
        unsafe {
            CStr::from_ptr((self.api.errmsg)(self.db))
                .to_string_lossy()
                .into_owned()
        }
    }

    fn query_raw(&self, sql: &str, limit: usize) -> Result<(Vec<String>, Vec<Vec<Value>>, bool), String> {
        let c_sql = CString::new(sql.replace('\0', "")).map_err(|_| "Invalid SQL".to_string())?;
        let mut stmt: *mut c_void = std::ptr::null_mut();
        let rc = unsafe {
            (self.api.prepare_v2)(self.db, c_sql.as_ptr(), -1, &mut stmt, std::ptr::null_mut())
        };
        if rc != SQLITE_OK || stmt.is_null() {
            return Err(self.errmsg());
        }

        let col_count = unsafe { (self.api.column_count)(stmt) };
        let mut columns = Vec::with_capacity(col_count.max(0) as usize);
        for i in 0..col_count {
            let name = unsafe {
                let p = (self.api.column_name)(stmt, i);
                if p.is_null() {
                    format!("col_{}", i + 1)
                } else {
                    CStr::from_ptr(p).to_string_lossy().into_owned()
                }
            };
            columns.push(name);
        }

        let mut rows = Vec::new();
        let mut truncated = false;
        loop {
            let step_rc = unsafe { (self.api.step)(stmt) };
            if step_rc == SQLITE_ROW {
                if rows.len() >= limit {
                    truncated = true;
                    break;
                }
                let mut row = Vec::with_capacity(columns.len());
                for i in 0..col_count {
                    let ty = unsafe { (self.api.column_type)(stmt, i) };
                    let val = match ty {
                        SQLITE_NULL => Value::Null,
                        SQLITE_INTEGER => json!(unsafe { (self.api.column_int64)(stmt, i) }),
                        SQLITE_FLOAT => json!(unsafe { (self.api.column_double)(stmt, i) }),
                        SQLITE_TEXT => unsafe {
                            let ptr = (self.api.column_text)(stmt, i);
                            let len = (self.api.column_bytes)(stmt, i).max(0) as usize;
                            if ptr.is_null() || len == 0 {
                                json!("")
                            } else {
                                let slice = std::slice::from_raw_parts(ptr, len);
                                json!(String::from_utf8_lossy(slice))
                            }
                        },
                        SQLITE_BLOB => unsafe {
                            let len = (self.api.column_bytes)(stmt, i).max(0) as usize;
                            let ptr = (self.api.column_blob)(stmt, i);
                            if ptr.is_null() || len == 0 {
                                json!("<blob 0 B>")
                            } else {
                                let preview_len = len.min(16);
                                let slice = std::slice::from_raw_parts(ptr, preview_len);
                                let hex: String = slice.iter().map(|b| format!("{:02x}", b)).collect();
                                json!(format!("<blob {} B: {}{}>", len, hex, if len > 16 { "..." } else { "" }))
                            }
                        },
                        _ => Value::Null,
                    };
                    row.push(val);
                }
                rows.push(row);
            } else if step_rc == SQLITE_DONE {
                break;
            } else {
                let err = self.errmsg();
                unsafe { (self.api.finalize)(stmt) };
                return Err(err);
            }
        }
        unsafe { (self.api.finalize)(stmt) };
        Ok((columns, rows, truncated))
    }
}

impl Drop for DbGuard {
    fn drop(&mut self) {
        if !self.db.is_null() {
            unsafe { (self.api.close_v2)(self.db) };
        }
    }
}

fn quote_ident(ident: &str) -> String {
    format!("\"{}\"", ident.replace('"', "\"\""))
}

pub fn inspect_schema(abs: &Path, rel_path: &str) -> Result<SqliteSchemaResponse, String> {
    if !abs.is_file() {
        return Err("SQLite path is not a file".to_string());
    }
    let meta = fs::metadata(abs).map_err(|e| format!("stat failed: {}", e))?;
    let name = abs
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_else(|| rel_path.to_string());
    let guard = DbGuard::open(abs, true)?;

    let (_, objs, _) = guard.query_raw(
        "SELECT type, name, sql FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name",
        1000,
    )?;

    let mut tables = Vec::new();
    for row in objs {
        let kind = row.get(0).and_then(|v| v.as_str()).unwrap_or("table").to_string();
        let tname = row.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string();
        let sql = row.get(2).and_then(|v| v.as_str()).map(String::from);
        if tname.is_empty() {
            continue;
        }
        let quoted = quote_ident(&tname);
        let row_count = guard
            .query_raw(&format!("SELECT COUNT(*) FROM {}", quoted), 1)
            .ok()
            .and_then(|(_, r, _)| r.first().and_then(|c| c.first()).and_then(|v| v.as_i64()));

        let mut columns = Vec::new();
        if let Ok((_, col_rows, _)) = guard.query_raw(&format!("PRAGMA table_info({})", quoted), 500) {
            for cr in col_rows {
                columns.push(SqliteColumnInfo {
                    name: cr.get(1).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    col_type: cr.get(2).and_then(|v| v.as_str()).unwrap_or("").to_string(),
                    notnull: cr.get(3).and_then(|v| v.as_i64()).unwrap_or(0) != 0,
                    default_value: cr.get(4).and_then(|v| if v.is_null() { None } else { Some(v.to_string()) }),
                    pk: cr.get(5).and_then(|v| v.as_i64()).unwrap_or(0) != 0,
                });
            }
        }
        tables.push(SqliteTableInfo {
            kind,
            name: tname,
            row_count,
            sql,
            columns,
        });
    }

    Ok(SqliteSchemaResponse {
        path: rel_path.to_string(),
        name,
        size: meta.len(),
        tables,
    })
}

pub fn run_query(
    abs: &Path,
    rel_path: &str,
    sql: &str,
    limit: usize,
    read_only: bool,
) -> Result<SqliteQueryResponse, String> {
    let start = Instant::now();
    let trimmed = sql.trim();
    if trimmed.is_empty() {
        return Err("SQL query cannot be empty".to_string());
    }
    let guard = DbGuard::open(abs, read_only)?;
    let clamped = limit.clamp(1, 5000);
    let (columns, rows, truncated) = guard.query_raw(trimmed, clamped)?;
    let changes = if let Some(ch_fn) = guard.api.changes {
        unsafe { ch_fn(guard.db) }
    } else {
        0
    };
    Ok(SqliteQueryResponse {
        path: rel_path.to_string(),
        row_count: rows.len(),
        columns,
        rows,
        truncated,
        changes,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}
