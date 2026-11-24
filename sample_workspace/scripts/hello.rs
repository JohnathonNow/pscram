// Custom Rust script invocable via:
//   POST /invoke/scripts/hello.rs  (or POST /invoke/hello)
//   {
//     "params": {
//       "name":    { "type": "string",  "value": "Rust" },
//       "repeat":  { "type": "integer", "value": 3 },
//       "excited": { "type": "boolean", "value": true }
//     }
//   }

let name = params.get_str("name").unwrap_or("World");
let repeat = params.get_int("repeat").unwrap_or(1);
let excited = params.get_bool("excited").unwrap_or(false);
let bang = if excited { "!" } else { "." };

let mut lines = Vec::new();
for i in 1..=repeat {
    let line = format!("[{}] Hello from Rust, {}{}", i, name, bang);
    println!("{}", line);
    lines.push(Value::string(line));
}

Value::map([
    ("greeting", Value::string(format!("Hello from Rust, {}{}", name, bang))),
    ("count", Value::int(repeat)),
    ("lines", Value::list(lines)),
])
