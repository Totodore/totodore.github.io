+++
title = "Extending serde json capabilities by writing a wrapper"
date = 2025-05-08
description = ""
[taxonomies]
tags = ["socketioxide", "rust"]
+++
## Custom Serde Wrapper for Socket.IO Packet Handling in Rust

If you're just here for the final implementation, you can [skip the story and check it out here](#).

While working on [Socketioxide](https://github.com/totodore/socketioxide), an Axum-like Socket.IO server implementation in Rust, I encountered an issue I initially thought would be trivial. Spoiler: it wasn’t. It led me to rethink how `serde` works and ultimately dive deep into customizing it for our needs.

### The Socket.IO Protocol Quirks

Socket.IO is a JavaScript-centric library built over multiple transports (WebSocket, HTTP long-polling) and comes with its own protocol. Under the hood, it's mostly JSON, but with some custom rules:

* The **event name** is encoded as the **first argument** of a JSON array.
* It supports **variadic arguments**, where any number of payloads follow the event name.
* **Binary data** isn’t inlined — instead, it's replaced by a placeholder and sent separately (e.g., in a WebSocket binary frame).

#### Packet format
```
<packet type>[<# of binary attachments>-][<namespace>,][<acknowledgment id>][JSON-stringified payload without binary]
+ binary attachments extracted
```

but at the end we want to provide the possibility for the user to do this:
```rust
/// 52-/admin,["foo","message",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]
/// + <Buffer <01 02, ...>
/// + <Buffer <03 04, ...>
fn my_foo_handler(payload: Data<(String, Bytes, Bytes)>) { }
```
or event this:
```rust
#[derive(Deserialize)]
struct MyPayload {
    bins: [Bytes; 2],
    other_field: String
}
/// 52-/admin,["bar",{"bins": [{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}],"other_field": "foo"]
/// + <Buffer <01 02, ...>
/// + <Buffer <03 04, ...>
fn my_bar_handler(payload: Data<MyPayload>) { }
```
well, to summary we want the user to be able to specify the whole spectrum of serde possibilities without being limited by
socketioxide.

### Rust's Serde + JSON: Where It Breaks Down

Rust and `serde_json` give us great tools to work with structured data, but they hit limitations in this protocol:

* **Tuple vs Vec ambiguity**: A tuple (e.g. `(i32, String)`) and a vector (`Vec<Value>`) are both serialized to a `Value::Array`, making it hard to distinguish variadic arguments properly. Ideally, we’d treat tuples as argument lists, but not expand vectors.
* **Binary placeholders**: There’s no clean way to inject binary buffers back into their correct place in the deserialized structure.
* **Two-phase deserialization**: We must first parse the event to determine the correct handler, but the default approach fully deserializes the entire message too early, often unnecessarily.
* **Memory fragmentation**: Using `serde_json::Value` for intermediate deserialization leads to lots of heap allocations.

### Easiest solution: Dynamic Value Handling

My first approach was to use `serde_json::Value` as a generic stand-in:

* Extract the event name from the first element of the array.
* Recursively walk the structure to locate binary placeholders and associate them with actual payloads.
* Represent remaining arguments as a `Vec<Value>`.

This mostly worked and had the following trade-offs:

#### ✅ Advantages

* Simple and dynamic: Everything is handled at runtime.
* No need for users to write custom serializers/deserializers.

#### ❌ Drawbacks

* Lacks precision: Can't distinguish tuples from vectors — a critical protocol mismatch.
* No binary reinjection support: Once separated, placeholders and actual buffers are hard to correlate and rebind.
They are provided in an adjacent vector.
* `Value` is heap-heavy: Parsing large messages fragments memory and reduces throughput.

### Can We Do Better? Harnessing Serde's Modularity

I wanted to stick with Serde’s ecosystem but needed more control. Here's what I explored:

#### 1. Annotated Fields

I tried to use `#[serde(deserialize_with = "...")]` and inject binary buffers manually during deserialization. Unfortunately, Serde does not allow custom deserialization functions to access external state (like the binary buffer queue) in a clean way.

#### 2. A Custom Serializer/Deserializer

Eventually, I decided to write a custom deserializer that wraps `serde_json::Deserializer` — this gave me:

* **Stateful deserialization**: I can track and inject external binary buffers at the correct locations.
* **Precise handling of tuples vs arrays**: I can control how sequences are interpreted and enforce variadic behavior only where expected.
* **Lazy deserialization**: I can extract just the event name without parsing the full payload up front, and defer deeper parsing until we’ve routed the event.
