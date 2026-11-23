// Custom Rust script with a typed function invocable via:
//   POST /invoke/scripts/fib.rs
//   { "function": "fib", "args": [{ "type": "integer", "value": 20 }] }
// or with named params:
//   { "function": "fib", "params": { "n": { "type": "integer", "value": 20 } } }

fn fib(n: i64) -> i64 {
    if n <= 1 {
        return n;
    }
    let (mut a, mut b) = (0i64, 1i64);
    for _ in 2..=n {
        let next = a + b;
        a = b;
        b = next;
    }
    b
}

let n = params.get_int("n").unwrap_or(10);
Value::map([
    ("n", Value::int(n)),
    ("fib", Value::int(fib(n))),
])
