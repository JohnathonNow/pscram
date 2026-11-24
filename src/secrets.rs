use crate::auth::{b64url_decode, b64url_encode, hmac_sha256, random_bytes, sha256};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::RwLock;

const VAULT_MAGIC: &[u8; 4] = b"MLSV";
const VAULT_VERSION: u8 = 1;

#[derive(Debug, Clone, Serialize, Deserialize)]
struct SecretRecord {
    value: String,
    #[serde(default)]
    description: String,
    updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct SecretMeta {
    pub name: String,
    pub description: String,
    pub updated_at: String,
    pub masked: String,
}

pub struct SecretsVault {
    vault_path: PathBuf,
    master_key: [u8; 32],
    entries: RwLock<BTreeMap<String, SecretRecord>>,
}

impl SecretsVault {
    pub fn open(workspace_root: &Path, key_override: Option<String>) -> Result<Self, String> {
        let vault_path = workspace_root.join(".minilang-secrets.enc");
        let master_key = resolve_master_key(workspace_root, key_override)?;

        let entries = if vault_path.exists() {
            let blob = fs::read(&vault_path)
                .map_err(|e| format!("Failed to read secrets vault: {}", e))?;
            if blob.is_empty() {
                BTreeMap::new()
            } else {
                let plain = decrypt_blob(&master_key, &blob)?;
                serde_json::from_slice(&plain)
                    .map_err(|e| format!("Failed to parse decrypted secrets vault: {}", e))?
            }
        } else {
            BTreeMap::new()
        };

        Ok(Self {
            vault_path,
            master_key,
            entries: RwLock::new(entries),
        })
    }

    pub fn list(&self) -> Vec<SecretMeta> {
        let map = self.entries.read().unwrap();
        map.iter()
            .map(|(name, rec)| SecretMeta {
                name: name.clone(),
                description: rec.description.clone(),
                updated_at: rec.updated_at.clone(),
                masked: mask_secret(&rec.value),
            })
            .collect()
    }

    pub fn set(&self, name: &str, value: String, description: Option<String>) -> Result<SecretMeta, String> {
        let clean = name.trim();
        if !is_valid_secret_name(clean) {
            return Err("Secret name must match [A-Za-z_][A-Za-z0-9_]* (1–128 chars)".to_string());
        }
        let now = Utc::now().to_rfc3339();
        let meta = {
            let mut map = self.entries.write().unwrap();
            let desc = description.unwrap_or_else(|| {
                map.get(clean)
                    .map(|r| r.description.clone())
                    .unwrap_or_default()
            });
            let rec = SecretRecord {
                value,
                description: desc.clone(),
                updated_at: now.clone(),
            };
            let masked = mask_secret(&rec.value);
            map.insert(clean.to_string(), rec);
            self.persist_locked(&map)?;
            SecretMeta {
                name: clean.to_string(),
                description: desc,
                updated_at: now,
                masked,
            }
        };
        Ok(meta)
    }

    pub fn delete(&self, name: &str) -> Result<bool, String> {
        let clean = name.trim();
        let mut map = self.entries.write().unwrap();
        let removed = map.remove(clean).is_some();
        if removed {
            self.persist_locked(&map)?;
        }
        Ok(removed)
    }

    pub fn env_map(&self) -> BTreeMap<String, String> {
        let map = self.entries.read().unwrap();
        map.iter()
            .map(|(k, v)| (k.clone(), v.value.clone()))
            .collect()
    }

    fn persist_locked(&self, map: &BTreeMap<String, SecretRecord>) -> Result<(), String> {
        let plain = serde_json::to_vec(map)
            .map_err(|e| format!("Failed to serialize secrets: {}", e))?;
        let blob = encrypt_blob(&self.master_key, &plain)?;
        let tmp = self.vault_path.with_extension("enc.tmp");
        fs::write(&tmp, &blob)
            .map_err(|e| format!("Failed to write secrets vault: {}", e))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = fs::set_permissions(&tmp, fs::Permissions::from_mode(0o600));
        }
        fs::rename(&tmp, &self.vault_path)
            .map_err(|e| format!("Failed to commit secrets vault: {}", e))?;
        Ok(())
    }
}

pub fn is_valid_secret_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 128 {
        return false;
    }
    let mut chars = name.chars();
    let first = chars.next().unwrap();
    if !(first.is_ascii_alphabetic() || first == '_') {
        return false;
    }
    chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

fn mask_secret(val: &str) -> String {
    let chars: Vec<char> = val.chars().collect();
    if chars.len() <= 4 {
        "••••".to_string()
    } else {
        let tail: String = chars[chars.len() - 4..].iter().collect();
        format!("••••{}", tail)
    }
}

fn resolve_master_key(workspace_root: &Path, key_override: Option<String>) -> Result<[u8; 32], String> {
    if let Some(k) = key_override
        .filter(|s| !s.trim().is_empty())
        .or_else(|| std::env::var("MINILANG_SECRETS_KEY").ok().filter(|s| !s.trim().is_empty()))
    {
        return Ok(sha256(k.as_bytes()));
    }
    let key_path = workspace_root.join(".minilang-secrets.key");
    if key_path.exists() {
        let raw = fs::read_to_string(&key_path)
            .map_err(|e| format!("Failed to read secrets key file: {}", e))?;
        let bytes = b64url_decode(raw.trim())?;
        if bytes.len() == 32 {
            let mut out = [0u8; 32];
            out.copy_from_slice(&bytes);
            return Ok(out);
        }
        return Ok(sha256(raw.trim().as_bytes()));
    }

    let key = random_bytes::<32>()?;
    let encoded = b64url_encode(&key);
    fs::write(&key_path, format!("{}\n", encoded))
        .map_err(|e| format!("Failed to create secrets key file: {}", e))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(&key_path, fs::Permissions::from_mode(0o600));
    }
    Ok(key)
}

fn derive_subkeys(master: &[u8; 32], salt: &[u8; 16]) -> ([u8; 32], [u8; 32]) {
    let mut enc_in = Vec::with_capacity(20);
    enc_in.extend_from_slice(b"enc:");
    enc_in.extend_from_slice(salt);
    let enc_key = hmac_sha256(master, &enc_in);

    let mut mac_in = Vec::with_capacity(20);
    mac_in.extend_from_slice(b"mac:");
    mac_in.extend_from_slice(salt);
    let mac_key = hmac_sha256(master, &mac_in);
    (enc_key, mac_key)
}

fn xor_keystream(enc_key: &[u8; 32], nonce: &[u8; 16], data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len());
    let mut counter: u64 = 0;
    let mut block_in = [0u8; 24];
    block_in[..16].copy_from_slice(nonce);

    for chunk in data.chunks(32) {
        block_in[16..].copy_from_slice(&counter.to_le_bytes());
        let ks = hmac_sha256(enc_key, &block_in);
        for (i, &b) in chunk.iter().enumerate() {
            out.push(b ^ ks[i]);
        }
        counter = counter.wrapping_add(1);
    }
    out
}

fn encrypt_blob(master: &[u8; 32], plain: &[u8]) -> Result<Vec<u8>, String> {
    let salt = random_bytes::<16>()?;
    let nonce = random_bytes::<16>()?;
    let (enc_key, mac_key) = derive_subkeys(master, &salt);
    let ct = xor_keystream(&enc_key, &nonce, plain);

    let mut body = Vec::with_capacity(4 + 1 + 16 + 16 + ct.len() + 32);
    body.extend_from_slice(VAULT_MAGIC);
    body.push(VAULT_VERSION);
    body.extend_from_slice(&salt);
    body.extend_from_slice(&nonce);
    body.extend_from_slice(&ct);
    let tag = hmac_sha256(&mac_key, &body);
    body.extend_from_slice(&tag);
    Ok(body)
}

fn decrypt_blob(master: &[u8; 32], blob: &[u8]) -> Result<Vec<u8>, String> {
    let min_len = 4 + 1 + 16 + 16 + 32;
    if blob.len() < min_len || &blob[..4] != VAULT_MAGIC || blob[4] != VAULT_VERSION {
        return Err("Corrupt or unrecognized secrets vault format".to_string());
    }
    let mut salt = [0u8; 16];
    salt.copy_from_slice(&blob[5..21]);
    let mut nonce = [0u8; 16];
    nonce.copy_from_slice(&blob[21..37]);
    let ct_end = blob.len() - 32;
    let ct = &blob[37..ct_end];
    let stored_tag = &blob[ct_end..];

    let (enc_key, mac_key) = derive_subkeys(master, &salt);
    let expected_tag = hmac_sha256(&mac_key, &blob[..ct_end]);
    let mut diff = 0u8;
    for (&a, &b) in stored_tag.iter().zip(expected_tag.iter()) {
        diff |= a ^ b;
    }
    if diff != 0 {
        return Err("Secrets vault authentication failed (wrong key or tampered file)".to_string());
    }
    Ok(xor_keystream(&enc_key, &nonce, ct))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TempDir(PathBuf);
    impl TempDir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("mlnb_secrets_test_{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn test_vault_encrypt_persist_reopen_and_tamper_detection() {
        let dir = TempDir::new();
        let vault = SecretsVault::open(&dir.0, Some("master-pass-1".into())).unwrap();

        // Invalid names rejected
        assert!(vault.set("123BAD", "x".into(), None).is_err());
        assert!(vault.set("BAD-NAME", "x".into(), None).is_err());
        assert!(vault.set("", "x".into(), None).is_err());

        // Set & mask
        let m1 = vault.set("API_KEY", "sk-live-1234567890".into(), Some("Prod key".into())).unwrap();
        assert_eq!(m1.name, "API_KEY");
        assert_eq!(m1.masked, "••••7890");
        assert_eq!(m1.description, "Prod key");

        let m2 = vault.set("SHORT", "ab".into(), None).unwrap();
        assert_eq!(m2.masked, "••••");

        // On-disk ciphertext must not contain plaintext
        let raw = fs::read(dir.0.join(".minilang-secrets.enc")).unwrap();
        assert!(raw.starts_with(VAULT_MAGIC));
        assert!(!raw.windows(18).any(|w| w == b"sk-live-1234567890"));

        // Reopen with same key succeeds
        let reopened = SecretsVault::open(&dir.0, Some("master-pass-1".into())).unwrap();
        assert_eq!(reopened.env_map().get("API_KEY").map(String::as_str), Some("sk-live-1234567890"));
        assert_eq!(reopened.list().len(), 2);

        // Wrong key fails MAC check
        assert!(SecretsVault::open(&dir.0, Some("wrong-key".into())).is_err());

        // Tampered ciphertext fails MAC check
        let mut tampered = raw.clone();
        let last = tampered.len() - 1;
        tampered[last] ^= 0x01;
        fs::write(dir.0.join(".minilang-secrets.enc"), &tampered).unwrap();
        assert!(SecretsVault::open(&dir.0, Some("master-pass-1".into())).is_err());

        // Restore valid file and test delete
        fs::write(dir.0.join(".minilang-secrets.enc"), &raw).unwrap();
        let v3 = SecretsVault::open(&dir.0, Some("master-pass-1".into())).unwrap();
        assert!(v3.delete("API_KEY").unwrap());
        assert!(!v3.delete("API_KEY").unwrap());
        assert_eq!(v3.list().len(), 1);
    }

    #[test]
    fn test_vault_auto_generated_key_file() {
        let dir = TempDir::new();
        let v1 = SecretsVault::open(&dir.0, None).unwrap();
        v1.set("AUTO_KEY", "auto-secret-val".into(), None).unwrap();
        assert!(dir.0.join(".minilang-secrets.key").exists());

        let v2 = SecretsVault::open(&dir.0, None).unwrap();
        assert_eq!(v2.env_map().get("AUTO_KEY").map(String::as_str), Some("auto-secret-val"));
    }
}
