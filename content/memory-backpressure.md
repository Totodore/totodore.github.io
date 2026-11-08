+++
title = "Memory bounded systems and backpressure in rust"
date = 2026-11-07
description = ""
[taxonomies]
tags = ["memory", "rust"]
+++

As everybody knows and especially nowadays with the RAM shortage situation because of LLM's, memory is not infinite. Therefore a lot of workloads, process, pods need system limits. For instance in the case of embedded systems but also, more "classicaly" in webserver, remote systems, etc etc.
Indeed the machine hosting your process, virtual or physical wont have infinite RAM and once all of it is consumed, will start to slow or kill processes through the OOM killer, which will degrade the service you are actually trying to provide.
For this reason, it is quite usual in Kubernetes for example but also more generally to add limits to process and pods, most usually by using linux cgroups, which are a way to add CPU and memory limits on processes. Today we will only talk about memory limits, CPU limits is a whole different topic.

So what do we mean, by memory backpressure? Well this is simply the ability of a system to delay new workloads or slow down to limit its memory usage to a given threshold. There are multiple solutions depending on the programming language, the kind of system you are integrating this to and the architecture of your systems. We will focus on rust.

First, what can we bound and what is not controllable? A global process RSS count a lot of different kinds of memories:
* The instructions of the program being run.
* The static sections, handling all of the static, mutable and non-mutable data you defined.
* Threads stacks.
* Memory allocated dynamically by the process.

The only one we can really manage is the memory allocated dynamically, the three following solutions will concerns only this kind of memory and we will put the other in a to-measure overhead, either constant or growing linearly with the load.

The following article will be based on too systems.
* An live ingestion HTTP server that is at the front of a data processing pipeline. We can picture this as a push based consumption model. Requests are pushed over the network, if it can't accept traffic anymore, the server will reply a `503` header with a `Retry-After` header.
* A data processing system that will do CPU/Memory bound processing behind a stream implementation (kafka/nats). We can picture this as a poll based consumption mode. The downstream service will poll new work to perform only when it can and will rely on the stream to act as a buffer in the meantime.

We can define this difference as cooperative backpressure VS non-cooperative. Push based consumption model **expects** that the client respects the `Retry-After` header, but the client is not forced to. Poll based does not rely on an expected behavior.

# Indirect memory bounding
This can be applied to any language, this is not specific to rust.
The easiest way to bind your system memory is to limit two things:
* The incoming load per request. For this we need to find a metric that match linearly with the load of the service. For example with our server implementation it could be the request body size.
* The maximum number of requests it can process in parallel with a semaphore.

### An example with tower services
If your system implement the [tower `Service` trait]() (which I highly recommend you to do for ecosystem integration purpose), you can leverage the [concurrency limit layer](https://docs.rs/tower/latest/tower/limit/concurrency/) for this. And expose the concurrency limit as a configuration knob. If your memory allocation is tied to requests handling this might be one of the easiest solutions.

### An example with poll based consumers

### An example with mpsc channels
Another way to perform indirect memory bounding is to limit the size of your mpsc channels transporting load to process and add a message concurrency limit on your worker tasks that consume
the channels message.
_TODO: insert example with mpsc channels consumption_

### Capacity planning and caveats
Once you have ways to limit the workload, you need to tune them and for this you need to measure the metrics you picked against the real memory usage and determine a rule.
There are multiple caveats with this solution that will appear in this process:
* you actually need to plan limits for the worst case scenario. For our server implementation, with a 5 MB request body and with a concurrency limit set to 1000 req in //. It results `5 GB` of memory. And actually most request body might only weight 1 MB.
* Other memory allocations, allocator overhead, memory fragmentation not counted, so you need to manually account for them, and it might be completely different depending on the input.

# Byte-budget bounding
In fact, the capacity planning complexity comes from the load per request, the maximum number of parallel request is straightforward to plan.
So byte budget is another solution is to bind the possible allocation for a given work task, through either a dedicated allocator or bounded arena. The idea is to limit the maximum allocated memory for the processing task either with a memory arena or a custom allocator.
One of its biggest advantage is a that it allows for a finer customization of the system behavior while having a more precise idea of what we are limiting. And you can implement different behavior if your memory bound is reach, for example you can flush processed data eagerly if it is scratch data or you can refuse any incoming data.

However, it might cost you more configurations burden, the operator need to tweak multiple limits and understand how they interact each others. Also it might not be applicable for every systems.
Indeed, using such solution might no be an option, especially if most of the allocations made by your service are coming from external libs. Today, it is extremely rare to find libs that support custom allocators or that are only arena based. Some workload can not fit the bounded arena model and the allocator trait is just being stabilized (coming with rust 1.100).

# Global memory bounding
A lot of memory managed langages have ways of bounding memory through Garbage Collection.
Go has `GOMEMLIMIT`, Java has `MaxRAMPercentage` and `MaxHeapSize`, ... However there is no standard mechanism available for this in Rust (or any language that is not memory managed).

However, you can use a custom allocator that will give you stats of your heap usage. These allocators are usually declared globally (though the `Allocator` trait has recently been stabilized).
__examples__

### Jemallocator
So I decided to use jemalloc for my use case: an HTTP server, at the beggining of a data processing pipeline that was ingesting and validating high volume of data to be processed downstream.
This HTTP server is build statically with musl. It must be able to refuse new requests with a 503 status code and a `Retry-After` header if its memory limit is threspassed. So we need to know, in realtime the current memory usage with a minimal performance impact.

I opted for Jemalloc since it is one of the most complete allocators and provide a lot of features. Moreover the the rust integration is really nice with the `_jemallocator_` and `jemallocator_ctl` crates.

## Example


## Footguns
* The jemallocator crate default to prefixed symbols, so it wont override the `malloc` family set of functions in the resulting binary. If you have any C dependencies like zstd for compression/decompression, it will continue to use the default musl's libc allocator. This is a big issue because zstd's own allocation wont be tracked by jemallocator so the usage estimation will be invalid.
* THP options: linux has a feature that might be enabled at the OS level by default named Transparent Huge Pages. This will automatically allocate bigger pages that the one asked by your allocator and re-address the allocated smaller pages on it. The issue is that it might increase the memory usage by a lot (because a small 4KiB allocation might be moved to a 1 MiB page) and more importantly, it wont be tracked as _resident_ memory by jemalloc. The best solution is to disable this feature at the program level with a `madvise` syscall. Jemalloc will do that for you if you specify `MALLOC_CONF=thp:never` or `JEMALLLOCA_CONF=thp:never`. This feature can cause a lot of surprising issues (see the redis doc about transparent huge page and https://redis.io/docs/latest/operate/oss_and_stack/management/optimization/latency/#latency-induced-by-transparent-huge-pages for example) and it only benefits certain types of workloads.
* What jemalloc metric should I track to measure against my threshold, i.e. what metric is the most representative of the total memory usage.
Jemalloc provides a lot of metrics for your: allocated, resident, residual, retained, ... The question is not about whats the one that will match with my RSS/memory working set measured by the OS: non will. The best that we can do is to measure the evolution of each metric against the RSS and determine a formula. Which will most likely be linear: C + alpha * M = RSS.
With this we can account for the thread stacks, the binary program binary and static sections as well as a pre-defined overhead (lets say 75%).


 I personnally tend towards using the global allocator solution and fallback for the third if
 it is required.
 I.e. in case of need for fine grain customization, avoiding metric collection pauses.
