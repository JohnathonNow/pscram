use std::path::PathBuf;
use std::process::Command;

fn generate_init_file(
    src_file: &PathBuf,
    init_filename: &str,
    minilang_src: &PathBuf,
    minilang_obj: &PathBuf,
    out_dir: &PathBuf,
) {
    let init_path = out_dir.join(init_filename);
    // Create an empty placeholder first so #include "<init_filename>" succeeds during preprocessing
    std::fs::write(&init_path, "").expect("failed to create placeholder init file");

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
            "-DML_MODULES",
            "-DML_LIBRARY",
            "-DML_CONFIG_HASH=\"minilang-notebook\"",
        ])
        .arg(format!("-I{}", minilang_obj.display()))
        .arg(format!("-I{}", minilang_src.display()))
        .arg(format!("-I{}", out_dir.display()))
        .arg(src_file)
        .output()
        .expect("failed to preprocess minilang source for INIT_CODE");

    if !output.status.success() {
        panic!(
            "Failed to preprocess {}:\n{}",
            src_file.display(),
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
        .expect("failed to write generated init file");
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
    println!("cargo:rerun-if-changed=csrc/ml_io.c");
    println!("cargo:rerun-if-changed=csrc/ml_io.h");
    println!("cargo:rerun-if-changed=csrc/ml_log.c");
    println!("cargo:rerun-if-changed=csrc/ml_log.h");
    println!("cargo:rerun-if-changed=csrc/ml_db.c");
    println!("cargo:rerun-if-changed=csrc/ml_db.h");
    println!("cargo:rerun-if-changed=csrc/ml_jobs.c");
    println!("cargo:rerun-if-changed=csrc/ml_jobs.h");
    println!("cargo:rerun-if-changed=csrc/ml_debug.c");
    println!("cargo:rerun-if-changed=csrc/ml_debug.h");
    println!(
        "cargo:rerun-if-changed={}",
        minilang_src.join("ml_minijs.c").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        minilang_src.join("ml_module.c").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        minilang_src.join("ml_library.c").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        minilang_lib.join("libminilang.a").display()
    );

    generate_init_file(
        &minilang_src.join("ml_minijs.c"),
        "ml_minijs_init.c",
        &minilang_src,
        &minilang_obj,
        &out_dir,
    );
    generate_init_file(
        &minilang_src.join("ml_module.c"),
        "ml_module_init.c",
        &minilang_src,
        &minilang_obj,
        &out_dir,
    );
    generate_init_file(
        &minilang_src.join("ml_library.c"),
        "ml_library_init.c",
        &minilang_src,
        &minilang_obj,
        &out_dir,
    );

    cc::Build::new()
        .file("csrc/ml_kernel.c")
        .file("csrc/ml_ui.c")
        .file("csrc/ml_io.c")
        .file("csrc/ml_log.c")
        .file("csrc/ml_db.c")
        .file("csrc/ml_jobs.c")
        .file("csrc/ml_debug.c")
        .file(minilang_src.join("ml_minijs.c"))
        .file(minilang_src.join("ml_module.c"))
        .file(minilang_src.join("ml_library.c"))
        .file(minilang_src.join("whereami.c"))
        .include(&minilang_src)
        .include(&minilang_obj)
        .include(&out_dir)
        .include("csrc")
        .define("Linux", None)
        .define("GC_THREADS", None)
        .define("_GNU_SOURCE", None)
        .define("ML_UUID", None)
        .define("ML_MINIJS", None)
        .define("ML_MODULES", None)
        .define("ML_LIBRARY", None)
        .define("ML_CONFIG_HASH", "\"minilang-notebook\"")
        .flag("-std=gnu99")
        .flag("-Wno-unused-parameter")
        .flag("-Wno-unused-function")
        .flag("-Wno-missing-field-initializers")
        .flag("-Wno-sign-compare")
        .flag("-Wno-override-init")
        .flag("-Wno-discarded-qualifiers")
        .compile("ml_kernel");

    println!("cargo:rustc-link-search=native={}", minilang_lib.display());
    println!("cargo:rustc-link-lib=static=minilang");
    println!("cargo:rustc-link-lib=gc");
    println!("cargo:rustc-link-lib=uuid");
    println!("cargo:rustc-link-lib=m");
    println!("cargo:rustc-link-lib=dl");
    println!("cargo:rustc-link-lib=pthread");
}
