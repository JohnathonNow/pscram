use std::process::Command;

#[test]
fn test_frontend_js_syntax_and_mlnb_viz_logic() {
    let has_node = Command::new("node")
        .arg("--version")
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false);
    if !has_node {
        eprintln!("Skipping JS tests because `node` is not installed");
        return;
    }

    // 1. Syntax check both frontend bundles
    for file in ["web/app.js", "web/minijs_vm.js"] {
        let out = Command::new("node")
            .arg("--check")
            .arg(file)
            .output()
            .expect("failed to run node --check");
        assert!(
            out.status.success(),
            "Syntax error in {}:\n{}",
            file,
            String::from_utf8_lossy(&out.stderr)
        );
    }

    // 2. Unit-test MlnbViz (CSV/TSV parser + table normalizer) in Node via VM sandbox
    let script = r#"
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');

const sandbox = { window: {}, document: {}, console };
sandbox.globalThis = sandbox;
vm.runInNewContext(fs.readFileSync('web/minijs_vm.js', 'utf8'), sandbox);

const Viz = sandbox.window.MlnbViz;
assert(Viz, 'window.MlnbViz should be exported');

// CSV parsing with quotes, embedded commas, escaped quotes, and numeric coercion
const csv = Viz.parseCsv('name,score,note\n"Ada, L.",98.5,"He said ""hi"""\nBob,42,ok\n');
assert.deepStrictEqual(csv.columns, ['name', 'score', 'note']);
assert.strictEqual(csv.rows.length, 2);
assert.strictEqual(csv.rows[0][0], 'Ada, L.');
assert.strictEqual(csv.rows[0][1], 98.5);
assert.strictEqual(csv.rows[0][2], 'He said "hi"');
assert.strictEqual(csv.rows[1][1], 42);

// TSV auto-detection
const tsv = Viz.parseCsv('a\tb\n1\t2\n3\t4\n');
assert.deepStrictEqual(tsv.columns, ['a', 'b']);
assert.deepStrictEqual(tsv.rows, [[1, 2], [3, 4]]);

// Table payload normalization (array of objects, array of arrays, plain object, scalar)
const t1 = Viz.normalizeTablePayload([{ x: 1, y: 2 }, { y: 3, z: 4 }]);
assert.deepStrictEqual(t1.columns, ['x', 'y', 'z']);
assert.deepStrictEqual(t1.rows, [[1, 2, null], [null, 3, 4]]);

const t2 = Viz.normalizeTablePayload({ alpha: 10, beta: 20 });
assert.deepStrictEqual(t2.columns, ['Key', 'Value']);
assert.deepStrictEqual(t2.rows, [['alpha', 10], ['beta', 20]]);

const t3 = Viz.normalizeTablePayload([100, 200]);
assert.deepStrictEqual(t3.columns, ['Index', 'Value']);
assert.deepStrictEqual(t3.rows, [[1, 100], [2, 200]]);

console.log('JS_VIZ_TESTS_OK');
"#;

    let out = Command::new("node")
        .arg("-e")
        .arg(script)
        .output()
        .expect("failed to execute JS test script");
    assert!(
        out.status.success(),
        "JS tests failed:\nstdout: {}\nstderr: {}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    assert!(String::from_utf8_lossy(&out.stdout).contains("JS_VIZ_TESTS_OK"));
}
