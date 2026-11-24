use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeSet, HashMap};
use std::ffi::{CStr, CString};
use std::os::raw::{c_char, c_int, c_void};
use std::sync::{Arc, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

// ============================================================================
// Pure-Rust Cryptographic Primitives (SHA-256, HMAC-SHA256, Base64URL, CSPRNG)
// ============================================================================

const SHA256_K: [u32; 64] = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

pub fn sha256(data: &[u8]) -> [u8; 32] {
    let mut h: [u32; 8] = [
        0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
        0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
    ];

    let bit_len = (data.len() as u64).wrapping_mul(8);
    let mut msg = Vec::with_capacity(data.len() + 72);
    msg.extend_from_slice(data);
    msg.push(0x80);
    while (msg.len() % 64) != 56 {
        msg.push(0);
    }
    msg.extend_from_slice(&bit_len.to_be_bytes());

    let mut w = [0u32; 64];
    for chunk in msg.chunks_exact(64) {
        for i in 0..16 {
            w[i] = u32::from_be_bytes([
                chunk[4 * i],
                chunk[4 * i + 1],
                chunk[4 * i + 2],
                chunk[4 * i + 3],
            ]);
        }
        for i in 16..64 {
            let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
            let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
            w[i] = w[i - 16]
                .wrapping_add(s0)
                .wrapping_add(w[i - 7])
                .wrapping_add(s1);
        }

        let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut hh] = h;
        for i in 0..64 {
            let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
            let ch = (e & f) ^ ((!e) & g);
            let temp1 = hh
                .wrapping_add(s1)
                .wrapping_add(ch)
                .wrapping_add(SHA256_K[i])
                .wrapping_add(w[i]);
            let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
            let maj = (a & b) ^ (a & c) ^ (b & c);
            let temp2 = s0.wrapping_add(maj);

            hh = g;
            g = f;
            f = e;
            e = d.wrapping_add(temp1);
            d = c;
            c = b;
            b = a;
            a = temp1.wrapping_add(temp2);
        }

        h[0] = h[0].wrapping_add(a);
        h[1] = h[1].wrapping_add(b);
        h[2] = h[2].wrapping_add(c);
        h[3] = h[3].wrapping_add(d);
        h[4] = h[4].wrapping_add(e);
        h[5] = h[5].wrapping_add(f);
        h[6] = h[6].wrapping_add(g);
        h[7] = h[7].wrapping_add(hh);
    }

    let mut out = [0u8; 32];
    for (i, word) in h.iter().enumerate() {
        out[4 * i..4 * i + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

pub fn hmac_sha256(key: &[u8], data: &[u8]) -> [u8; 32] {
    let mut k_block = [0u8; 64];
    if key.len() > 64 {
        let hashed = sha256(key);
        k_block[..32].copy_from_slice(&hashed);
    } else {
        k_block[..key.len()].copy_from_slice(key);
    }

    let mut ipad = Vec::with_capacity(64 + data.len());
    let mut opad = [0u8; 64 + 32];
    for i in 0..64 {
        ipad.push(k_block[i] ^ 0x36);
        opad[i] = k_block[i] ^ 0x5c;
    }
    ipad.extend_from_slice(data);
    let inner = sha256(&ipad);
    opad[64..].copy_from_slice(&inner);
    sha256(&opad)
}

fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (&x, &y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

const B64URL_ALPHA: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

pub fn b64url_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() * 4 + 2) / 3);
    let mut i = 0;
    while i + 3 <= input.len() {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8) | (input[i + 2] as u32);
        out.push(B64URL_ALPHA[((n >> 18) & 63) as usize] as char);
        out.push(B64URL_ALPHA[((n >> 12) & 63) as usize] as char);
        out.push(B64URL_ALPHA[((n >> 6) & 63) as usize] as char);
        out.push(B64URL_ALPHA[(n & 63) as usize] as char);
        i += 3;
    }
    let rem = input.len() - i;
    if rem == 1 {
        let n = (input[i] as u32) << 16;
        out.push(B64URL_ALPHA[((n >> 18) & 63) as usize] as char);
        out.push(B64URL_ALPHA[((n >> 12) & 63) as usize] as char);
    } else if rem == 2 {
        let n = ((input[i] as u32) << 16) | ((input[i + 1] as u32) << 8);
        out.push(B64URL_ALPHA[((n >> 18) & 63) as usize] as char);
        out.push(B64URL_ALPHA[((n >> 12) & 63) as usize] as char);
        out.push(B64URL_ALPHA[((n >> 6) & 63) as usize] as char);
    }
    out
}

pub fn b64url_decode(input: &str) -> Result<Vec<u8>, String> {
    let bytes = input.trim_end_matches('=').as_bytes();
    if bytes.len() % 4 == 1 {
        return Err("Invalid base64url length".to_string());
    }
    let mut out = Vec::with_capacity((bytes.len() * 3) / 4);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for &b in bytes {
        let val = match b {
            b'A'..=b'Z' => (b - b'A') as u32,
            b'a'..=b'z' => (b - b'a' + 26) as u32,
            b'0'..=b'9' => (b - b'0' + 52) as u32,
            b'-' => 62,
            b'_' => 63,
            _ => return Err("Invalid base64url character".to_string()),
        };
        buf = (buf << 6) | val;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Ok(out)
}

pub fn random_bytes<const N: usize>() -> Result<[u8; N], String> {
    let mut buf = [0u8; N];
    let mut offset = 0usize;
    while offset < N {
        let ret = unsafe {
            libc::getrandom(
                buf[offset..].as_mut_ptr() as *mut c_void,
                N - offset,
                0,
            )
        };
        if ret > 0 {
            offset += ret as usize;
            continue;
        }
        let err = std::io::Error::last_os_error();
        if err.kind() == std::io::ErrorKind::Interrupted {
            continue;
        }
        // Fallback to /dev/urandom
        use std::io::Read;
        let mut f = std::fs::File::open("/dev/urandom")
            .map_err(|e| format!("CSPRNG failed: {}", e))?;
        f.read_exact(&mut buf[offset..])
            .map_err(|e| format!("CSPRNG read failed: {}", e))?;
        break;
    }
    Ok(buf)
}

fn now_unix() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

// ============================================================================
// Errors & Public Types
// ============================================================================

#[derive(Debug, Clone)]
pub enum AuthError {
    InvalidCredentials(String),
    Forbidden(String),
    Unauthorized(String),
    Internal(String),
}

impl AuthError {
    pub fn status_code(&self) -> StatusCode {
        match self {
            AuthError::InvalidCredentials(_) => StatusCode::UNAUTHORIZED,
            AuthError::Unauthorized(_) => StatusCode::UNAUTHORIZED,
            AuthError::Forbidden(_) => StatusCode::FORBIDDEN,
            AuthError::Internal(_) => StatusCode::INTERNAL_SERVER_ERROR,
        }
    }

    pub fn code(&self) -> &'static str {
        match self {
            AuthError::InvalidCredentials(_) => "invalid_credentials",
            AuthError::Unauthorized(_) => "unauthorized",
            AuthError::Forbidden(_) => "forbidden_group",
            AuthError::Internal(_) => "auth_internal_error",
        }
    }

    pub fn message(&self) -> &str {
        match self {
            AuthError::InvalidCredentials(m)
            | AuthError::Forbidden(m)
            | AuthError::Unauthorized(m)
            | AuthError::Internal(m) => m,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthenticatedUser {
    pub username: String,
    pub groups: Vec<String>,
    pub exp: i64,
    pub jti: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TokenPair {
    pub token_type: String,
    pub access_token: String,
    pub expires_in: i64,
    pub expires_at: i64,
    pub refresh_token: String,
    pub refresh_expires_in: i64,
    pub refresh_expires_at: i64,
    pub user: AuthenticatedUser,
}

#[derive(Debug, Clone)]
pub struct AuthConfig {
    pub enabled: bool,
    pub required_group: Option<String>,
    pub pam_service: String,
    pub access_token_ttl_secs: i64,
    pub refresh_token_ttl_secs: i64,
    pub signing_key: Vec<u8>,
}

impl AuthConfig {
    pub fn new(
        require_login: bool,
        required_group: Option<String>,
        pam_service: String,
        access_token_ttl_secs: i64,
        refresh_token_ttl_secs: i64,
        secret: Option<String>,
    ) -> Result<Self, String> {
        let required_group = required_group.and_then(|g| {
            let trimmed = g.trim().to_string();
            if trimmed.is_empty() { None } else { Some(trimmed) }
        });
        let enabled = require_login || required_group.is_some();
        let signing_key = match secret.or_else(|| std::env::var("MINILANG_AUTH_SECRET").ok()) {
            Some(s) if !s.is_empty() => sha256(s.as_bytes()).to_vec(),
            _ => random_bytes::<32>()?.to_vec(),
        };
        Ok(Self {
            enabled,
            required_group,
            pam_service,
            access_token_ttl_secs: access_token_ttl_secs.max(30),
            refresh_token_ttl_secs: refresh_token_ttl_secs.max(60),
            signing_key,
        })
    }
}

// ============================================================================
// Local Machine Authentication (PAM via dlopen + POSIX NSS Group Membership)
// ============================================================================

pub trait LocalAuthenticator: Send + Sync {
    fn verify_credentials(&self, username: &str, password: &str) -> Result<(), AuthError>;
    fn resolve_user_groups(
        &self,
        username: &str,
        required_group: Option<&str>,
    ) -> Result<Vec<String>, AuthError>;
}

pub struct SystemAuthenticator {
    pam_service: String,
}

impl SystemAuthenticator {
    pub fn new(pam_service: String) -> Self {
        Self { pam_service }
    }
}

fn validate_username(username: &str) -> Result<(), AuthError> {
    if username.is_empty() || username.len() > 128 {
        return Err(AuthError::InvalidCredentials(
            "Invalid username or password".to_string(),
        ));
    }
    if username
        .bytes()
        .any(|b| b == 0 || b < 0x20 || b == b':' || b == b'/' || b.is_ascii_whitespace())
    {
        return Err(AuthError::InvalidCredentials(
            "Invalid username or password".to_string(),
        ));
    }
    Ok(())
}

// --- Linux-PAM FFI via dlopen("libpam.so.0") ---

const PAM_SUCCESS: c_int = 0;
const PAM_NEW_AUTHTOK_REQD: c_int = 12;
const PAM_CONV_ERR: c_int = 19;
const PAM_SILENT: c_int = 0x8000;

const PAM_PROMPT_ECHO_OFF: c_int = 1;
const PAM_PROMPT_ECHO_ON: c_int = 2;
const PAM_ERROR_MSG: c_int = 3;
const PAM_TEXT_INFO: c_int = 4;

#[repr(C)]
struct PamMessage {
    msg_style: c_int,
    msg: *const c_char,
}

#[repr(C)]
struct PamResponse {
    resp: *mut c_char,
    resp_retcode: c_int,
}

type PamConvFn = unsafe extern "C" fn(
    num_msg: c_int,
    msg: *mut *const PamMessage,
    resp: *mut *mut PamResponse,
    appdata_ptr: *mut c_void,
) -> c_int;

#[repr(C)]
struct PamConv {
    conv: Option<PamConvFn>,
    appdata_ptr: *mut c_void,
}

type PamStartFn = unsafe extern "C" fn(
    service_name: *const c_char,
    user: *const c_char,
    pam_conversation: *const PamConv,
    pamh: *mut *mut c_void,
) -> c_int;

type PamAuthenticateFn = unsafe extern "C" fn(pamh: *mut c_void, flags: c_int) -> c_int;
type PamAcctMgmtFn = unsafe extern "C" fn(pamh: *mut c_void, flags: c_int) -> c_int;
type PamEndFn = unsafe extern "C" fn(pamh: *mut c_void, pam_status: c_int) -> c_int;
type PamStrerrorFn = unsafe extern "C" fn(pamh: *mut c_void, errnum: c_int) -> *const c_char;

unsafe extern "C" fn pam_password_conv(
    num_msg: c_int,
    msg: *mut *const PamMessage,
    resp: *mut *mut PamResponse,
    appdata_ptr: *mut c_void,
) -> c_int {
    if num_msg <= 0 || msg.is_null() || resp.is_null() || appdata_ptr.is_null() {
        return PAM_CONV_ERR;
    }
    let count = num_msg as usize;
    let replies = libc::calloc(count, std::mem::size_of::<PamResponse>()) as *mut PamResponse;
    if replies.is_null() {
        return PAM_CONV_ERR;
    }

    let password_ptr = appdata_ptr as *const c_char;
    for i in 0..count {
        let m = *msg.add(i);
        if m.is_null() {
            continue;
        }
        let style = (*m).msg_style;
        match style {
            PAM_PROMPT_ECHO_OFF | PAM_PROMPT_ECHO_ON => {
                let dup = libc::strdup(password_ptr);
                if dup.is_null() {
                    for j in 0..i {
                        if !(*replies.add(j)).resp.is_null() {
                            libc::free((*replies.add(j)).resp as *mut c_void);
                        }
                    }
                    libc::free(replies as *mut c_void);
                    return PAM_CONV_ERR;
                }
                (*replies.add(i)).resp = dup;
                (*replies.add(i)).resp_retcode = 0;
            }
            PAM_ERROR_MSG | PAM_TEXT_INFO => {
                (*replies.add(i)).resp = std::ptr::null_mut();
                (*replies.add(i)).resp_retcode = 0;
            }
            _ => {
                for j in 0..i {
                    if !(*replies.add(j)).resp.is_null() {
                        libc::free((*replies.add(j)).resp as *mut c_void);
                    }
                }
                libc::free(replies as *mut c_void);
                return PAM_CONV_ERR;
            }
        }
    }

    *resp = replies;
    PAM_SUCCESS
}

fn pam_authenticate_user(service: &str, username: &str, password: &str) -> Result<(), AuthError> {
    let c_service = CString::new(service)
        .map_err(|_| AuthError::Internal("Invalid PAM service name".to_string()))?;
    let c_user = CString::new(username)
        .map_err(|_| AuthError::InvalidCredentials("Invalid username or password".to_string()))?;
    let c_pass = CString::new(password)
        .map_err(|_| AuthError::InvalidCredentials("Invalid username or password".to_string()))?;

    unsafe {
        let mut handle = libc::dlopen(
            b"libpam.so.0\0".as_ptr() as *const c_char,
            libc::RTLD_LAZY | libc::RTLD_LOCAL,
        );
        if handle.is_null() {
            handle = libc::dlopen(
                b"libpam.so\0".as_ptr() as *const c_char,
                libc::RTLD_LAZY | libc::RTLD_LOCAL,
            );
        }
        if handle.is_null() {
            return Err(AuthError::Internal(
                "Local authentication library (libpam.so.0) is not available on this host"
                    .to_string(),
            ));
        }

        let load_sym = |name: &[u8]| -> Result<*mut c_void, AuthError> {
            let sym = libc::dlsym(handle, name.as_ptr() as *const c_char);
            if sym.is_null() {
                Err(AuthError::Internal(format!(
                    "Missing PAM symbol {}",
                    String::from_utf8_lossy(name)
                )))
            } else {
                Ok(sym)
            }
        };

        let result = (|| -> Result<(), AuthError> {
            let pam_start: PamStartFn = std::mem::transmute(load_sym(b"pam_start\0")?);
            let pam_authenticate: PamAuthenticateFn =
                std::mem::transmute(load_sym(b"pam_authenticate\0")?);
            let pam_acct_mgmt: PamAcctMgmtFn =
                std::mem::transmute(load_sym(b"pam_acct_mgmt\0")?);
            let pam_end: PamEndFn = std::mem::transmute(load_sym(b"pam_end\0")?);
            let pam_strerror: PamStrerrorFn = std::mem::transmute(load_sym(b"pam_strerror\0")?);

            let conv = PamConv {
                conv: Some(pam_password_conv),
                appdata_ptr: c_pass.as_ptr() as *mut c_void,
            };

            let mut pamh: *mut c_void = std::ptr::null_mut();
            let start_rc = pam_start(c_service.as_ptr(), c_user.as_ptr(), &conv, &mut pamh);
            if start_rc != PAM_SUCCESS || pamh.is_null() {
                return Err(AuthError::Internal(format!(
                    "PAM initialization failed (code {})",
                    start_rc
                )));
            }

            let auth_rc = pam_authenticate(pamh, PAM_SILENT);
            if auth_rc != PAM_SUCCESS {
                let _ = pam_end(pamh, auth_rc);
                return Err(AuthError::InvalidCredentials(
                    "Invalid username or password".to_string(),
                ));
            }

            let acct_rc = pam_acct_mgmt(pamh, PAM_SILENT);
            if acct_rc != PAM_SUCCESS {
                let err_msg = if acct_rc == PAM_NEW_AUTHTOK_REQD {
                    "Local account password has expired and must be updated".to_string()
                } else {
                    let ptr = pam_strerror(pamh, acct_rc);
                    if ptr.is_null() {
                        "Local account is not permitted to log in".to_string()
                    } else {
                        format!(
                            "Account check failed: {}",
                            CStr::from_ptr(ptr).to_string_lossy()
                        )
                    }
                };
                let _ = pam_end(pamh, acct_rc);
                return Err(AuthError::Forbidden(err_msg));
            }

            let _ = pam_end(pamh, PAM_SUCCESS);
            Ok(())
        })();

        libc::dlclose(handle);
        result
    }
}

/// Look up a local Unix user via `getpwnam_r`, enumerate all primary & supplementary groups via
/// `getgrouplist` + `getgrgid_r`, and optionally verify membership in `required_group`.
pub fn lookup_local_user_groups(
    username: &str,
    required_group: Option<&str>,
) -> Result<Vec<String>, AuthError> {
    validate_username(username)?;
    let c_user = CString::new(username)
        .map_err(|_| AuthError::InvalidCredentials("Invalid username".to_string()))?;

    unsafe {
        // 1. Resolve user entry via getpwnam_r
        let mut pwd: libc::passwd = std::mem::zeroed();
        let mut pwd_buf = vec![0u8; 4096];
        let mut pwd_res: *mut libc::passwd = std::ptr::null_mut();
        loop {
            let rc = libc::getpwnam_r(
                c_user.as_ptr(),
                &mut pwd,
                pwd_buf.as_mut_ptr() as *mut c_char,
                pwd_buf.len(),
                &mut pwd_res,
            );
            if rc == libc::ERANGE && pwd_buf.len() < 1024 * 1024 {
                pwd_buf.resize(pwd_buf.len() * 2, 0);
                continue;
            }
            if rc != 0 {
                return Err(AuthError::Internal(format!(
                    "Failed to look up local user '{}': errno {}",
                    username, rc
                )));
            }
            break;
        }
        if pwd_res.is_null() {
            return Err(AuthError::InvalidCredentials(
                "Invalid username or password".to_string(),
            ));
        }
        let primary_gid = pwd.pw_gid;

        // 2. Enumerate all GIDs for user via getgrouplist
        let mut ngroups: c_int = 64;
        let mut gids: Vec<libc::gid_t> = vec![0; ngroups as usize];
        let mut rc = libc::getgrouplist(
            c_user.as_ptr(),
            primary_gid,
            gids.as_mut_ptr(),
            &mut ngroups,
        );
        if rc == -1 && ngroups > 0 {
            gids.resize(ngroups as usize, 0);
            rc = libc::getgrouplist(
                c_user.as_ptr(),
                primary_gid,
                gids.as_mut_ptr(),
                &mut ngroups,
            );
        }
        if rc < 0 {
            gids = vec![primary_gid];
        } else {
            gids.truncate(ngroups.max(0) as usize);
            if !gids.contains(&primary_gid) {
                gids.push(primary_gid);
            }
        }

        // 3. Resolve each GID to group name via getgrgid_r
        let mut group_names = BTreeSet::new();
        let mut grp_buf = vec![0u8; 4096];
        for &gid in &gids {
            let mut grp: libc::group = std::mem::zeroed();
            let mut grp_res: *mut libc::group = std::ptr::null_mut();
            loop {
                let grc = libc::getgrgid_r(
                    gid,
                    &mut grp,
                    grp_buf.as_mut_ptr() as *mut c_char,
                    grp_buf.len(),
                    &mut grp_res,
                );
                if grc == libc::ERANGE && grp_buf.len() < 1024 * 1024 {
                    grp_buf.resize(grp_buf.len() * 2, 0);
                    continue;
                }
                break;
            }
            if !grp_res.is_null() && !grp.gr_name.is_null() {
                let name = CStr::from_ptr(grp.gr_name).to_string_lossy().into_owned();
                group_names.insert(name);
            }
        }

        // 4. Verify required_group membership if configured
        if let Some(req_group) = required_group {
            let c_grp = CString::new(req_group).map_err(|_| {
                AuthError::Forbidden(format!("Invalid required group '{}'", req_group))
            })?;
            let mut grp: libc::group = std::mem::zeroed();
            let mut grp_res: *mut libc::group = std::ptr::null_mut();
            loop {
                let grc = libc::getgrnam_r(
                    c_grp.as_ptr(),
                    &mut grp,
                    grp_buf.as_mut_ptr() as *mut c_char,
                    grp_buf.len(),
                    &mut grp_res,
                );
                if grc == libc::ERANGE && grp_buf.len() < 1024 * 1024 {
                    grp_buf.resize(grp_buf.len() * 2, 0);
                    continue;
                }
                if grc != 0 {
                    return Err(AuthError::Internal(format!(
                        "Failed to look up group '{}': errno {}",
                        req_group, grc
                    )));
                }
                break;
            }
            if grp_res.is_null() {
                return Err(AuthError::Forbidden(format!(
                    "Required group '{}' does not exist on this machine",
                    req_group
                )));
            }

            let target_gid = grp.gr_gid;
            let mut in_group = gids.contains(&target_gid);
            if !in_group && !grp.gr_mem.is_null() {
                let mut mem = grp.gr_mem;
                while !(*mem).is_null() {
                    let member = CStr::from_ptr(*mem).to_string_lossy();
                    if member == username {
                        in_group = true;
                        break;
                    }
                    mem = mem.add(1);
                }
            }

            if !in_group {
                return Err(AuthError::Forbidden(format!(
                    "User '{}' is not a member of required group '{}'",
                    username, req_group
                )));
            }
            group_names.insert(req_group.to_string());
        }

        Ok(group_names.into_iter().collect())
    }
}

impl LocalAuthenticator for SystemAuthenticator {
    fn verify_credentials(&self, username: &str, password: &str) -> Result<(), AuthError> {
        validate_username(username)?;
        if password.is_empty() {
            return Err(AuthError::InvalidCredentials(
                "Invalid username or password".to_string(),
            ));
        }
        pam_authenticate_user(&self.pam_service, username, password)
    }

    fn resolve_user_groups(
        &self,
        username: &str,
        required_group: Option<&str>,
    ) -> Result<Vec<String>, AuthError> {
        lookup_local_user_groups(username, required_group)
    }
}

// ============================================================================
// JWT Access Token + Rotatable Refresh Token Store
// ============================================================================

#[derive(Debug, Serialize, Deserialize)]
struct JwtHeader {
    alg: String,
    typ: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct AccessTokenClaims {
    sub: String,
    groups: Vec<String>,
    iat: i64,
    exp: i64,
    jti: String,
    typ: String,
}

#[derive(Debug, Clone)]
struct RefreshRecord {
    family_id: String,
    username: String,
    expires_at: i64,
    used: bool,
    revoked: bool,
}

pub struct AuthManager {
    config: AuthConfig,
    authenticator: Arc<dyn LocalAuthenticator>,
    refresh_tokens: RwLock<HashMap<[u8; 32], RefreshRecord>>,
}

impl AuthManager {
    pub fn new(config: AuthConfig) -> Self {
        let auth = Arc::new(SystemAuthenticator::new(config.pam_service.clone()));
        Self::with_authenticator(config, auth)
    }

    pub fn with_authenticator(
        config: AuthConfig,
        authenticator: Arc<dyn LocalAuthenticator>,
    ) -> Self {
        Self {
            config,
            authenticator,
            refresh_tokens: RwLock::new(HashMap::new()),
        }
    }

    pub fn is_enabled(&self) -> bool {
        self.config.enabled
    }

    pub fn required_group(&self) -> Option<&str> {
        self.config.required_group.as_deref()
    }

    pub fn access_token_ttl(&self) -> i64 {
        self.config.access_token_ttl_secs
    }

    pub fn refresh_token_ttl(&self) -> i64 {
        self.config.refresh_token_ttl_secs
    }

    fn mint_access_token(
        &self,
        username: &str,
        groups: &[String],
        now: i64,
    ) -> Result<(String, AuthenticatedUser), AuthError> {
        let exp = now + self.config.access_token_ttl_secs;
        let jti = uuid::Uuid::new_v4().to_string();

        let header = JwtHeader {
            alg: "HS256".to_string(),
            typ: "JWT".to_string(),
        };
        let claims = AccessTokenClaims {
            sub: username.to_string(),
            groups: groups.to_vec(),
            iat: now,
            exp,
            jti: jti.clone(),
            typ: "access".to_string(),
        };

        let hdr_json = serde_json::to_vec(&header)
            .map_err(|e| AuthError::Internal(format!("JWT header encode error: {}", e)))?;
        let claims_json = serde_json::to_vec(&claims)
            .map_err(|e| AuthError::Internal(format!("JWT claims encode error: {}", e)))?;

        let signing_input = format!(
            "{}.{}",
            b64url_encode(&hdr_json),
            b64url_encode(&claims_json)
        );
        let sig = hmac_sha256(&self.config.signing_key, signing_input.as_bytes());
        let token = format!("{}.{}", signing_input, b64url_encode(&sig));

        let user = AuthenticatedUser {
            username: username.to_string(),
            groups: groups.to_vec(),
            exp,
            jti,
        };
        Ok((token, user))
    }

    fn generate_refresh_token() -> Result<(String, [u8; 32]), AuthError> {
        let raw = random_bytes::<32>().map_err(AuthError::Internal)?;
        let token = format!("mlr_{}", b64url_encode(&raw));
        let digest = sha256(token.as_bytes());
        Ok((token, digest))
    }

    fn prune_expired(map: &mut HashMap<[u8; 32], RefreshRecord>, now: i64) {
        // Keep recently-used tokens until expiry so reuse detection stays effective,
        // and discard records past their expiration window.
        map.retain(|_, rec| rec.expires_at > now);
    }

    pub async fn login(&self, username: String, password: String) -> Result<TokenPair, AuthError> {
        let user_trimmed = username.trim().to_string();
        let auth = self.authenticator.clone();
        let req_group = self.config.required_group.clone();
        let u_clone = user_trimmed.clone();

        let groups = tokio::task::spawn_blocking(move || {
            auth.verify_credentials(&u_clone, &password)?;
            auth.resolve_user_groups(&u_clone, req_group.as_deref())
        })
        .await
        .map_err(|e| AuthError::Internal(format!("Auth task failed: {}", e)))??;

        let now = now_unix();
        let (access_token, user) = self.mint_access_token(&user_trimmed, &groups, now)?;
        let (refresh_token, refresh_hash) = Self::generate_refresh_token()?;
        let refresh_expires_at = now + self.config.refresh_token_ttl_secs;
        let family_id = uuid::Uuid::new_v4().to_string();

        {
            let mut store = self.refresh_tokens.write().unwrap();
            Self::prune_expired(&mut store, now);
            store.insert(
                refresh_hash,
                RefreshRecord {
                    family_id,
                    username: user_trimmed,
                    expires_at: refresh_expires_at,
                    used: false,
                    revoked: false,
                },
            );
        }

        Ok(TokenPair {
            token_type: "Bearer".to_string(),
            access_token,
            expires_in: self.config.access_token_ttl_secs,
            expires_at: user.exp,
            refresh_token,
            refresh_expires_in: self.config.refresh_token_ttl_secs,
            refresh_expires_at,
            user,
        })
    }

    pub async fn refresh(&self, raw_refresh_token: &str) -> Result<TokenPair, AuthError> {
        let trimmed = raw_refresh_token.trim();
        if trimmed.is_empty() {
            return Err(AuthError::Unauthorized("Missing refresh token".to_string()));
        }
        let digest = sha256(trimmed.as_bytes());
        let now = now_unix();

        // Phase 1: Inspect & check replay/revocation/expiry
        let (username, family_id) = {
            let mut store = self.refresh_tokens.write().unwrap();
            let rec = match store.get(&digest).cloned() {
                Some(r) => r,
                None => {
                    return Err(AuthError::Unauthorized(
                        "Invalid or expired refresh token".to_string(),
                    ));
                }
            };
            if rec.used {
                // Reuse of an already-rotated refresh token -> compromise indicator.
                // Revoke every token in this session family immediately!
                let fam = rec.family_id.clone();
                for entry in store.values_mut() {
                    if entry.family_id == fam {
                        entry.revoked = true;
                    }
                }
                return Err(AuthError::Unauthorized(
                    "Refresh token reuse detected; session revoked. Please sign in again."
                        .to_string(),
                ));
            }
            if rec.revoked {
                return Err(AuthError::Unauthorized(
                    "Refresh token has been revoked".to_string(),
                ));
            }
            if now >= rec.expires_at {
                if let Some(entry) = store.get_mut(&digest) {
                    entry.revoked = true;
                }
                return Err(AuthError::Unauthorized(
                    "Refresh token has expired. Please sign in again.".to_string(),
                ));
            }
            (rec.username, rec.family_id)
        };

        // Phase 2: Re-verify local user & required group membership on refresh
        let auth = self.authenticator.clone();
        let req_group = self.config.required_group.clone();
        let u_clone = username.clone();
        let groups_res = tokio::task::spawn_blocking(move || {
            auth.resolve_user_groups(&u_clone, req_group.as_deref())
        })
        .await
        .map_err(|e| AuthError::Internal(format!("Group re-check task failed: {}", e)))?;

        let groups = match groups_res {
            Ok(g) => g,
            Err(err) => {
                // Revoke this session family since user is no longer authorized
                let mut store = self.refresh_tokens.write().unwrap();
                for entry in store.values_mut() {
                    if entry.family_id == family_id {
                        entry.revoked = true;
                    }
                }
                return Err(err);
            }
        };

        // Phase 3: Atomically rotate the refresh token
        let now = now_unix();
        let (access_token, user) = self.mint_access_token(&username, &groups, now)?;
        let (new_refresh, new_hash) = Self::generate_refresh_token()?;
        let refresh_expires_at = now + self.config.refresh_token_ttl_secs;

        {
            let mut store = self.refresh_tokens.write().unwrap();
            Self::prune_expired(&mut store, now);
            let old = match store.get_mut(&digest) {
                Some(r) => r,
                None => {
                    return Err(AuthError::Unauthorized(
                        "Refresh token expired".to_string(),
                    ));
                }
            };
            if old.used || old.revoked {
                let fam = family_id.clone();
                for entry in store.values_mut() {
                    if entry.family_id == fam {
                        entry.revoked = true;
                    }
                }
                return Err(AuthError::Unauthorized(
                    "Refresh token was already used; session revoked".to_string(),
                ));
            }
            old.used = true;
            store.insert(
                new_hash,
                RefreshRecord {
                    family_id,
                    username,
                    expires_at: refresh_expires_at,
                    used: false,
                    revoked: false,
                },
            );
        }

        Ok(TokenPair {
            token_type: "Bearer".to_string(),
            access_token,
            expires_in: self.config.access_token_ttl_secs,
            expires_at: user.exp,
            refresh_token: new_refresh,
            refresh_expires_in: self.config.refresh_token_ttl_secs,
            refresh_expires_at,
            user,
        })
    }

    pub fn verify_access_token(&self, token: &str) -> Result<AuthenticatedUser, AuthError> {
        let parts: Vec<&str> = token.trim().split('.').collect();
        if parts.len() != 3 {
            return Err(AuthError::Unauthorized("Malformed access token".to_string()));
        }

        let signing_input = format!("{}.{}", parts[0], parts[1]);
        let expected_sig = hmac_sha256(&self.config.signing_key, signing_input.as_bytes());
        let provided_sig = b64url_decode(parts[2])
            .map_err(|_| AuthError::Unauthorized("Malformed access token signature".to_string()))?;

        if !constant_time_eq(&expected_sig, &provided_sig) {
            return Err(AuthError::Unauthorized("Invalid access token signature".to_string()));
        }

        let hdr_bytes = b64url_decode(parts[0])
            .map_err(|_| AuthError::Unauthorized("Malformed access token header".to_string()))?;
        let header: JwtHeader = serde_json::from_slice(&hdr_bytes)
            .map_err(|_| AuthError::Unauthorized("Invalid access token header".to_string()))?;
        if header.alg != "HS256" {
            return Err(AuthError::Unauthorized("Unsupported token algorithm".to_string()));
        }

        let claims_bytes = b64url_decode(parts[1])
            .map_err(|_| AuthError::Unauthorized("Malformed access token payload".to_string()))?;
        let claims: AccessTokenClaims = serde_json::from_slice(&claims_bytes)
            .map_err(|_| AuthError::Unauthorized("Invalid access token claims".to_string()))?;

        if claims.typ != "access" {
            return Err(AuthError::Unauthorized("Invalid token type".to_string()));
        }
        let now = now_unix();
        if now >= claims.exp {
            return Err(AuthError::Unauthorized("Access token expired".to_string()));
        }
        if let Some(req_grp) = self.config.required_group.as_deref() {
            if !claims.groups.iter().any(|g| g == req_grp) {
                return Err(AuthError::Forbidden(format!(
                    "Token does not grant membership in required group '{}'",
                    req_grp
                )));
            }
        }

        Ok(AuthenticatedUser {
            username: claims.sub,
            groups: claims.groups,
            exp: claims.exp,
            jti: claims.jti,
        })
    }

    pub fn logout(&self, raw_refresh_token: &str) -> bool {
        let trimmed = raw_refresh_token.trim();
        if trimmed.is_empty() {
            return false;
        }
        let digest = sha256(trimmed.as_bytes());
        let mut store = self.refresh_tokens.write().unwrap();
        let family_id = match store.get(&digest) {
            Some(r) => r.family_id.clone(),
            None => return false,
        };
        for entry in store.values_mut() {
            if entry.family_id == family_id {
                entry.revoked = true;
            }
        }
        true
    }

    pub fn logout_all_for_user(&self, username: &str) -> usize {
        let mut store = self.refresh_tokens.write().unwrap();
        let mut revoked_families = BTreeSet::new();
        for entry in store.values_mut() {
            if entry.username == username && !entry.revoked {
                entry.revoked = true;
                revoked_families.insert(entry.family_id.clone());
            }
        }
        revoked_families.len()
    }

    pub fn active_sessions_for_user(&self, username: &str) -> usize {
        let now = now_unix();
        let store = self.refresh_tokens.read().unwrap();
        let mut families = BTreeSet::new();
        for entry in store.values() {
            if entry.username == username
                && !entry.revoked
                && !entry.used
                && entry.expires_at > now
            {
                families.insert(entry.family_id.as_str());
            }
        }
        families.len()
    }
}

// ============================================================================
// HTTP Header & Cookie Helpers
// ============================================================================

pub const ACCESS_COOKIE_NAME: &str = "mlnb_access";
pub const REFRESH_COOKIE_NAME: &str = "mlnb_refresh";

pub fn parse_cookie(headers: &HeaderMap, name: &str) -> Option<String> {
    for val in headers.get_all(header::COOKIE) {
        if let Ok(s) = val.to_str() {
            for part in s.split(';') {
                let trimmed = part.trim();
                if let Some((k, v)) = trimmed.split_once('=') {
                    if k.trim() == name {
                        let v = v.trim();
                        if !v.is_empty() {
                            return Some(v.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

pub fn extract_bearer_token(headers: &HeaderMap) -> Option<String> {
    let raw = headers.get(header::AUTHORIZATION)?.to_str().ok()?.trim();
    let (scheme, token) = raw.split_once(' ')?;
    if scheme.eq_ignore_ascii_case("bearer") {
        let t = token.trim();
        if !t.is_empty() {
            return Some(t.to_string());
        }
    }
    None
}

pub fn extract_access_token(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(tok) = extract_bearer_token(headers) {
        return Some(tok);
    }
    if let Some(tok) = parse_cookie(headers, ACCESS_COOKIE_NAME) {
        return Some(tok);
    }
    if let Some(q) = query {
        for pair in q.split('&') {
            if let Some((k, v)) = pair.split_once('=') {
                if k == "token" && !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

pub fn append_auth_cookies(headers: &mut HeaderMap, pair: &TokenPair) {
    let access_cookie = format!(
        "{}={}; HttpOnly; SameSite=Lax; Path=/; Max-Age={}",
        ACCESS_COOKIE_NAME, pair.access_token, pair.expires_in
    );
    let refresh_cookie = format!(
        "{}={}; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age={}",
        REFRESH_COOKIE_NAME, pair.refresh_token, pair.refresh_expires_in
    );
    if let Ok(v) = HeaderValue::from_str(&access_cookie) {
        headers.append(header::SET_COOKIE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&refresh_cookie) {
        headers.append(header::SET_COOKIE, v);
    }
}

pub fn append_clear_auth_cookies(headers: &mut HeaderMap) {
    let clear_access = format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        ACCESS_COOKIE_NAME
    );
    let clear_refresh = format!(
        "{}=; HttpOnly; SameSite=Lax; Path=/api/auth; Max-Age=0",
        REFRESH_COOKIE_NAME
    );
    if let Ok(v) = HeaderValue::from_str(&clear_access) {
        headers.append(header::SET_COOKIE, v);
    }
    if let Ok(v) = HeaderValue::from_str(&clear_refresh) {
        headers.append(header::SET_COOKIE, v);
    }
}

// ============================================================================
// Unit Tests
// ============================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    fn hex(bytes: &[u8]) -> String {
        bytes.iter().map(|b| format!("{:02x}", b)).collect()
    }

    #[test]
    fn test_sha256_and_hmac_vectors() {
        // FIPS 180-4 SHA-256("abc")
        assert_eq!(
            hex(&sha256(b"abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        // RFC 4231 Test Case 2: key = "Jefe", data = "what do ya want for nothing?"
        assert_eq!(
            hex(&hmac_sha256(b"Jefe", b"what do ya want for nothing?")),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn test_b64url_roundtrip() {
        for sample in [b"".as_slice(), b"a", b"ab", b"abc", b"hello-world! \x00\xff\xfe"] {
            let enc = b64url_encode(sample);
            let dec = b64url_decode(&enc).unwrap();
            assert_eq!(dec, sample);
        }
    }

    #[test]
    fn test_local_unix_group_lookup_real_system() {
        // Resolve current user via getpwuid
        let uid = unsafe { libc::geteuid() };
        let pwd = unsafe { libc::getpwuid(uid) };
        assert!(!pwd.is_null());
        let current_user = unsafe { CStr::from_ptr((*pwd).pw_name).to_string_lossy().into_owned() };
        let grp = unsafe { libc::getgrgid((*pwd).pw_gid) };
        assert!(!grp.is_null());
        let primary_group = unsafe { CStr::from_ptr((*grp).gr_name).to_string_lossy().into_owned() };

        // Must succeed when requiring user's own primary group
        let groups = lookup_local_user_groups(&current_user, Some(&primary_group)).unwrap();
        assert!(groups.contains(&primary_group));

        // Must reject a nonexistent group with Forbidden
        let err = lookup_local_user_groups(&current_user, Some("__definitely_no_such_group_xyz__"))
            .unwrap_err();
        assert!(matches!(err, AuthError::Forbidden(_)));

        // Must reject a nonexistent user
        let err2 = lookup_local_user_groups("__no_such_user_xyz__", None).unwrap_err();
        assert!(matches!(err2, AuthError::InvalidCredentials(_)));
    }

    struct MockAuth {
        users: Mutex<HashMap<String, (String, Vec<String>)>>,
    }

    impl LocalAuthenticator for MockAuth {
        fn verify_credentials(&self, username: &str, password: &str) -> Result<(), AuthError> {
            let map = self.users.lock().unwrap();
            match map.get(username) {
                Some((pw, _)) if pw == password => Ok(()),
                _ => Err(AuthError::InvalidCredentials("Bad credentials".to_string())),
            }
        }

        fn resolve_user_groups(
            &self,
            username: &str,
            required_group: Option<&str>,
        ) -> Result<Vec<String>, AuthError> {
            let map = self.users.lock().unwrap();
            let (_, groups) = map
                .get(username)
                .ok_or_else(|| AuthError::InvalidCredentials("No such user".to_string()))?;
            if let Some(req) = required_group {
                if !groups.iter().any(|g| g == req) {
                    return Err(AuthError::Forbidden(format!(
                        "Not in required group '{}'",
                        req
                    )));
                }
            }
            Ok(groups.clone())
        }
    }

    #[tokio::test]
    async fn test_login_group_check_refresh_rotation_and_replay_protection() {
        let mut users = HashMap::new();
        users.insert(
            "alice".to_string(),
            ("secret123".to_string(), vec!["users".to_string(), "devs".to_string()]),
        );
        users.insert(
            "bob".to_string(),
            ("bobpass".to_string(), vec!["users".to_string()]),
        );
        let mock = Arc::new(MockAuth {
            users: Mutex::new(users),
        });

        let cfg = AuthConfig::new(
            true,
            Some("devs".to_string()),
            "login".to_string(),
            60,
            3600,
            Some("test-signing-secret".to_string()),
        )
        .unwrap();
        let mgr = AuthManager::with_authenticator(cfg, mock.clone());

        // Wrong password -> 401
        let e = mgr.login("alice".into(), "wrong".into()).await.unwrap_err();
        assert_eq!(e.status_code(), StatusCode::UNAUTHORIZED);

        // Right password, missing required group -> 403
        let e = mgr.login("bob".into(), "bobpass".into()).await.unwrap_err();
        assert_eq!(e.status_code(), StatusCode::FORBIDDEN);

        // Right password + required group -> token pair
        let pair1 = mgr.login("alice".into(), "secret123".into()).await.unwrap();
        assert_eq!(pair1.user.username, "alice");
        assert!(pair1.refresh_token.starts_with("mlr_"));

        // Verify access token works
        let verified = mgr.verify_access_token(&pair1.access_token).unwrap();
        assert_eq!(verified.username, "alice");

        // Tampered access token rejected
        let tampered = format!("{}x", pair1.access_token);
        assert!(mgr.verify_access_token(&tampered).is_err());

        // Rotate refresh token -> succeeds and produces distinct tokens
        let pair2 = mgr.refresh(&pair1.refresh_token).await.unwrap();
        assert_ne!(pair2.refresh_token, pair1.refresh_token);
        assert_ne!(pair2.access_token, pair1.access_token);
        assert!(mgr.verify_access_token(&pair2.access_token).is_ok());

        // Replaying old refresh token pair1 MUST fail AND revoke pair2 (entire family)!
        let replay = mgr.refresh(&pair1.refresh_token).await.unwrap_err();
        assert_eq!(replay.status_code(), StatusCode::UNAUTHORIZED);
        let after_revoke = mgr.refresh(&pair2.refresh_token).await.unwrap_err();
        assert_eq!(after_revoke.status_code(), StatusCode::UNAUTHORIZED);

        // Re-login, then remove alice from 'devs' group -> refresh must fail with 403!
        let pair3 = mgr.login("alice".into(), "secret123".into()).await.unwrap();
        mock.users.lock().unwrap().get_mut("alice").unwrap().1 = vec!["users".to_string()];
        let grp_revoked = mgr.refresh(&pair3.refresh_token).await.unwrap_err();
        assert_eq!(grp_revoked.status_code(), StatusCode::FORBIDDEN);
    }
}
