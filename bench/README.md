Run `yarn bench` to build the package and measure serialization and deserialization of an eight-field object, a 20-item order with typed primitives/Dates/a Map, and chains of 64, 128, and 256 objects. The harness also checks sync/async output equality and counts transform invocations.

Each case warms up with 100 operations, then records five samples of at least 100 ms each. Output is JSON Lines containing the environment, operation counts, median time, and minimum/maximum sample times. Timings are microseconds per operation. Async cases have no async user callbacks, isolating library overhead. These are local microbenchmarks, not service latency or concurrent-load measurements.

To compare another revision, build that revision in a separate checkout and pass its built entry point to the same harness:

```sh
node bench/serde.mjs /path/to/baseline/dist/index.mjs
node bench/serde.mjs
```

Run the processes sequentially so that they do not compete for CPU. For CPU profiling, use `node --cpu-prof bench/serde.mjs`; use unprofiled runs for before/after timings.

The September 5, 2026 comparison used baseline commit `bac1766`, after the correctness fixes and before the traversal optimization. Node v24.17.0 ran on Windows with an Intel Core i7-9700K CPU at 3.60 GHz. The baseline CPU profile attributed 2,207 samples to synchronous class serialization and 1,119 to synchronous value normalization, aggregated across recursive call stacks. Transform counting established the mechanism: a chain of N objects ran N(N+1)/2 synchronous transforms through the async API.

The optimized implementation normalizes each value once, keeps one ancestor set for cycle detection, processes siblings sequentially, and avoids Promise creation/await for scalar normalization. Scalar codecs and synchronous transforms retain their output; async transforms produce wire values before normalization.

| Async serialization workload | Before µs/op | After µs/op | Time reduction |
| --- | ---: | ---: | ---: |
| Eight-field object | 1.420 | 1.079 | 24.0% |
| Order with 20 items | 120.448 | 45.815 | 62.0% |
| 64-node chain | 1,236.467 | 47.406 | 96.2% |
| 128-node chain | 4,829.187 | 96.302 | 98.0% |
| 256-node chain | 19,620.370 | 198.076 | 99.0% |

All measured async serialization workloads exceed the 10% acceptance threshold. Doubling chain depth now approximately doubles elapsed time, and a 256-node chain executes 256 transforms instead of 32,896. The regression suite asserts the linear invocation count without using flaky timing assertions. Synchronous serialization and deserialization were also measured as controls; their raw timings are retained below, and no deserialization improvement is claimed.

Raw measurements: [baseline](results/baseline.jsonl), [single traversal](results/single-pass.jsonl).
