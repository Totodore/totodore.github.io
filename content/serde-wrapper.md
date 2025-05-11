+++
title = "Inside Serde: Building a Custom JSON Deserializer with binary support and more"
date = 2025-05-08
description = "This article explores how to extend serde in Rust by wrapping the JSON deserializer to support Socket.IO’s custom packet format — including variadic arguments, event based routing, and seamless reinjection of out-of-band binary payloads — all while keeping performance and type safety intact."
[taxonomies]
tags = ["socketioxide", "rust"]
+++

# TL;DR

Socket.IO is a JavaScript library for real-time, bidirectional communication between clients and servers, built on top of WebSockets and featuring a custom event-based protocol.
It uses a custom packet format that doesn’t map cleanly to Rust’s type system or serde's model — especially with variadic arguments and out-of-band binary payloads. This post walks through how I extended `serde_json` by wrapping its deserializer to:

* Lazily extract the event name without full deserialization,
* Automatically reinject binary payloads into placeholders,
* Differentiate between tuples and vectors for correct variadic decoding,
* Eliminate the need for intermediate `Value` and two-phase parsing.

The result is a clean, ergonomic, and performant single-phase deserialization system — with a 10× speedup on packet routing.

# Socketioxide introduction

While working on [Socketioxide](https://github.com/totodore/socketioxide), an Axum-like Socket.IO server implementation in Rust, I encountered an issue I initially thought would be trivial. Spoiler: it wasn’t. It led me to rethink how `serde` works and ultimately dive deep into customizing it for the socketioxide needs.

## The Socket.IO Protocol Quirks

Socket.IO comes with its own protocol. Under the hood, it's mostly JSON, but with some custom rules:

* The **event name** is encoded as the **first argument** of a JSON array.
* It supports **variadic arguments**, where any number of payloads follow the event name.
* **Binary data** isn’t inlined — instead, it's replaced by a placeholder and sent separately (e.g., in a WebSocket binary frame).

The *packet format* looks something like:

```
<packet type>[<# of binary attachments>-][<namespace>,][<acknowledgment id>][JSON-stringified payload without binary]
+ binary attachments extracted
```

For example, the following packet:

```
52-/admin,["foo",["message",{"_placeholder":true,"num":0},{"_placeholder":true,"num":1}]]
+ <Buffer 01 02 ...>
+ <Buffer 03 04 ...>
```

should should be parsed as a *binary event (packet id `5`)* with *`2` binary attachments* that is part of the *"/admin"* namespace. The event name is *"foo"* and the payload is the array ["message", <Buffer 01 02>, <Buffer 03 04>].

We want the user to be able to specify the whole spectrum of serde possibilities without being limited by socketioxide.

The final API for writing a handler with socketioxide looks like:

```rust
fn my_foo_handler(payload: Data<(String, Bytes, Bytes)>) { }
```

# Serde: where it breaks down

The first emerging idea to solve this issue would be to write a custom JSON-parser that will partially decode our data. However that's a **terrible** idea for **many** reasons.
It's error prone, complex, the resulting code will be inefficent and insecure.

Rust and `serde_json` give us great tools to work with structured data, but they hit limitations in this protocol:

* **Tuple vs Vec ambiguity**: A tuple (e.g. `(i32, String)`) and a vector (`Vec<Value>`) are both serialized to a `Value::Array`, making it hard to distinguish variadic arguments properly. Ideally, we’d treat tuples as argument lists, but not expand vectors.
* **Binary placeholders**: There’s no clean way to inject binary buffers back into their correct place in the deserialized structure.
* **Two-phase deserialization**: We must first parse the event to determine the correct handler, but the default approach fully deserializes the entire message too early, often unnecessarily.
* **Memory fragmentation**: Using `serde_json::Value` for intermediate deserialization leads to lots of heap allocations.

## Naive solution: dynamic value handling and two-phase deserialization

My first approach was to use `serde_json::Value` as a generic stand-in:

* Extract the event name from the first element of the array.
* Recursively walk the structure to locate binary placeholders and associate them with actual payloads.
* Represent remaining arguments as a `Vec<Value>`.
* Deserialize the `serde_json::Value` to the user provided type.

This mostly worked and had the following trade-offs:

*Advantages*

* Simple and dynamic: Everything is handled at runtime.
* No need for users to write custom serializers/deserializers.

*Drawbacks*

* Lacks precision: Can't distinguish tuples from vectors — a critical protocol mismatch.
* No binary reinjection support: Once separated, placeholders and actual buffers are hard to correlate and rebind.
They are provided in an adjacent vector.
* `Value` is heap-heavy: Parsing large messages fragments memory and reduces throughput.
* Two-pass deserialization means doubling the amount of work.

## Annotated Fields

Users could put `#[serde(deserialize_with = "...")]` on binary fields to inject the binary buffer manually during deserialization. Unfortunately, Serde does not allow custom deserialization functions to access external state (like the binary buffer queue) in a clean way. This would also force the user to think about specifying this.
And it doesn't solve the other issues such as the support for multiple arguments.

I wanted to stick with Serde’s ecosystem but needed more control. Thankfully serde is incredibly flexible.

# A custom serializer/deserializer

Eventually, I decided to write a custom deserializer that wraps `serde_json::Deserializer` — this gave me:

1. **Lazy deserialization**: I can extract just the event name without parsing the full payload up front, and defer deeper parsing until we’ve routed the event.
2. **Stateful deserialization**: I can track and inject external binary buffers at the correct locations.
3. **Precise handling of tuples vs arrays**: I can control how sequences are interpreted and enforce variadic behavior only where expected.

Serde uses the [visitor pattern] for deserialization which makes it extremely modular by separating the incoming data side from the type defintion side. This pattern will be used for all the following features.

[visitor pattern]: https://en.wikipedia.org/wiki/Visitor_pattern

## 1. Lazy deserialization

Here is a quick example on how we can deserialize only the first element of a sequence by using a `FirstElement` struct that will be a serde [visitor](https://serde.rs/impl-deserialize.html#the-visitor-trait) and a [deserialize seed](https://docs.rs/serde/latest/serde/de/trait.DeserializeSeed.html).
Thanks to this we can map any kind of data with any type in a statically defined manner.

```rust
/// A seed that can be used to deserialize only the 1st element of a sequence
pub struct FirstElement<T>(std::marker::PhantomData<T>);

/// We implement the Visitor for [`FirstElement`]. It will only be able to be visited by a sequence as we only expect this.
impl<'de, T: serde::Deserialize<'de>> serde::de::Visitor<'de> for FirstElement<T> {
    type Value = T;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "a sequence in which we care about first element",)
    }

    // We expect only a sequence, in any other case we will error something.
    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        use serde::de::Error;
        let data = seq
            .next_element::<T>()?
            .ok_or(A::Error::custom("first element not found"));

        // Consume the rest of the sequence
        while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}

        data
    }
}

/// DeserializeSeed is the stateful form of Deserialize to hold the custom type we are deserializing to.
impl<'de, T> serde::de::DeserializeSeed<'de> for FirstElement<T>
    where T: serde::Deserialize<'de>
    {
    /// We are deserializing to T.
    type Value = T;

    fn deserialize<D>(self, deserializer: D) -> Result<Self::Value, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        /// We are expecting a sequence of values.
        deserializer.deserialize_seq(self)
    }
}
```

Then we can easily use our `FirstElement` it's even in a zero-copy way!
```rust
/// Extract the event name from a JSON array with the event being
/// the first element: ["foo",...]
pub fn read_event(data: &str) -> serde_json::Result<&str> {
    let mut de = serde_json::Deserializer::from_str(data);
    FirstElement::<&str>::default().deserialize(&mut de)
}
```

But what about deserializing the real payload? How do you skip the event name? Well as we are wrapping the `serde_json` deserializer we can implement custom behavior such as skipping the first element of the root JSON array:

We start by building a custom visitor wrapper to skip the first element in a sequence.

```rust
/// This custom [`SeqVisitor`] implementation is used to skip the first element of the sequence.
/// This is useful when the first element of the sequence is an event value that we want to ignore.
struct SeqVisitor<V> {
    inner: V,
}
impl<'de, V: Visitor<'de>> Visitor<'de> for SeqVisitor<V> {
    type Value = V::Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a sequence")
    }
    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: serde::de::SeqAccess<'de>,
    {
        let _ = seq.next_element::<IgnoredAny>()?; // We ignore the event value
        /// We defer the rest of the sequence visits to the inner visitor.
        self.inner.visit_seq(seq)
    }
}
```

and we can create our visitor in our deserializer wrapper:

```rust
struct Deserializer<D> {
    inner: D,
}

impl<'de, D: de::Deserializer<'de>> de::Deserializer<'de> for Deserializer<D> {
    type Error = D::Error;

    fn deserialize_seq<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        self.inner.deserialize_seq(SeqVisitor::new(visitor)))
    }
...
}
```

With this we don't need to deserialize our data to an intermediate dynamic value, we can immediately find the corresponding event handler and deserialize the raw JSON string to a user provided type and skip the event.

## 2. Precise handling of tuples vs arrays for variadic arguments

In socket.io if you send a vec with `socket.emit("event", [1, 2, 3, 4])`, it will be serialized like this: `[event, [1, 2, 3, 4]]` but if you send variadics with `socket.emit("event", 1, 2, 3, 4)`, it will be serialized as: `[event, 1, 2, 3, 4]`.

But how can we do the difference on the Rust-side? So that a multi-argument payload is deserialized to a tuple and a vector of data is deserialized to a vec? Well, that's the user responsibility. They will know whether they are expecting a vec or tuple!
So here is what we could do. First we need to know if the user provided a tuple or something else, prepare yourself—it's kind of hacky.

`IsTupleSerde` has an implementation for serializer and deserializer that will simply error immediately with a boolean saying
if the root type appears to be a tuple or not (without visiting anything or any data):

```rust
impl<'de> serde::Deserializer<'de> for IsTupleSerde {
    type Error = IsTupleSerdeError;

    /// All these types are non-tuple
    serde::forward_to_deserialize_any! {
        bool i8 i16 i32 i64 i128 u8 u16 u32 u64 u128 f32 f64 char str
        string unit unit_struct seq  map
        struct enum identifier ignored_any bytes byte_buf option
    }
    /// The root type is not a tuple! We stop the deserializing process immediately by returning a stub error.
    fn deserialize_any<V: Visitor<'de>>(self, _visitor: V) -> Result<V::Value, Self::Error> {
        Err(IsTupleSerdeError(false))
    }
    /// The root type is a tuple! We stop the deserializing process immediately by returning a stub error.
    fn deserialize_tuple<V: Visitor<'de>>(
        self,
        _len: usize,
        _visitor: V,
    ) -> Result<V::Value, Self::Error> {
        Err(IsTupleSerdeError(true))
    }
```

We can then make a little function to check if a type is a tuple or not:

```rust
/// Returns true if the type is a tuple-like type according to the serde model.
pub fn is_de_tuple<'de, T: serde::Deserialize<'de>>() -> bool {
    match T::deserialize(IsTupleSerde) {
        Ok(_) => unreachable!(),
        Err(IsTupleSerdeError(v)) => v,
    }
}
```

And then use it

```rust
pub fn from_value<'de, T: Deserialize<'de>>(
    data: &'de str,
) -> serde_json::Result<T> {
    /// We create a json deserialize and we wrap it we our own to implement custom behavior.
    let inner = &mut serde_json::Deserializer::from_str(data);
    let de = Deserializer { inner };

    if is_de_tuple::<T>() {
        /// Our type T is a tuple we deserialize everything incoming except the first element as it is the event.
        T::deserialize(de)
    } else {
        /// Our type T is not a tuple we deserialize only the first element
        /// (it should be the second but the deserializer first skip the event).
        FirstElement::<T>::default().deserialize(de)
    }
}
```

## 3. Binary buffer reinjection

As you saw before, with the visitor pattern we can completely separate the incoming data side with the mapped user types.
This is what we are going to do! We are going to map serde maps (the binary placeholders) to user binary types.

We can make a custom `BinaryVisitor` wrapper that will be instantiated for any user provided bytes types.
But with a twist! The visitor can be visit a map if the serde_json deserializer fall on a map for a corresponding binary type!
If so and that it is a placeholder: `{ "_placeholder": true, "num": 1 }` we can replace it with the corresponding binary present in our queue.

```rust
struct BinaryVisitor<'a, V> {
    binary_payloads: &'a mut VecDeque<Bytes>,
    inner: V,
}

impl<'de, V: de::Visitor<'de>> Visitor<'de> for BinaryVisitor<'_, V> {
    type Value = V::Value;

    fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("a binary payload")
    }

    fn visit_map<A: serde::de::MapAccess<'de>>(self, mut map: A) -> Result<Self::Value, A::Error> {
        use serde::de::Error;
        #[derive(serde::Deserialize)]
        #[serde(untagged)]
        enum Val {
            Placeholder(bool),
            Num(usize),
        }

        let (key, val) = map
            .next_entry::<&str, Val>()?
            .ok_or(A::Error::custom("expected a binary placeholder"))?;
        let (key1, val1) = map
            .next_entry::<&str, Val>()?
            .ok_or(A::Error::custom("expected a binary placeholder"))?;

        match (key, val, key1, val1) {
            ("_placeholder", Val::Placeholder(true), "num", Val::Num(idx))
            | ("num", Val::Num(idx), "_placeholder", Val::Placeholder(true)) => {
                let payload = self
                    .binary_payloads
                    .pop_front()
                    .ok_or_else(|| A::Error::custom(format!("binary payload {} not found", idx)))?;
                self.inner.visit_byte_buf(Vec::from(payload))
            }
            _ => Err(A::Error::custom("expected a binary placeholder")),
        }
    }

    fn visit_borrowed_bytes<E: serde::de::Error>(self, v: &'de [u8]) -> Result<Self::Value, E> {
        self.inner.visit_borrowed_bytes(v)
    }

    fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> Result<Self::Value, E> {
        self.inner.visit_byte_buf(v)
    }

    fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
        self.inner.visit_bytes(v)
    }
}
```

Then we can use our `BinaryVisitor` wrapper for any call to `deserialize_bytes` or `deserialize_byte_buf`:

```rust
struct Deserializer<'a, D> {
    inner: D,
    binary_payloads: &'a mut VecDeque<Bytes>,
}

impl<'de, D: de::Deserializer<'de>> de::Deserializer<'de> for Deserializer<'_, D> {
    type Error = D::Error;

    #[inline]
    fn deserialize_bytes<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        self.inner.deserialize_map(BinaryVisitor {
            inner: visitor,
            binary_payloads: self.binary_payloads,
        })
    }

    #[inline]
    fn deserialize_byte_buf<V: Visitor<'de>>(self, visitor: V) -> Result<V::Value, Self::Error> {
        self.inner.deserialize_map(BinaryVisitor {
            inner: visitor,
            binary_payloads: self.binary_payloads,
        })
    }
...
```

# Conclusion

Et voilà! We have extended/twisted serde to do custom deserialization without writing any parsing code (I will happily let that for serde_json)!

We went from a two-phase dynamic system to a single-phase, type-safe, performant deserialization pipeline to a one-phase deserialization process that handles:
* External binary data re-injection.
* First element (the event name) extracted for routing and skipped for user deserialization.
* Differentiation between tuples and vecs to support deserializing from JS sent variadics.
* Zero-copy deserialization! Don’t get me wrong—it’s still 'partial' zero-copy, since we're using JSON 😄. But for basic strings at least.
* Performance (because we all like the little thrill of perf improvements):
We reduced processing time for a basic packet from 600ns to just 60ns. Memory usage is also significantly more efficient, as no unnecessary allocations are made. Additionally, if the user chooses not to deserialize the incoming data—or if it doesn't match the expected user types—it simply isn't deserialized.

