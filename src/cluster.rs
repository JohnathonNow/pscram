use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, HashMap};

pub const CLUSTER_PALETTE: &[&str] = &[
    "#7aa2f7", "#4ade80", "#f59e0b", "#c084fc", "#22d3ee", "#f87171", "#fb923c", "#a3e635",
    "#ec4899", "#14b8a6", "#eab308", "#818cf8", "#38bdf8", "#fb7185", "#34d399", "#a78bfa",
];

#[derive(Debug, Deserialize)]
pub struct SqliteClusterRequest {
    pub path: String,
    #[serde(default)]
    pub table: Option<String>,
    #[serde(default)]
    pub sql: Option<String>,
    pub x_col: String,
    #[serde(default)]
    pub y_col: Option<String>,
    #[serde(default)]
    pub color_col: Option<String>,
    /// "auto" | "direct" | "pca" | "tsne" | "kmeans_pca" | "per_col_pca"
    #[serde(default = "default_algo")]
    pub algorithm: String,
    #[serde(default = "default_k")]
    pub k: usize,
    #[serde(default = "default_limit")]
    pub limit: usize,
}

fn default_algo() -> String {
    "auto".to_string()
}

fn default_k() -> usize {
    4
}

fn default_limit() -> usize {
    1000
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterPoint {
    pub row_index: usize,
    pub x: f64,
    pub y: f64,
    pub color_group: Option<usize>,
    pub color_value: Value,
    pub color_label: String,
    pub cluster: Option<usize>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ClusterCentroid {
    pub cluster: usize,
    pub x: f64,
    pub y: f64,
    pub count: usize,
    pub label: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColorCategory {
    pub index: usize,
    pub label: String,
    pub color: String,
    pub count: usize,
}

#[derive(Debug, Clone, Serialize)]
pub struct ColorEncoding {
    /// "none" | "categorical" | "continuous" | "cluster"
    pub mode: String,
    pub column: Option<String>,
    pub categories: Vec<ColorCategory>,
    pub min: Option<f64>,
    pub max: Option<f64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct SqliteClusterResponse {
    pub path: String,
    pub source_label: String,
    pub algorithm_used: String,
    pub x_label: String,
    pub y_label: String,
    pub x_dim: usize,
    pub y_dim: usize,
    pub total_dim: usize,
    pub explained_variance: Option<[f64; 2]>,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<Value>>,
    pub points: Vec<ClusterPoint>,
    pub centroids: Vec<ClusterCentroid>,
    pub color: ColorEncoding,
    pub truncated: bool,
    pub duration_ms: f64,
}

/// Raw SQLite cell value retaining exact binary bytes for BLOB vector decoding.
#[derive(Debug, Clone)]
pub enum RawCell {
    Null,
    Int(i64),
    Float(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl RawCell {
    pub fn to_display_json(&self) -> Value {
        match self {
            RawCell::Null => Value::Null,
            RawCell::Int(i) => json!(i),
            RawCell::Float(f) => {
                if f.is_finite() {
                    json!(f)
                } else {
                    Value::Null
                }
            }
            RawCell::Text(s) => json!(s),
            RawCell::Blob(b) => {
                if b.is_empty() {
                    json!("<blob 0 B>")
                } else if let Some(vec) = decode_blob_vector(b) {
                    let preview: Vec<String> = vec.iter().take(6).map(|v| format!("{:.4}", v)).collect();
                    let suffix = if vec.len() > 6 { ", ..." } else { "" };
                    json!(format!("<vec[{}]: [{}{}]>", vec.len(), preview.join(", "), suffix))
                } else {
                    let preview_len = b.len().min(16);
                    let hex: String = b[..preview_len].iter().map(|x| format!("{:02x}", x)).collect();
                    json!(format!(
                        "<blob {} B: {}{}>",
                        b.len(),
                        hex,
                        if b.len() > 16 { "..." } else { "" }
                    ))
                }
            }
        }
    }

    pub fn to_label_string(&self) -> String {
        match self {
            RawCell::Null => "(NULL)".to_string(),
            RawCell::Int(i) => i.to_string(),
            RawCell::Float(f) => {
                if !f.is_finite() {
                    "(NULL)".to_string()
                } else if (f.fract()).abs() < 1e-9 && f.abs() < 1e15 {
                    format!("{:.0}", f)
                } else {
                    format!("{:.4}", f)
                        .trim_end_matches('0')
                        .trim_end_matches('.')
                        .to_string()
                }
            }
            RawCell::Text(s) => s.clone(),
            RawCell::Blob(b) => format!("<blob {} B>", b.len()),
        }
    }

    pub fn as_finite_f64(&self) -> Option<f64> {
        match self {
            RawCell::Int(i) => Some(*i as f64),
            RawCell::Float(f) if f.is_finite() => Some(*f),
            RawCell::Text(s) => s.trim().parse::<f64>().ok().filter(|v| v.is_finite()),
            _ => None,
        }
    }
}

/// Attempt to decode a BLOB as UTF-8 numeric JSON array, packed little-endian f32s, or f64s.
fn decode_blob_vector(bytes: &[u8]) -> Option<Vec<f64>> {
    if bytes.is_empty() {
        return None;
    }
    if let Ok(s) = std::str::from_utf8(bytes) {
        if let Some(v) = parse_text_vector(s) {
            if v.len() >= 2 {
                return Some(v);
            }
        }
    }
    if bytes.len() >= 8 && bytes.len() % 4 == 0 && bytes.len() <= 65536 {
        let mut f32s = Vec::with_capacity(bytes.len() / 4);
        let mut ok_f32 = true;
        for chunk in bytes.chunks_exact(4) {
            let v = f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]) as f64;
            if !v.is_finite() || v.abs() > 1e12 {
                ok_f32 = false;
                break;
            }
            f32s.push(v);
        }
        if ok_f32 && !f32s.is_empty() {
            return Some(f32s);
        }
    }
    if bytes.len() >= 16 && bytes.len() % 8 == 0 && bytes.len() <= 131072 {
        let mut f64s = Vec::with_capacity(bytes.len() / 8);
        let mut ok_f64 = true;
        for chunk in bytes.chunks_exact(8) {
            let v = f64::from_le_bytes([
                chunk[0], chunk[1], chunk[2], chunk[3], chunk[4], chunk[5], chunk[6], chunk[7],
            ]);
            if !v.is_finite() || v.abs() > 1e15 {
                ok_f64 = false;
                break;
            }
            f64s.push(v);
        }
        if ok_f64 && !f64s.is_empty() {
            return Some(f64s);
        }
    }
    None
}

/// Parse a string into a numeric vector: scalar number, JSON array/object of numbers,
/// or comma/semicolon/whitespace-separated numeric list.
fn parse_text_vector(raw: &str) -> Option<Vec<f64>> {
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(v) = t.parse::<f64>() {
        if v.is_finite() {
            return Some(vec![v]);
        }
    }
    if (t.starts_with('[') && t.ends_with(']')) || (t.starts_with('{') && t.ends_with('}')) {
        if let Ok(val) = serde_json::from_str::<Value>(t) {
            match val {
                Value::Array(arr) => {
                    let mut out = Vec::with_capacity(arr.len());
                    for item in arr {
                        if let Some(n) = item.as_f64() {
                            if n.is_finite() {
                                out.push(n);
                            } else {
                                return None;
                            }
                        } else {
                            return None;
                        }
                    }
                    if !out.is_empty() {
                        return Some(out);
                    }
                }
                Value::Object(map) => {
                    let mut pairs: Vec<(String, f64)> = Vec::new();
                    for (k, v) in map {
                        if let Some(n) = v.as_f64().filter(|x| x.is_finite()) {
                            pairs.push((k, n));
                        }
                    }
                    if !pairs.is_empty() {
                        pairs.sort_by(|a, b| a.0.cmp(&b.0));
                        return Some(pairs.into_iter().map(|(_, v)| v).collect());
                    }
                }
                _ => {}
            }
        }
    }
    // Try bracketed or delimited numeric list: "1.2, 3.4, 5.6" or "(1, 2)"
    let stripped = t.trim_matches(|c| matches!(c, '[' | ']' | '(' | ')')).trim();
    let sep_parts: Vec<&str> = if stripped.contains(',') {
        stripped.split(',').collect()
    } else if stripped.contains(';') {
        stripped.split(';').collect()
    } else if stripped.contains(char::is_whitespace) {
        stripped.split_whitespace().collect()
    } else {
        return None;
    };
    if sep_parts.len() >= 2 {
        let mut out = Vec::with_capacity(sep_parts.len());
        for p in sep_parts {
            let p = p.trim();
            if p.is_empty() {
                continue;
            }
            if let Ok(n) = p.parse::<f64>() {
                if n.is_finite() {
                    out.push(n);
                } else {
                    return None;
                }
            } else {
                return None;
            }
        }
        if out.len() >= 2 {
            return Some(out);
        }
    }
    None
}

/// Extract normalized numeric feature vectors from a column across all rows.
/// Falls back to deterministic ordinal encoding for categorical string columns.
fn extract_column_vectors(rows: &[Vec<RawCell>], col_idx: usize) -> (Vec<Option<Vec<f64>>>, usize) {
    let mut parsed: Vec<Option<Vec<f64>>> = Vec::with_capacity(rows.len());
    let mut max_dim = 0usize;
    let mut non_null_count = 0usize;
    let mut numeric_count = 0usize;

    for r in rows {
        let cell = r.get(col_idx).unwrap_or(&RawCell::Null);
        match cell {
            RawCell::Null => parsed.push(None),
            RawCell::Int(i) => {
                non_null_count += 1;
                numeric_count += 1;
                max_dim = max_dim.max(1);
                parsed.push(Some(vec![*i as f64]));
            }
            RawCell::Float(f) if f.is_finite() => {
                non_null_count += 1;
                numeric_count += 1;
                max_dim = max_dim.max(1);
                parsed.push(Some(vec![*f]));
            }
            RawCell::Text(s) => {
                non_null_count += 1;
                if let Some(v) = parse_text_vector(s) {
                    numeric_count += 1;
                    max_dim = max_dim.max(v.len());
                    parsed.push(Some(v));
                } else {
                    parsed.push(None);
                }
            }
            RawCell::Blob(b) => {
                non_null_count += 1;
                if let Some(v) = decode_blob_vector(b) {
                    numeric_count += 1;
                    max_dim = max_dim.max(v.len());
                    parsed.push(Some(v));
                } else {
                    parsed.push(None);
                }
            }
            _ => parsed.push(None),
        }
    }

    // If the column is non-numeric (e.g., categorical strings), encode ordinally so it still plots cleanly
    if numeric_count == 0 && non_null_count > 0 {
        let mut uniq: BTreeMap<String, usize> = BTreeMap::new();
        for r in rows {
            if let Some(cell) = r.get(col_idx) {
                if !matches!(cell, RawCell::Null) {
                    uniq.entry(cell.to_label_string()).or_insert(0);
                }
            }
        }
        for (idx, (_, v)) in uniq.iter_mut().enumerate() {
            *v = idx;
        }
        let mut ord = Vec::with_capacity(rows.len());
        for r in rows {
            match r.get(col_idx) {
                Some(RawCell::Null) | None => ord.push(None),
                Some(cell) => {
                    let k = cell.to_label_string();
                    let code = uniq.get(&k).copied().unwrap_or(0) as f64;
                    ord.push(Some(vec![code]));
                }
            }
        }
        return (ord, 1);
    }

    // Pad ragged vectors with 0.0 to `max_dim`
    if max_dim > 1 {
        for slot in &mut parsed {
            if let Some(v) = slot {
                if v.len() < max_dim {
                    v.resize(max_dim, 0.0);
                }
            }
        }
    }
    (parsed, max_dim)
}

// ============================================================================
// Linear Algebra & Dimensionality Reduction: PCA, t-SNE, K-Means++
// ============================================================================

/// Symmetric Jacobi eigendecomposition of an `m x m` symmetric matrix `a` (stored row-major).
/// Returns `(eigenvalues, eigenvectors)` sorted descending by eigenvalue.
/// Each eigenvector has length `m`.
fn jacobi_eigen_symmetric(mut a: Vec<f64>, m: usize) -> (Vec<f64>, Vec<Vec<f64>>) {
    let mut v = vec![0.0f64; m * m];
    for i in 0..m {
        v[i * m + i] = 1.0;
    }
    if m <= 1 {
        let eval = if m == 1 { vec![a[0]] } else { vec![] };
        let evec = if m == 1 { vec![vec![1.0]] } else { vec![] };
        return (eval, evec);
    }

    let max_sweeps = 60 * m * m;
    for _ in 0..max_sweeps {
        // Find largest off-diagonal element
        let mut p = 0;
        let mut q = 1;
        let mut max_off = 0.0f64;
        for i in 0..m {
            for j in (i + 1)..m {
                let val = a[i * m + j].abs();
                if val > max_off {
                    max_off = val;
                    p = i;
                    q = j;
                }
            }
        }
        if max_off < 1e-11 {
            break;
        }
        let app = a[p * m + p];
        let aqq = a[q * m + q];
        let apq = a[p * m + q];
        let tau = (aqq - app) / (2.0 * apq);
        let t = if tau >= 0.0 {
            1.0 / (tau + (1.0 + tau * tau).sqrt())
        } else {
            -1.0 / (-tau + (1.0 + tau * tau).sqrt())
        };
        let c = 1.0 / (1.0 + t * t).sqrt();
        let s = t * c;

        a[p * m + p] = app - t * apq;
        a[q * m + q] = aqq + t * apq;
        a[p * m + q] = 0.0;
        a[q * m + p] = 0.0;

        for r in 0..m {
            if r == p || r == q {
                continue;
            }
            let arp = a[r * m + p];
            let arq = a[r * m + q];
            a[r * m + p] = c * arp - s * arq;
            a[p * m + r] = a[r * m + p];
            a[r * m + q] = s * arp + c * arq;
            a[q * m + r] = a[r * m + q];
        }
        for r in 0..m {
            let vrp = v[r * m + p];
            let vrq = v[r * m + q];
            v[r * m + p] = c * vrp - s * vrq;
            v[r * m + q] = s * vrp + c * vrq;
        }
    }

    let mut pairs: Vec<(f64, Vec<f64>)> = (0..m)
        .map(|i| {
            let mut col = Vec::with_capacity(m);
            for r in 0..m {
                col.push(v[r * m + i]);
            }
            (a[i * m + i], col)
        })
        .collect();
    pairs.sort_by(|x, y| y.0.partial_cmp(&x.0).unwrap_or(std::cmp::Ordering::Equal));
    let evals = pairs.iter().map(|p| p.0).collect();
    let evecs = pairs.into_iter().map(|p| p.1).collect();
    (evals, evecs)
}

/// Power iteration with Hotelling deflation for extracting top `n_comp` eigenvectors of a large symmetric matrix.
fn power_iter_top_eigen(mat: &[f64], m: usize, n_comp: usize) -> (Vec<f64>, Vec<Vec<f64>>) {
    let mut work = mat.to_vec();
    let mut evals: Vec<f64> = Vec::with_capacity(n_comp);
    let mut evecs: Vec<Vec<f64>> = Vec::with_capacity(n_comp);

    for comp in 0..n_comp.min(m) {
        let mut vec = vec![0.0f64; m];
        for i in 0..m {
            // Deterministic non-zero seed vector
            vec[i] = ((i.wrapping_mul(2654435761) ^ (comp + 1).wrapping_mul(40503)) as f64)
                .sin()
                + 0.1;
        }
        let mut norm = vec.iter().map(|x| x * x).sum::<f64>().sqrt();
        if norm > 0.0 {
            for x in &mut vec {
                *x /= norm;
            }
        }

        let mut next = vec![0.0f64; m];
        let mut lambda = 0.0f64;
        for _ in 0..120 {
            for i in 0..m {
                let row = &work[i * m..(i + 1) * m];
                let mut sum = 0.0f64;
                for j in 0..m {
                    sum += row[j] * vec[j];
                }
                next[i] = sum;
            }
            // Orthogonalize against previously found eigenvectors
            for prev in &evecs {
                let dot: f64 = next.iter().zip(prev.iter()).map(|(a, b)| a * b).sum();
                for i in 0..m {
                    next[i] -= dot * prev[i];
                }
            }
            norm = next.iter().map(|x| x * x).sum::<f64>().sqrt();
            if norm < 1e-13 {
                lambda = 0.0;
                break;
            }
            let mut diff = 0.0f64;
            for i in 0..m {
                let nv = next[i] / norm;
                diff += (nv - vec[i]).abs();
                vec[i] = nv;
            }
            lambda = norm;
            if diff < 1e-9 {
                break;
            }
        }
        // Deflate
        for i in 0..m {
            for j in 0..m {
                work[i * m + j] -= lambda * vec[i] * vec[j];
            }
        }
        evals.push(lambda.max(0.0));
        evecs.push(vec);
    }
    (evals, evecs)
}

/// PCA projection model capable of projecting both data points and auxiliary vectors (e.g., centroids).
struct PcaModel {
    mean: Vec<f64>,
    components: Vec<Vec<f64>>, // length `n_comp`, each of length `d`
    explained_ratio: Vec<f64>,
}

impl PcaModel {
    fn fit(data: &[Vec<f64>], n_comp: usize) -> Self {
        let n = data.len();
        let d = data.first().map(|r| r.len()).unwrap_or(0);
        if n == 0 || d == 0 {
            return Self {
                mean: vec![],
                components: vec![],
                explained_ratio: vec![],
            };
        }

        let mut mean = vec![0.0f64; d];
        for row in data {
            for j in 0..d {
                mean[j] += row[j];
            }
        }
        for m in &mut mean {
            *m /= n as f64;
        }

        let centered: Vec<Vec<f64>> = data
            .iter()
            .map(|r| r.iter().enumerate().map(|(j, &v)| v - mean[j]).collect())
            .collect();

        let total_var: f64 = centered
            .iter()
            .flat_map(|r| r.iter())
            .map(|x| x * x)
            .sum::<f64>()
            / (n.max(1) as f64);

        let k = n_comp.min(d).min(n.max(1));

        // Use primal covariance (d x d) when d <= n, or dual Gram matrix (n x n) when d > n!
        // This makes 768-dim embeddings with 200 rows ~20x faster and exact.
        let (evals, components) = if d <= n {
            let mut cov = vec![0.0f64; d * d];
            for r in &centered {
                for i in 0..d {
                    let ri = r[i];
                    let row_off = i * d;
                    for j in i..d {
                        cov[row_off + j] += ri * r[j];
                    }
                }
            }
            let inv_n = 1.0 / (n as f64);
            for i in 0..d {
                for j in i..d {
                    let v = cov[i * d + j] * inv_n;
                    cov[i * d + j] = v;
                    cov[j * d + i] = v;
                }
            }
            let (ev, vecs) = if d <= 64 {
                jacobi_eigen_symmetric(cov, d)
            } else {
                power_iter_top_eigen(&cov, d, k)
            };
            (ev.into_iter().take(k).collect::<Vec<_>>(), vecs.into_iter().take(k).collect::<Vec<_>>())
        } else {
            // Dual Gram matrix G = (1/n) * X * X^T (size n x n)
            let mut gram = vec![0.0f64; n * n];
            let inv_n = 1.0 / (n as f64);
            for i in 0..n {
                for j in i..n {
                    let mut dot = 0.0f64;
                    let ri = &centered[i];
                    let rj = &centered[j];
                    for c in 0..d {
                        dot += ri[c] * rj[c];
                    }
                    let v = dot * inv_n;
                    gram[i * n + j] = v;
                    gram[j * n + i] = v;
                }
            }
            let (ev, u_vecs) = if n <= 64 {
                jacobi_eigen_symmetric(gram, n)
            } else {
                power_iter_top_eigen(&gram, n, k)
            };
            let mut comps = Vec::with_capacity(k);
            let mut kept_ev = Vec::with_capacity(k);
            for idx in 0..k.min(u_vecs.len()) {
                let u = &u_vecs[idx];
                let mut w = vec![0.0f64; d];
                for i in 0..n {
                    let ui = u[i];
                    for c in 0..d {
                        w[c] += ui * centered[i][c];
                    }
                }
                let norm = w.iter().map(|x| x * x).sum::<f64>().sqrt();
                if norm > 1e-12 {
                    for x in &mut w {
                        *x /= norm;
                    }
                }
                comps.push(w);
                kept_ev.push(ev[idx].max(0.0));
            }
            (kept_ev, comps)
        };

        let explained_ratio: Vec<f64> = evals
            .iter()
            .map(|&e| if total_var > 1e-15 { (e / total_var).clamp(0.0, 1.0) } else { 0.0 })
            .collect();

        Self {
            mean,
            components,
            explained_ratio,
        }
    }

    fn transform_one(&self, row: &[f64]) -> Vec<f64> {
        self.components
            .iter()
            .map(|comp| {
                comp.iter()
                    .enumerate()
                    .map(|(j, &w)| w * (row.get(j).copied().unwrap_or(0.0) - self.mean[j]))
                    .sum()
            })
            .collect()
    }

    fn transform_all(&self, data: &[Vec<f64>]) -> Vec<Vec<f64>> {
        data.iter().map(|r| self.transform_one(r)).collect()
    }
}

/// Deterministic K-Means++ clustering in full feature space.
/// Returns `(assignments, centroids_in_full_space)`.
fn kmeans_plus_plus(data: &[Vec<f64>], k_req: usize) -> (Vec<usize>, Vec<Vec<f64>>) {
    let n = data.len();
    let d = data.first().map(|r| r.len()).unwrap_or(0);
    if n == 0 || d == 0 {
        return (vec![], vec![]);
    }
    let k = k_req.clamp(1, n);

    let sq_dist = |a: &[f64], b: &[f64]| -> f64 {
        a.iter().zip(b.iter()).map(|(x, y)| (x - y) * (x - y)).sum()
    };

    // Standardize dimensions for balanced clustering across different scales
    let mut mean = vec![0.0f64; d];
    for r in data {
        for j in 0..d {
            mean[j] += r[j];
        }
    }
    for m in &mut mean {
        *m /= n as f64;
    }
    let mut std = vec![0.0f64; d];
    for r in data {
        for j in 0..d {
            let diff = r[j] - mean[j];
            std[j] += diff * diff;
        }
    }
    for s in &mut std {
        *s = (*s / n as f64).sqrt();
        if *s < 1e-9 {
            *s = 1.0;
        }
    }
    let norm_data: Vec<Vec<f64>> = data
        .iter()
        .map(|r| r.iter().enumerate().map(|(j, &v)| (v - mean[j]) / std[j]).collect())
        .collect();

    // Deterministic K-Means++ initialization (pick farthest points iteratively)
    let mut centers: Vec<Vec<f64>> = Vec::with_capacity(k);
    centers.push(norm_data[0].clone());
    let mut min_d2 = vec![f64::INFINITY; n];
    for _ in 1..k {
        let last = centers.last().unwrap();
        let mut best_idx = 0;
        let mut best_dist = -1.0f64;
        for i in 0..n {
            let d2 = sq_dist(&norm_data[i], last);
            if d2 < min_d2[i] {
                min_d2[i] = d2;
            }
            if min_d2[i] > best_dist {
                best_dist = min_d2[i];
                best_idx = i;
            }
        }
        centers.push(norm_data[best_idx].clone());
    }

    let mut assign = vec![0usize; n];
    for _ in 0..50 {
        let mut changed = false;
        for i in 0..n {
            let mut best_c = 0;
            let mut best_d = f64::INFINITY;
            for (c_idx, center) in centers.iter().enumerate() {
                let d2 = sq_dist(&norm_data[i], center);
                if d2 < best_d {
                    best_d = d2;
                    best_c = c_idx;
                }
            }
            if assign[i] != best_c {
                assign[i] = best_c;
                changed = true;
            }
        }
        if !changed {
            break;
        }
        let mut sums = vec![vec![0.0f64; d]; k];
        let mut counts = vec![0usize; k];
        for i in 0..n {
            let c = assign[i];
            counts[c] += 1;
            for j in 0..d {
                sums[c][j] += norm_data[i][j];
            }
        }
        for c in 0..k {
            if counts[c] > 0 {
                let inv = 1.0 / counts[c] as f64;
                for j in 0..d {
                    centers[c][j] = sums[c][j] * inv;
                }
            }
        }
    }

    // Compute centroids in original feature space
    let mut orig_centers = vec![vec![0.0f64; d]; k];
    let mut counts = vec![0usize; k];
    for i in 0..n {
        let c = assign[i];
        counts[c] += 1;
        for j in 0..d {
            orig_centers[c][j] += data[i][j];
        }
    }
    for c in 0..k {
        if counts[c] > 0 {
            let inv = 1.0 / counts[c] as f64;
            for j in 0..d {
                orig_centers[c][j] *= inv;
            }
        }
    }
    (assign, orig_centers)
}

/// 2D t-SNE embedding (PCA-initialized, binary-searched perplexity, early exaggeration + momentum).
fn tsne_2d(data: &[Vec<f64>]) -> Vec<[f64; 2]> {
    let n = data.len();
    if n == 0 {
        return vec![];
    }
    if n == 1 {
        return vec![[0.0, 0.0]];
    }
    if n == 2 {
        return vec![[-1.0, 0.0], [1.0, 0.0]];
    }

    // Pre-reduce high-dimensional data to <= 25 dims via PCA for speed & noise suppression
    let d = data[0].len();
    let working: Vec<Vec<f64>> = if d > 25 {
        let pre = PcaModel::fit(data, 25);
        pre.transform_all(data)
    } else {
        data.to_vec()
    };

    // PCA 2D initialization (scaled small) for reproducible, well-aligned layouts
    let init_pca = PcaModel::fit(&working, 2);
    let init_proj = init_pca.transform_all(&working);
    let mut y: Vec<[f64; 2]> = init_proj
        .iter()
        .enumerate()
        .map(|(i, p)| {
            let x0 = p.first().copied().unwrap_or(0.0);
            let y0 = p.get(1).copied().unwrap_or(((i as f64) * 1.618).sin() * 1e-4);
            [x0, y0]
        })
        .collect();
    let max_coord = y
        .iter()
        .flat_map(|p| [p[0].abs(), p[1].abs()])
        .fold(0.0f64, f64::max)
        .max(1e-9);
    for p in &mut y {
        p[0] = (p[0] / max_coord) * 0.05;
        p[1] = (p[1] / max_coord) * 0.05;
    }

    // Pairwise squared Euclidean distances
    let wd = working[0].len();
    let mut dist2 = vec![0.0f64; n * n];
    for i in 0..n {
        for j in (i + 1)..n {
            let mut s = 0.0f64;
            for c in 0..wd {
                let diff = working[i][c] - working[j][c];
                s += diff * diff;
            }
            dist2[i * n + j] = s;
            dist2[j * n + i] = s;
        }
    }

    // Compute symmetric P matrix via perplexity binary search
    let perplexity = ((n as f64 - 1.0) / 3.0).clamp(2.0, 30.0);
    let target_h = perplexity.ln();
    let mut p_mat = vec![0.0f64; n * n];

    for i in 0..n {
        let mut beta = 1.0f64;
        let mut beta_min = 0.0f64;
        let mut beta_max = f64::INFINITY;
        let mut row_p = vec![0.0f64; n];

        for _ in 0..35 {
            let mut sum_p = 0.0f64;
            for j in 0..n {
                if i == j {
                    row_p[j] = 0.0;
                } else {
                    let val = (-dist2[i * n + j] * beta).exp();
                    row_p[j] = val;
                    sum_p += val;
                }
            }
            if sum_p < 1e-30 {
                sum_p = 1e-30;
            }
            let mut h = 0.0f64;
            for j in 0..n {
                if i != j {
                    row_p[j] /= sum_p;
                    if row_p[j] > 1e-30 {
                        h -= row_p[j] * row_p[j].ln();
                    }
                }
            }
            let diff = h - target_h;
            if diff.abs() < 1e-4 {
                break;
            }
            if diff > 0.0 {
                beta_min = beta;
                beta = if beta_max.is_infinite() { beta * 2.0 } else { 0.5 * (beta + beta_max) };
            } else {
                beta_max = beta;
                beta = 0.5 * (beta + beta_min);
            }
        }
        for j in 0..n {
            p_mat[i * n + j] = row_p[j];
        }
    }

    // Symmetrize P = (P + P^T) / (2N)
    let inv_2n = 1.0 / (2.0 * n as f64);
    for i in 0..n {
        for j in (i + 1)..n {
            let sym = ((p_mat[i * n + j] + p_mat[j * n + i]) * inv_2n).max(1e-12);
            p_mat[i * n + j] = sym;
            p_mat[j * n + i] = sym;
        }
        p_mat[i * n + i] = 0.0;
    }

    // Gradient descent (cap iterations based on n to keep latency snappy)
    let iters = if n <= 200 {
        220
    } else if n <= 600 {
        140
    } else {
        80
    };
    let lr = 120.0f64;
    let mut vel = vec![[0.0f64; 2]; n];
    let mut grad = vec![[0.0f64; 2]; n];
    let mut q_num = vec![0.0f64; n * n];

    for it in 0..iters {
        let exag = if it < iters / 4 { 4.0 } else { 1.0 };
        let mom = if it < iters / 3 { 0.5 } else { 0.8 };

        let mut sum_q = 0.0f64;
        for i in 0..n {
            q_num[i * n + i] = 0.0;
            for j in (i + 1)..n {
                let dx = y[i][0] - y[j][0];
                let dy = y[i][1] - y[j][1];
                let q = 1.0 / (1.0 + dx * dx + dy * dy);
                q_num[i * n + j] = q;
                q_num[j * n + i] = q;
                sum_q += 2.0 * q;
            }
        }
        let inv_sum_q = 1.0 / sum_q.max(1e-12);

        for i in 0..n {
            let mut gx = 0.0f64;
            let mut gy = 0.0f64;
            let row_off = i * n;
            for j in 0..n {
                if i == j {
                    continue;
                }
                let qij = (q_num[row_off + j] * inv_sum_q).max(1e-12);
                let mult = 4.0 * (exag * p_mat[row_off + j] - qij) * q_num[row_off + j];
                gx += mult * (y[i][0] - y[j][0]);
                gy += mult * (y[i][1] - y[j][1]);
            }
            grad[i] = [gx, gy];
        }

        let mut mx = 0.0f64;
        let mut my = 0.0f64;
        for i in 0..n {
            vel[i][0] = mom * vel[i][0] - lr * grad[i][0];
            vel[i][1] = mom * vel[i][1] - lr * grad[i][1];
            y[i][0] += vel[i][0];
            y[i][1] += vel[i][1];
            mx += y[i][0];
            my += y[i][1];
        }
        mx /= n as f64;
        my /= n as f64;
        for i in 0..n {
            y[i][0] -= mx;
            y[i][1] -= my;
        }
    }
    y
}

// ============================================================================
// Arbitrary-Type Color Column Grouping & Main Cluster Plot Pipeline
// ============================================================================

fn build_color_encoding(
    raw_rows: &[Vec<RawCell>],
    valid_indices: &[usize],
    color_col_name: Option<&str>,
    color_col_idx: Option<usize>,
    cluster_assignments: Option<&[usize]>,
    cluster_k: usize,
) -> (ColorEncoding, Vec<(Option<usize>, Value, String)>) {
    let n = valid_indices.len();

    // Explicit "(cluster)" mode or fallback to K-Means clusters if no color column selected
    if color_col_name == Some("__cluster__") || (color_col_idx.is_none() && cluster_assignments.is_some()) {
        if let Some(assign) = cluster_assignments {
            let mut counts = vec![0usize; cluster_k.max(1)];
            let mut per_point = Vec::with_capacity(n);
            for &c in assign {
                if c < counts.len() {
                    counts[c] += 1;
                }
                let label = format!("Cluster {}", c + 1);
                per_point.push((Some(c), json!(c + 1), label));
            }
            let categories: Vec<ColorCategory> = counts
                .iter()
                .enumerate()
                .filter(|(_, &cnt)| cnt > 0)
                .map(|(i, &cnt)| ColorCategory {
                    index: i,
                    label: format!("Cluster {}", i + 1),
                    color: CLUSTER_PALETTE[i % CLUSTER_PALETTE.len()].to_string(),
                    count: cnt,
                })
                .collect();
            return (
                ColorEncoding {
                    mode: "cluster".to_string(),
                    column: Some("K-Means Cluster".to_string()),
                    categories,
                    min: None,
                    max: None,
                },
                per_point,
            );
        }
    }

    let Some(cidx) = color_col_idx else {
        let per_point = vec![(Some(0), Value::Null, "All Points".to_string()); n];
        return (
            ColorEncoding {
                mode: "none".to_string(),
                column: None,
                categories: vec![],
                min: None,
                max: None,
            },
            per_point,
        );
    };

    // Inspect values of the color column across valid rows
    let mut numeric_vals: Vec<Option<f64>> = Vec::with_capacity(n);
    let mut non_null_total = 0usize;
    let mut numeric_total = 0usize;
    let mut label_counts: HashMap<String, usize> = HashMap::new();

    for &ri in valid_indices {
        let cell = raw_rows[ri].get(cidx).unwrap_or(&RawCell::Null);
        let lbl = cell.to_label_string();
        *label_counts.entry(lbl).or_insert(0) += 1;
        if !matches!(cell, RawCell::Null) {
            non_null_total += 1;
            if let Some(v) = cell.as_finite_f64() {
                numeric_total += 1;
                numeric_vals.push(Some(v));
            } else {
                numeric_vals.push(None);
            }
        } else {
            numeric_vals.push(None);
        }
    }

    let col_label = color_col_name.map(String::from);

    // High-cardinality purely numeric column (> 16 unique values) -> smooth continuous color scale!
    // Low-cardinality numeric or ANY non-numeric/string/mixed column -> discrete color groups!
    let is_continuous = non_null_total > 0 && numeric_total == non_null_total && label_counts.len() > 16;

    if is_continuous {
        let mut vmin = f64::INFINITY;
        let mut vmax = f64::NEG_INFINITY;
        for v in numeric_vals.iter().flatten() {
            if *v < vmin {
                vmin = *v;
            }
            if *v > vmax {
                vmax = *v;
            }
        }
        let mut per_point = Vec::with_capacity(n);
        for (i, &ri) in valid_indices.iter().enumerate() {
            let cell = raw_rows[ri].get(cidx).unwrap_or(&RawCell::Null);
            let lbl = cell.to_label_string();
            let val = match numeric_vals[i] {
                Some(f) => json!(f),
                None => Value::Null,
            };
            per_point.push((None, val, lbl));
        }
        return (
            ColorEncoding {
                mode: "continuous".to_string(),
                column: col_label,
                categories: vec![],
                min: Some(vmin),
                max: Some(vmax),
            },
            per_point,
        );
    }

    // Categorical grouping (strings, booleans, low-cardinality numbers, NULLs, mixed types)
    let mut ranked: Vec<(String, usize)> = label_counts.into_iter().collect();
    ranked.sort_by(|a, b| {
        // Put (NULL) last; otherwise sort by frequency desc, then lexicographically
        let a_null = a.0 == "(NULL)";
        let b_null = b.0 == "(NULL)";
        a_null
            .cmp(&b_null)
            .then_with(|| b.1.cmp(&a.1))
            .then_with(|| a.0.cmp(&b.0))
    });

    const MAX_GROUPS: usize = 15;
    let has_other = ranked.len() > MAX_GROUPS + 1;
    let mut label_to_group: HashMap<String, usize> = HashMap::new();
    let mut categories: Vec<ColorCategory> = Vec::new();
    let mut other_count = 0usize;

    for (idx, (lbl, cnt)) in ranked.iter().enumerate() {
        if has_other && idx >= MAX_GROUPS {
            other_count += *cnt;
            label_to_group.insert(lbl.clone(), MAX_GROUPS);
        } else {
            let color = if lbl == "(NULL)" {
                "#64748b".to_string()
            } else {
                CLUSTER_PALETTE[categories.len() % CLUSTER_PALETTE.len()].to_string()
            };
            label_to_group.insert(lbl.clone(), categories.len());
            categories.push(ColorCategory {
                index: categories.len(),
                label: lbl.clone(),
                color,
                count: *cnt,
            });
        }
    }
    if has_other && other_count > 0 {
        let other_idx = categories.len();
        categories.push(ColorCategory {
            index: other_idx,
            label: format!("Other ({} values)", ranked.len() - MAX_GROUPS),
            color: "#94a3b8".to_string(),
            count: other_count,
        });
    }

    let mut per_point = Vec::with_capacity(n);
    for &ri in valid_indices {
        let cell = raw_rows[ri].get(cidx).unwrap_or(&RawCell::Null);
        let lbl = cell.to_label_string();
        let grp = label_to_group.get(&lbl).copied().unwrap_or(0);
        per_point.push((Some(grp), cell.to_display_json(), lbl));
    }

    (
        ColorEncoding {
            mode: "categorical".to_string(),
            column: col_label,
            categories,
            min: None,
            max: None,
        },
        per_point,
    )
}

pub fn build_cluster_response(
    rel_path: &str,
    source_label: String,
    columns: Vec<String>,
    raw_rows: Vec<Vec<RawCell>>,
    truncated: bool,
    req: &SqliteClusterRequest,
    start: std::time::Instant,
) -> Result<SqliteClusterResponse, String> {
    let x_idx = columns
        .iter()
        .position(|c| c == &req.x_col)
        .ok_or_else(|| format!("X column '{}' not found in result set", req.x_col))?;

    let y_col_effective = req
        .y_col
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "__same__");
    let same_col = y_col_effective.is_none() || y_col_effective == Some(req.x_col.as_str());
    let y_idx = if let Some(yc) = y_col_effective {
        columns
            .iter()
            .position(|c| c == yc)
            .ok_or_else(|| format!("Y column '{}' not found in result set", yc))?
    } else {
        x_idx
    };

    let color_col_req = req
        .color_col
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty() && *s != "__none__");
    let color_idx = match color_col_req {
        Some("__cluster__") | None => None,
        Some(cname) => Some(
            columns
                .iter()
                .position(|c| c == cname)
                .ok_or_else(|| format!("Color column '{}' not found in result set", cname))?,
        ),
    };

    let (x_vecs, x_dim) = extract_column_vectors(&raw_rows, x_idx);
    let (y_vecs, y_dim) = if same_col {
        (x_vecs.clone(), x_dim)
    } else {
        extract_column_vectors(&raw_rows, y_idx)
    };

    // Collect rows that have valid data in both X and Y
    let mut valid_indices = Vec::new();
    let mut valid_x = Vec::new();
    let mut valid_y = Vec::new();
    for i in 0..raw_rows.len() {
        if let (Some(xv), Some(yv)) = (&x_vecs[i], &y_vecs[i]) {
            valid_indices.push(i);
            valid_x.push(xv.clone());
            valid_y.push(yv.clone());
        }
    }

    if valid_indices.is_empty() {
        return Err("No plottable non-null rows found for the selected columns".to_string());
    }

    let is_multidim = x_dim > 1 || y_dim > 1;
    let algo_req = req.algorithm.trim().to_lowercase();
    let algo = match algo_req.as_str() {
        "" | "auto" => {
            if is_multidim {
                "pca"
            } else {
                "direct"
            }
        }
        "direct" | "pca" | "tsne" | "kmeans_pca" | "per_col_pca" => algo_req.as_str(),
        _ => "auto",
    };

    // Build combined feature matrix (used by PCA / t-SNE / K-Means)
    let combined: Vec<Vec<f64>> = if same_col {
        valid_x.clone()
    } else {
        valid_x
            .iter()
            .zip(valid_y.iter())
            .map(|(xv, yv)| {
                let mut v = Vec::with_capacity(xv.len() + yv.len());
                v.extend_from_slice(xv);
                v.extend_from_slice(yv);
                v
            })
            .collect()
    };
    let total_dim = combined.first().map(|r| r.len()).unwrap_or(0);

    let want_kmeans = algo == "kmeans_pca" || color_col_req == Some("__cluster__");
    let k = req.k.clamp(2, 16).min(valid_indices.len().max(1));
    let (cluster_assign, full_centroids) = if want_kmeans {
        let (a, c) = kmeans_plus_plus(&combined, k);
        (Some(a), Some(c))
    } else {
        (None, None)
    };

    let y_name = y_col_effective.unwrap_or(&req.x_col);
    let mut explained_variance: Option<[f64; 2]> = None;
    let mut coords: Vec<[f64; 2]> = Vec::with_capacity(valid_indices.len());
    let mut centroids_2d: Vec<ClusterCentroid> = Vec::new();
    let (x_label, y_label, algo_used);

    match algo {
        "direct" => {
            for i in 0..valid_indices.len() {
                let cx = valid_x[i].first().copied().unwrap_or(0.0);
                let cy = if same_col {
                    valid_x[i].get(1).copied().unwrap_or(cx)
                } else {
                    valid_y[i].first().copied().unwrap_or(0.0)
                };
                coords.push([cx, cy]);
            }
            if let (Some(assign), Some(_)) = (&cluster_assign, &full_centroids) {
                centroids_2d = compute_2d_centroids(&coords, assign, k);
            }
            x_label = if x_dim > 1 {
                format!("{}[0]", req.x_col)
            } else {
                req.x_col.clone()
            };
            y_label = if same_col && x_dim > 1 {
                format!("{}[1]", req.x_col)
            } else if y_dim > 1 {
                format!("{}[0]", y_name)
            } else {
                y_name.to_string()
            };
            algo_used = "direct".to_string();
        }
        "per_col_pca" => {
            let x_1d: Vec<f64> = if x_dim > 1 {
                let m = PcaModel::fit(&valid_x, 1);
                m.transform_all(&valid_x).into_iter().map(|v| v[0]).collect()
            } else {
                valid_x.iter().map(|v| v[0]).collect()
            };
            let y_1d: Vec<f64> = if same_col && x_dim > 1 {
                let m = PcaModel::fit(&valid_x, 2);
                m.transform_all(&valid_x)
                    .into_iter()
                    .map(|v| v.get(1).copied().unwrap_or(0.0))
                    .collect()
            } else if y_dim > 1 {
                let m = PcaModel::fit(&valid_y, 1);
                m.transform_all(&valid_y).into_iter().map(|v| v[0]).collect()
            } else {
                valid_y.iter().map(|v| v[0]).collect()
            };
            for i in 0..valid_indices.len() {
                coords.push([x_1d[i], y_1d[i]]);
            }
            if let Some(assign) = &cluster_assign {
                centroids_2d = compute_2d_centroids(&coords, assign, k);
            }
            x_label = if x_dim > 1 {
                format!("{} (PC1 of {}D)", req.x_col, x_dim)
            } else {
                req.x_col.clone()
            };
            y_label = if same_col && x_dim > 1 {
                format!("{} (PC2 of {}D)", req.x_col, x_dim)
            } else if y_dim > 1 {
                format!("{} (PC1 of {}D)", y_name, y_dim)
            } else {
                y_name.to_string()
            };
            algo_used = "per_col_pca".to_string();
        }
        "tsne" => {
            coords = tsne_2d(&combined);
            if let Some(assign) = &cluster_assign {
                centroids_2d = compute_2d_centroids(&coords, assign, k);
            }
            x_label = format!("t-SNE 1 ({}D)", total_dim);
            y_label = format!("t-SNE 2 ({}D)", total_dim);
            algo_used = "tsne".to_string();
        }
        _ => {
            // "pca" or "kmeans_pca"
            let model = PcaModel::fit(&combined, 2);
            let proj = model.transform_all(&combined);
            for p in &proj {
                coords.push([
                    p.first().copied().unwrap_or(0.0),
                    p.get(1).copied().unwrap_or(0.0),
                ]);
            }
            let ev1 = model.explained_ratio.first().copied().unwrap_or(0.0);
            let ev2 = model.explained_ratio.get(1).copied().unwrap_or(0.0);
            explained_variance = Some([ev1, ev2]);

            if let (Some(assign), Some(fcent)) = (&cluster_assign, &full_centroids) {
                let mut counts = vec![0usize; k];
                for &c in assign {
                    if c < counts.len() {
                        counts[c] += 1;
                    }
                }
                for (ci, cvec) in fcent.iter().enumerate() {
                    if counts[ci] == 0 {
                        continue;
                    }
                    let cp = model.transform_one(cvec);
                    centroids_2d.push(ClusterCentroid {
                        cluster: ci,
                        x: cp.first().copied().unwrap_or(0.0),
                        y: cp.get(1).copied().unwrap_or(0.0),
                        count: counts[ci],
                        label: format!("Cluster {}", ci + 1),
                    });
                }
            }
            x_label = format!("PC1 ({:.1}% var · {}D)", ev1 * 100.0, total_dim);
            y_label = format!("PC2 ({:.1}% var · {}D)", ev2 * 100.0, total_dim);
            algo_used = if algo == "kmeans_pca" {
                "kmeans_pca".to_string()
            } else {
                "pca".to_string()
            };
        }
    }

    let (color_enc, per_point_colors) = build_color_encoding(
        &raw_rows,
        &valid_indices,
        color_col_req,
        color_idx,
        cluster_assign.as_deref(),
        k,
    );

    let mut points = Vec::with_capacity(valid_indices.len());
    for (i, &ri) in valid_indices.iter().enumerate() {
        let (cg, cv, cl) = per_point_colors[i].clone();
        points.push(ClusterPoint {
            row_index: ri,
            x: coords[i][0],
            y: coords[i][1],
            color_group: cg,
            color_value: cv,
            color_label: cl,
            cluster: cluster_assign.as_ref().map(|a| a[i]),
        });
    }

    let display_rows: Vec<Vec<Value>> = raw_rows
        .iter()
        .map(|r| r.iter().map(RawCell::to_display_json).collect())
        .collect();

    Ok(SqliteClusterResponse {
        path: rel_path.to_string(),
        source_label,
        algorithm_used: algo_used,
        x_label,
        y_label,
        x_dim,
        y_dim,
        total_dim,
        explained_variance,
        columns,
        rows: display_rows,
        points,
        centroids: centroids_2d,
        color: color_enc,
        truncated,
        duration_ms: start.elapsed().as_secs_f64() * 1000.0,
    })
}

fn compute_2d_centroids(coords: &[[f64; 2]], assign: &[usize], k: usize) -> Vec<ClusterCentroid> {
    let mut sx = vec![0.0f64; k];
    let mut sy = vec![0.0f64; k];
    let mut counts = vec![0usize; k];
    for (i, &c) in assign.iter().enumerate() {
        if c < k {
            sx[c] += coords[i][0];
            sy[c] += coords[i][1];
            counts[c] += 1;
        }
    }
    let mut out = Vec::new();
    for c in 0..k {
        if counts[c] > 0 {
            out.push(ClusterCentroid {
                cluster: c,
                x: sx[c] / counts[c] as f64,
                y: sy[c] / counts[c] as f64,
                count: counts[c],
                label: format!("Cluster {}", c + 1),
            });
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blob_vector_decoding_and_high_dim_dual_pca() {
        // Build 12 rows with 32-dim packed little-endian f32 BLOB embeddings (D > N triggers dual Gram PCA!)
        let mut raw_rows = Vec::new();
        for i in 0..12 {
            let grp = if i < 6 { "cluster_a" } else { "cluster_b" };
            let mut blob = Vec::with_capacity(32 * 4);
            for d in 0..32 {
                let v: f32 = if i < 6 {
                    if d < 16 { 10.0 + (i as f32) * 0.1 } else { -10.0 + (d as f32) * 0.05 }
                } else {
                    if d < 16 { -10.0 + (i as f32) * 0.1 } else { 10.0 + (d as f32) * 0.05 }
                };
                blob.extend_from_slice(&v.to_le_bytes());
            }
            raw_rows.push(vec![
                RawCell::Int(i as i64 + 1),
                RawCell::Text(grp.to_string()),
                RawCell::Blob(blob),
            ]);
        }

        let req = SqliteClusterRequest {
            path: "test.sqlite".to_string(),
            table: Some("vecs".to_string()),
            sql: None,
            x_col: "emb".to_string(),
            y_col: Some("__same__".to_string()),
            color_col: Some("grp".to_string()),
            algorithm: "kmeans_pca".to_string(),
            k: 2,
            limit: 100,
        };
        let resp = build_cluster_response(
            "test.sqlite",
            "vecs".to_string(),
            vec!["id".into(), "grp".into(), "emb".into()],
            raw_rows,
            false,
            &req,
            std::time::Instant::now(),
        )
        .unwrap();

        assert_eq!(resp.total_dim, 32);
        assert_eq!(resp.algorithm_used, "kmeans_pca");
        assert_eq!(resp.points.len(), 12);
        assert_eq!(resp.centroids.len(), 2);
        assert_eq!(resp.color.mode, "categorical");
        assert_eq!(resp.color.categories.len(), 2);
        // Verify K-Means separated the two distinct 32D clusters cleanly
        let c_a = resp.points[0].cluster.unwrap();
        let c_b = resp.points[6].cluster.unwrap();
        assert_ne!(c_a, c_b);
        for i in 0..6 {
            assert_eq!(resp.points[i].cluster, Some(c_a));
        }
        for i in 6..12 {
            assert_eq!(resp.points[i].cluster, Some(c_b));
        }
        // Display row formats decoded vector preview cleanly
        assert!(resp.rows[0][2].as_str().unwrap().starts_with("<vec[32]:"));
    }
}
