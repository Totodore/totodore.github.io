+++
title = "Memory-bounded systems and backpressure in Rust"
date = 2026-11-22
description = "Three ways to keep a Rust service under its memory limit: bounding the load per request, byte budgets, and backpressure driven by jemalloc metrics."
[taxonomies]
tags = ["memory", "rust"]
+++

As everybody knows and especially nowadays with the RAM shortage situation because of LLMs, memory is not infinite. Therefore a lot of workloads, processes, pods need system limits. For instance in the case of embedded systems but also, more commonly in webservers, remote systems, and so on.
Indeed the machine hosting your process, be it virtual or physical won't have infinite RAM and once it is exhausted, the kernel will slow down or kill processes through the OOM killer, which will degrade the service you are actually trying to provide.

For this reason, it is quite usual to add limits to processes or pods in a Kubernetes context, usually by using Linux cgroups, which are a way to add CPU and memory limits on processes. Today we will only talk about memory limits, CPU limits being a whole different topic.

So what do we mean by memory backpressure? Well this is simply the ability of a system to delay new workloads or slow down to limit its memory usage to a given threshold. There are multiple solutions depending on the programming language, the kind of system you are integrating this into and the architecture of your program. We will focus on Rust.

First, what can be bound and what cannot? The kernel enforces cgroup limits (`memory.max`) against everything charged to the cgroup, exposed as `memory.current`: the anonymous memory of its processes, the page cache of the files they read, write or memory-map, and kernel memory allocated on their behalf, such as socket buffers and page tables. Swap is accounted separately (`memory.swap.max`). When the limit is hit, the kernel first reclaims what it can, mostly clean page cache, and only then invokes the OOM killer. Kubernetes adds its own layer on top: when the node itself runs low on memory, the kubelet evicts pods, using their _memory working set_ to rank them. The working set is `memory.current` minus the inactive, easily reclaimable file pages. A container exceeding its own limit is not evicted: it is killed by the kernel OOM killer.

The main focus here will be the process's Resident Set Size (or RSS): the pages mapped by the process that are currently in RAM. It contains both reclaimable file-backed pages and anonymous memory. Only the latter is a problem: the kernel cannot drop it without swapping. A process RSS holds the following kinds of data:
* The instructions of the program being run. These pages are backed by the executable file, so the kernel can drop them and read them back when needed.
* The static sections: read-only data, also backed by the file, and mutable data (`.data`, `.bss`) which becomes anonymous memory once written.
* Thread stacks: 2 MiB reserved per thread spawned with Rust's std by default, and usually 8 MiB for the main thread. Only the pages actually touched count in RSS.
* Resident pages of memory-mapped files, which are file-backed and reclaimable as well.
* Memory allocated dynamically by the process through `malloc`: the heap.

The only manageable one is the memory allocated dynamically. The three following solutions will only concern this kind of memory and we will count the others as an overhead to measure, either constant or growing linearly with the load.

The three solutions will rely on these two known example systems:

* A live ingestion HTTP server that is at the front of a data processing pipeline. We can picture this as a push based consumption model. Requests are pushed over the network, if it can't accept traffic anymore, the server will reply a `503` status code with a `Retry-After` header.
* A data processing system that will do CPU/Memory bound processing behind a stream implementation (Kafka/NATS). We can picture this as a pull based consumption model. The downstream service will pull new work to perform only when it can and will rely on the stream to act as a buffer in the meantime.

We can define this difference as cooperative backpressure vs. non-cooperative. Push based consumption model **expects** that the client respects the `Retry-After` header, but the client is not forced to. Pull based does not rely on an expected behavior.

# Indirect memory bounding

This solution can be applied to any language. It is not specific to Rust.
The easiest way to bound your system memory is to limit two things:
* The incoming load per request. For this we need to find a metric that scales linearly with the load of the service. For example with our server implementation it could be the request body size.
* The maximum number of requests it can process in parallel with a semaphore.

If your system implements the [tower `Service` trait](https://docs.rs/tower/latest/tower/trait.Service.html) (which I highly recommend for ecosystem integration purposes), you can leverage the [concurrency limit layer](https://docs.rs/tower/latest/tower/limit/concurrency/) for this and expose the concurrency limit as a configuration knob. If your memory allocation is tied to requests handling, this might be one of the easiest solutions.

<details>
<summary>Example: bounding an axum server with tower layers</summary>

```rust
const MAX_CONCURRENT_REQUESTS: usize = 1000;
const MAX_BODY_SIZE: usize = 5 * 1024 * 1024;

#[tokio::main]
async fn main() {
    let app = Router::new().route("/ingest", post(ingest)).layer(
        ServiceBuilder::new()
            // Reply `503` + `Retry-After` when overloaded.
            .layer(HandleErrorLayer::new(|_: BoxError| async {
                (StatusCode::SERVICE_UNAVAILABLE, [(header::RETRY_AFTER, "1")])
            }))
            // Reject instead of queuing when no slot is available.
            .load_shed()
            // One semaphore shared by every route.
            .layer(GlobalConcurrencyLimitLayer::new(MAX_CONCURRENT_REQUESTS))
            // Decompress first so the limit applies to the decompressed size.
            .layer(RequestDecompressionLayer::new())
            .layer(RequestBodyLimitLayer::new(MAX_BODY_SIZE))
            // axum's own 2 MiB default limit would shadow ours.
            .layer(DefaultBodyLimit::disable()),
    );

    let listener = tokio::net::TcpListener::bind("0.0.0.0:3000").await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

async fn ingest(body: Bytes) -> StatusCode {
    // At most `MAX_BODY_SIZE` bytes buffered per request.
    let _ = body;
    StatusCode::ACCEPTED
}
```

</details>

<details>
<summary>Example: a bounded NATS JetStream pull consumer</summary>

```rust
const MAX_CONCURRENT_EVENTS: usize = 8;
const MAX_EVENT_SIZE: usize = 512 * 1024;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let js = jetstream::new(async_nats::connect("localhost:4222").await?);

    let stream = js
        .get_or_create_stream(stream::Config {
            name: "EVENTS".into(),
            subjects: vec!["events.>".into()],
            // Bound the load per event: bigger messages are rejected on publish.
            max_message_size: MAX_EVENT_SIZE as i32,
            ..Default::default()
        })
        .await?;

    let consumer = stream
        .get_or_create_consumer("processor", pull::Config {
            durable_name: Some("processor".into()),
            // Server-side bound: never more unacked events delivered to us.
            max_ack_pending: 2 * MAX_CONCURRENT_EVENTS as i64,
            ..Default::default()
        })
        .await?;

    consumer
        .stream()
        // Bound the prefetch buffer (default: 200 messages, no byte limit).
        .max_messages_per_batch(MAX_CONCURRENT_EVENTS)
        .max_bytes_per_batch(MAX_CONCURRENT_EVENTS * MAX_EVENT_SIZE)
        .messages()
        .await?
        .take_until(tokio::signal::ctrl_c())
        // The stream is not polled again until one of the events is done.
        .for_each_concurrent(MAX_CONCURRENT_EVENTS, |msg| async move {
            let Ok(msg) = msg else { return };
            process(&msg.payload).await;
            let _ = msg.ack().await;
        })
        .await;

    Ok(())
}

async fn process(_payload: &[u8]) {
    tokio::time::sleep(std::time::Duration::from_millis(50)).await;
}
```

</details>

## Capacity planning and caveats
Once you have ways to limit the workload, you need to tune them and for this you need to measure the metrics you picked against the real memory usage and define a rule.
There are multiple caveats with this solution that will appear in this process:
* You actually need to plan limits for the worst case scenario. For our server implementation, with a 5 MB request body and a concurrency limit set to 1000 requests in parallel, you will need to reserve up to 5 GB of memory. And actually most request bodies might only weigh 1 MB.
* Other memory allocations, allocator overhead and memory fragmentation are not counted, so you need to account manually for them, and it might scale from inputs that are completely unrelated to the requests, like the number of CPU threads, the number of blocking threads spawned by [tokio](https://tokio.rs), the allocator used, the OS, and so on...

# Byte-budget bounding
In fact, the capacity planning complexity and caveats come from the load per request; the maximum number of parallel requests itself being straightforward to plan.
So byte budget is another solution: bound the bytes a work task can hold, instead of the number of tasks.

The simplest byte budget is a semaphore with one permit per byte. Each request reserves its body size. With a 1 GiB budget, we still serve 1000 requests of 1 MiB in parallel, without reserving 5 GiB for the worst case.

<details>
<summary>Example: a byte budget for an axum server with a weighted semaphore</summary>

```rust
const MAX_BODY_SIZE: usize = 5 * 1024 * 1024;
const BYTE_BUDGET: usize = 1024 * 1024 * 1024;

/// One permit per byte, shared by every request.
static BUDGET: Semaphore = Semaphore::const_new(BYTE_BUDGET);

/// Reserve the body size from the budget, reply `503` when it is exhausted.
/// Added to the router with `.layer(middleware::from_fn(byte_budget))`.
async fn byte_budget(req: Request, next: Next) -> Response {
    let size = req
        .headers()
        .get(header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok()?.parse().ok())
        // No `Content-Length` (chunked body): reserve the worst case.
        .unwrap_or(MAX_BODY_SIZE)
        .min(MAX_BODY_SIZE);

    let Ok(_permit) = BUDGET.try_acquire_many(size as u32) else {
        return (StatusCode::SERVICE_UNAVAILABLE, [(header::RETRY_AFTER, "1")]).into_response();
    };
    // The bytes are given back when the permit is dropped.
    next.run(req).await
}
```

</details>

Be careful with compressed bodies: `Content-Length` is the compressed size, so the budget undercounts them. Our NATS consumer already had a byte budget: `max_bytes_per_batch` bounds the prefetch buffer in bytes.

You can go further and limit the allocated memory itself, either with a memory arena or a custom allocator.
One of its biggest advantages is that it allows for a finer customization of the system behavior while having a more precise idea of what we are limiting. And you can implement different behavior if your memory bound is reached, for example you can either flush processed data eagerly if it is a scratch bounded buffer of data or refuse any incoming data.
For a scratch buffer, [bumpalo](https://docs.rs/bumpalo) arenas have a `set_allocation_limit`. For a real-world example, look at DataFusion's [`MemoryPool`](https://docs.rs/datafusion/latest/datafusion/execution/memory_pool/trait.MemoryPool.html): operators reserve bytes before allocating, and spill to disk when the reservation fails.

However it might come with a heavier configuration burden as the operator needs to tweak multiple limits and understand how they interact with each other. Also it might not be applicable for every system.

Indeed, using such solutions might not be an option, especially if most of the allocations issued by your service are coming from external libs. Today, it is extremely rare to find crates that support custom allocators or that are only arena based. Some workloads cannot fit the bounded arena model and the allocator trait has only [been stabilized](https://blog.rust-lang.org/2026/11/12/Rust-1.100.0/#allocator-api) in Rust 1.100. So far only `Vec` and `Box` support it.

# Exploring global memory bounding
A lot of memory managed languages have ways of bounding memory globally through Garbage Collection with
a best-effort mechanism. Once a given threshold is reached, the GC starts to reclaim memory eagerly at the price of more pauses. Go has `GOMEMLIMIT`, Java has `MaxRAMPercentage`, ... However there is no standard mechanism available for this in Rust (or any language that is not memory managed).

Still, you can use a custom allocator that will give you stats of your heap usage. These allocators are usually declared globally.

The most basic way is to make a custom wrapper to track allocated memory:

<details>
<summary>Example with a custom global allocator wrapper</summary>

```rust
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicUsize, Ordering::Relaxed};

/// Wraps the system allocator and counts the bytes currently allocated.
struct CountingAlloc;

static ALLOCATED: AtomicUsize = AtomicUsize::new(0);

unsafe impl GlobalAlloc for CountingAlloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        let ptr = unsafe { System.alloc(layout) };
        if !ptr.is_null() {
            ALLOCATED.fetch_add(layout.size(), Relaxed);
        }
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        unsafe { System.dealloc(ptr, layout) };
        ALLOCATED.fetch_sub(layout.size(), Relaxed);
    }
}

#[global_allocator]
static GLOBAL: CountingAlloc = CountingAlloc;
```
</details>

However allocated memory is not the most representative metric and we can do much better!

## Using Jemalloc
jemalloc is a general-purpose allocator originally written by Jason Evans for FreeBSD’s libc, and now maintained by Meta. It is one of the most feature-complete allocators, its performance is on par with the alternatives, and its main advantage for us is that it exposes a lot of memory usage statistics, which the tikv-jemalloc-ctl crate makes easy to read from Rust. This makes it a good fit for our use case: an HTTP server at the beginning of a data processing pipeline, ingesting and validating a high volume of data before it is processed downstream. Rust bindings and a ready to use crate are available with the [tikv-jemallocator](https://github.com/tikv/jemallocator) crate and maintained by the tikv organisation.

### First step: collecting jemalloc metrics efficiently with OpenTelemetry

Jemalloc metrics are not automatically updated: you need to ask jemalloc with an `epoch::advance()` call. This operation is quite costly, more on this at the end. Consequently this cannot be done for each request.

We are using the OpenTelemetry SDK to export data to a metric backend (here VictoriaMetrics), with a Grafana frontend.
As the metric export interval is much higher than jemalloc advance calls (60s vs. 1s), we also need to track the minimum and maximum values during the collection interval of each metric, so we can have more insights.

First we can define a `Sample` struct to track the last value and the extremum of a jemalloc metric during the OTEL metric export.

<details open="true">

<summary>Defining a sample struct to track the last measured value and its extrema</summary>

```rust
#[global_allocator]
static GLOBAL: tikv_jemallocator::Jemalloc = tikv_jemallocator::Jemalloc;

static ALLOCATED: Sample = Sample::new();
static ACTIVE: Sample = Sample::new();
static RESIDENT: Sample = Sample::new();
static RETAINED: Sample = Sample::new();

/// Last, min and max values of a jemalloc stat since the previous collection.
struct Sample {
    last: AtomicU64,
    min: AtomicU64,
    max: AtomicU64,
}

impl Sample {
    const fn new() -> Self {
        Self {
            last: AtomicU64::new(0),
            min: AtomicU64::new(u64::MAX),
            max: AtomicU64::new(0),
        }
    }

    fn record(&self, value: Result<usize, tikv_jemalloc_ctl::Error>) {
        if let Ok(value) = value {
            self.last.store(value as u64, Relaxed);
            self.min.fetch_min(value as u64, Relaxed);
            self.max.fetch_max(value as u64, Relaxed);
        }
    }

    /// Read an extremum and reset it for the next collection window.
    /// Falls back to the last value if no sample was recorded in the window.
    fn take(&self, extremum: &AtomicU64, empty: u64) -> u64 {
        match extremum.swap(empty, Relaxed) {
            v if v == empty => self.last.load(Relaxed),
            v => v,
        }
    }

    /// Export the `name`, `name.min` and `name.max` gauges.
    fn register(&'static self, name: &str) {
        let meter = global::meter("my-service");
        let gauge = |name: String, read: fn(&Sample) -> u64| {
            meter
                .u64_observable_gauge(name)
                .with_unit("By")
                .with_callback(move |obs| obs.observe(read(self), &[]))
                .build();
        };
        gauge(name.to_owned(), |s| s.last.load(Relaxed));
        gauge(format!("{name}.min"), |s| s.take(&s.min, u64::MAX));
        gauge(format!("{name}.max"), |s| s.take(&s.max, 0));
    }
}
```

</details>

<details open="true">
<summary>Then we can sample jemalloc metrics every second and export the results</summary>

```rust
/// Sample jemalloc every second, much more often than metrics are exported,
/// so the min/max gauges catch the peaks between two collections.
async fn sample_jemalloc() {
    let mut interval = tokio::time::interval(Duration::from_secs(1));
    loop {
        interval.tick().await;
        // jemalloc caches its stats: advance the epoch to refresh them.
        if epoch::advance().is_ok() {
            ALLOCATED.record(stats::allocated::read());
            ACTIVE.record(stats::active::read());
            RESIDENT.record(stats::resident::read());
            RETAINED.record(stats::retained::read());
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Push metrics over OTLP/HTTP (localhost:4318 by default, every 60s).
    let exporter = MetricExporter::builder().with_http().build()?;
    let provider = SdkMeterProvider::builder()
        .with_periodic_exporter(exporter)
        .build();
    global::set_meter_provider(provider.clone());

    ALLOCATED.register("jemalloc.allocated");
    ACTIVE.register("jemalloc.active");
    RESIDENT.register("jemalloc.resident");
    RETAINED.register("jemalloc.retained");
    tokio::spawn(sample_jemalloc());

    // ... run your service here.
    tokio::signal::ctrl_c().await?;

    provider.shutdown()?;
    Ok(())
}
```
</details>


### Second step: measuring those metrics against a variable load to determine what are the most representative metrics

...

### Third step: not seeing any representative metrics and asking yourself what is wrong!
Hopefully by reading this you will not fall into the same traps :D! Indeed I stumbled upon two main footguns.

Firstly, the jemallocator crate defaults to prefixed symbols, so it won't override the `malloc` family of functions in the resulting binary. If you have any C dependencies like zstd for compression/decompression, it will continue to use the default libc allocator. This is a big issue because zstd's own allocations won't be tracked by jemalloc. Hence the usage estimation will be invalid. To circumvent this, don't forget to enable the `unprefixed_malloc_on_supported_platforms` feature flag in your `Cargo.toml`!

Secondly, the main cause of our weird memory behavior is THP or Transparent Huge Pages!
This Linux feature might be enabled at the OS level by default. It will automatically allocate bigger pages than the ones asked by your allocator and will re-address the previously-allocated smaller pages on it. The issue is that it might increase the memory usage drastically (because a small 4 KiB allocation might be moved to a 2 MiB page) and more importantly, it won't be tracked as _resident_ memory by jemalloc. This only happens when the host setting is `always`. You can check it with `cat /sys/kernel/mm/transparent_hugepage/enabled`.

Also, even with traffic being much smaller, the RSS won't reduce because most of it consists of huge pages.
The best solution is to disable this feature on the allocator's memory with a `madvise` syscall. Jemalloc will do that for its own mappings if you specify `MALLOC_CONF=thp:never`. Without the unprefixed feature flag, the variable is `_RJEM_MALLOC_CONF`. This feature can cause a lot of other unexpected issues (see the redis doc [about transparent huge page](https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/#latency-induced-by-transparent-huge-pages)) and it only benefits certain types of workloads, so I strongly encourage you to read about it!

Jemalloc provides a lot of metrics for you: allocated, active, resident, retained, ... The question is not which one matches with my RSS/memory working set measured by the OS: none will. The best we can do is to measure the evolution of each metric against the RSS and determine a formula.

This being said, if we do our measure again with these two params, we can clearly see that the most representative metric is the resident, which is no surprise. Resident memory is the closest metric to what the OS sees, because it counts allocations, allocator overhead, fragmentation and dirty pages waiting to be removed. However, check what other metrics are available from jemalloc and whether they fit your program better! Most of the time the rule will be a linear function: `MAX_MEMORY = (limit - base) * factor`. The base accounts for the thread stacks, the program binary and static sections. The factor is a safety margin (0.75 on the system shown below).

![Memory usage metrics with an ingestion server being rolled out at the middle with `MALLOC_CONF=thp:never` and `unprefixed_malloc_on_supported_platforms`: RSS drops to around 85 MiB and moves in the same shape as the resident metric](/images/thp-enabling-jemalloc-vs-rss.png)

With a new config being rolled out with `MALLOC_CONF=thp:never` and `unprefixed_malloc_on_supported_platforms` we can see a significant RSS drop and more importantly it now follows the same shape as the resident metric!

Now let's run a little (actually two) ingestion benchmarks to check that the resident metric follows the RSS linearly:

![Two ingestion benchmarks, from 10:00 to 13:00 and from 16:00 to 17:00: RSS and jemalloc resident rise and fall together, about 65 MiB apart, while allocated and active stay under 72 MiB](/images/bench-jemalloc-vs-rss.png)

Here, with the two benchmarks, from 10:00 to 13:00 and from 16:00 to 17:00 we can see that resident is clearly the most appropriate metric. In comparison, the allocated metric follows the same shape but grows much less: about +30 MiB against +100 MiB for resident. The main reason is that freed memory is not released right away. It stays in dirty pages, which count as resident but not as allocated.

### Fourth step: applying backpressure against the resident metric
`MAX_MEMORY` comes from the rule above. The 0.75 factor is there because the resident metric is a lagging signal. It is sampled every second, so memory keeps growing between two samples. The margin must absorb that growth.

It also falls slowly. Freed memory stays in dirty pages until jemalloc purges them. So the server can keep rejecting requests for a while after the load is gone.

<details open="true">
<summary>Backpressure against resident metric</summary>

```rust
/// Reply `503` + `Retry-After` while jemalloc holds more than `MAX_MEMORY`.
async fn memory_limiter(req: Request, next: Next) -> Response {
    if RESIDENT.last.load(Relaxed) > MAX_MEMORY {
        return (StatusCode::SERVICE_UNAVAILABLE, [(header::RETRY_AFTER, "1")]).into_response();
    }
    next.run(req).await
}

async fn ingest(body: Bytes) -> StatusCode {
    let _ = body; // validate & forward downstream...
    StatusCode::ACCEPTED
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Configure OTEL SDK and jemalloc

    let app = Router::new()
        .route("/ingest", post(ingest))
        .layer(middleware::from_fn(memory_limiter)); // add a memory limiter layer

    Ok(())
}
```
</details>

The same check works for our pull based consumer. Instead of replying a `503`, it stops pulling new events while resident is above `MAX_MEMORY`. The stream acts as a buffer in the meantime.

### A small word about jemalloc metrics performance
When calling `epoch::advance()` to update jemalloc metrics, it is actually going to walk every memory arena. Jemalloc has this mechanism of having multiple memory arenas in order to reduce fragmentation and lock contention. It is controllable with the `narenas` param and by default is set to 4 per CPU thread. As jemalloc gets the number of CPU threads with `sched_getaffinity` and does not follow cgroups, on a 64-core host machine, narenas will be 256, even if you have a CPU limit of 1 so make sure to verify this.

# Conclusion

| Solution | What it bounds | Hard bound? | Main cost |
|---|---|---|---|
| Indirect | Requests × max size | Yes | Planning for the worst case |
| Byte budget | Bytes held by the tasks | Yes | More knobs, little crate support |
| Global | The whole heap | No, reactive | Measuring and tuning the allocator |

Indirect bounding is the easiest to set up, but you have to plan for the worst case. The global allocator solution is the easiest to operate: a single limit, and every allocation is counted. It’s the one I usually reach for in the first place. I fall back to byte-budget bounding when it fits the target system better, or when I need fine-grained control: tuning individual components separately instead of applying a single global limit. They aren’t mutually exclusive, and you can combine them if you need to. Keep in mind that the global limiter is reactive, not a hard bound. If a burst can outrun the margin, keep a concurrency limit behind it. Whichever you choose, bear in mind the performance impact on your own workload.

Let's reclaim all the memory from LLMs!
