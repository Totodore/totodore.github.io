+++
title = "Memory bounded systems and backpressure in rust"
date = 2026-11-07
description = ""
[taxonomies]
tags = ["memory", "rust"]
+++

> No LLMs were involved in the writing process of this article.

As everybody knows and especially nowadays with the RAM shortage situation because of LLM's, memory is not infinite. Therefore a lot of workloads, process, pods need system limits. For instance in the case of embedded systems but also, more "classicaly" in webserver, remote systems, etc etc.
Indeed the machine hosting your process, virtual or physical wont have infinite RAM and once all of it is consumed, will start to slow or kill processes through the OOM killer, which will degrade the service you are actually trying to provide.
For this reason, it is quite usual in Kubernetes for example but also more generally to add limits to process and pods, most usually by using linux cgroups, which are a way to add CPU and memory limits on processes. Today we will only talk about memory limits, CPU limits is a whole different topic.

So what do we mean, by memory backpressure? Well this is simply the ability of a system to refuse new workload in order to limit its memory usage to a given threshold. There are multiple solutions depending on the programming language and the kind of system you are integrating this to. We will focus on rust.

First, what can we bound and what is not controllable. A global process RSS count a lot of different kinds of memories:
* The instructions of the program being run.
* The static sections, handling all of the static, mutable and non-mutable data you defined.
* Threads stacks.
* Memory allocated dynamically by the process.

The only one we can really manage is the memory allocated dynamically, the three following solutions will concerns only this kind of memory.

# Indirect memory bounding
This can be applied to any language, this is not specific to rust.
The easiest way to bind your system memory is to limit what it can do and especially what it can process in parallel. The most basic example is with webserver, you can always limit the number of concurrent request.

### An example with tower services
If your system implement the [tower `Service` trait]() (which I highly recommend you to do for ecosystem integration purpose), you can leverage the [concurrency limit layer](https://docs.rs/tower/latest/tower/limit/concurrency/) for this. And expose the concurrency limit as a configuration knob. If your memory allocation is tied to requests handling this might be one of the easiest solutions.

### An example with mpsc channels
Another way to perform indirect memory bounding is to limit the size of your mpsc channels transporting load to process and add a message concurrency limit on your worker tasks that consume
the channels message.
_TODO: insert example with mpsc channels consumption_

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

# The sweet spot in between: specific memory bounding
Some of you my probably notice that we didn't talk about memory arenas or memory allocators yet.
First of all, using such solution might no be an option, especially if most of the allocations made by your service are coming from external libs. Today, it is extremely rare to find libs that support custom allocators or that are only arena based. Some workload can fit the bounded areana model the allocator trait stabilisation is extremely recent. That being saif, if your allocation are mostly coming from your system you can add a parallel workload bounds like in the first section but specify it in terms of bytes (memory rather than in number of workload)
 One of the big advantage of this is a that it allows for a finer customization of the system behavior compared to the global Allocator solution. The only issue is that it might cost you more configurations burden and that it imight not be applicable for every systems.
 I personnally tend towards using the global allocator solution and fallback for the third if
 it is required.
 I.e. in case of need for fine grain customization, avoiding metric collection pauses.
