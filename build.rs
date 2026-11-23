use std::path::PathBuf;
use std::process::Command;

fn generate_minijs_init(minilang_src: &PathBuf, minilang_obj: &PathBuf, out_dir: &PathBuf) {
    let minijs_c = minilang_src.join("ml_minijs.c");
    let init_path = out_dir.join("ml_minijs_init.c");
    // Create an empty placeholder first so #include "ml_minijs_init.c" succeeds during preprocessing
    std::fs::write(&init_path, "").expect("failed to create placeholder ml_minijs_init.c");

    let cc = std::env::var("CC").unwrap_or_else(|_| "cc".to_string());
    let output = Command::new(&cc)
        .args([
            "-E",
            "-P",
            "-DGENERATE_INIT",
            "-std=gnu99",
            "-DLinux",
            "-DGC_THREADS",
            "-D_GNU_SOURCE",
            "-DML_UUID",
            "-DML_MINIJS",
        ])
        .arg(format!("-I{}", minilang_obj.display()))
        .arg(format!("-I{}", minilang_src.display()))
        .arg(format!("-I{}", out_dir.display()))
        .arg(&minijs_c)
        .output()
        .expect("failed to preprocess ml_minijs.c");

    if !output.status.success() {
        panic!(
            "Failed to preprocess ml_minijs.c:\n{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    let preprocessed = String::from_utf8_lossy(&output.stdout).replace(");", ");\n");
    let mut init_lines = Vec::new();
    for line in preprocessed.lines() {
        if let Some(idx) = line.find("INIT_CODE ") {
            let rest = &line[idx + "INIT_CODE ".len()..];
            if let Some(end) = rest.find(");") {
                init_lines.push(&rest[..end + 2]);
            }
        }
    }
    std::fs::write(&init_path, init_lines.join("\n") + "\n")
        .expect("failed to write ml_minijs_init.c");
}

fn main() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").unwrap());
    let out_dir = PathBuf::from(std::env::var("OUT_DIR").unwrap());
    let minilang_dir = manifest_dir.join("minilang");
    let minilang_src = minilang_dir.join("src");
    let minilang_obj = minilang_dir.join("obj");
    let minilang_lib = minilang_dir.join("lib");

    println!("cargo:rerun-if-changed=csrc/ml_kernel.c");
    println!("cargo:rerun-if-changed=csrc/ml_ui.c");
    println!("cargo:rerun-if-changed=csrc/ml_ui.h");
    println!(
        "cargo:rerun-if-changed={}",
        minilang_src.join("ml_minijs.c").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        minilang_lib.join("libminilang.a").display()
    );

    generate_minijs_init(&minilang_src, &minilang_obj, &out_dir);

    cc::Build::new()
        .file("csrc/ml_kernel.c")
        .file("csrc/ml_ui.c")
        .file(minilang_src.join("ml_minijs.c"))
        .include(&minilang_src)
        .include(&minilang_obj)
        .include(&out_dir)
        .include("csrc")
        .define("Linux", None)
        .define("GC_THREADS", None)
        .define("_GNU_SOURCE", None)
        .define("ML_UUID", None)
        .define("ML_MINIJS", None)
        .flag("-std=gnu99")
        .flag("-Wno-unused-parameter")
        .flag("-Wno-unused-function")
        .flag("-Wno-missing-field-initializers")
        .flag("-Wno-sign-compare")
        .flag("-Wno-override-init")
        .compile("ml_kernel");

    println!("cargo:rustc-link-search=native={}", minilang_lib.display());
    println!("cargo:rustc-link-lib=static=minilang");
    println!("cargo:rustc-link-lib=gc");
    println!("cargo:rustc-link-lib=uuid");
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rustc-link-lib=pthread");
}
