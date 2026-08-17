# Example: a documentation file named CLAUDE.md

Fixture for publish-managed-region.test.mjs and for the export's own byte-identity check.
This file is NOT a projection target. It is documentation that quotes the reconciler's fence
markers as an example, which is exactly the shape publish.sh used to rewrite when it selected
targets by basename.

The sample region below is deliberately NON-empty, so it doubles as a canary: if the export ever
starts selecting this file again, step 6c rewrites it and check (h) reports it. A byte-identical
copy in the export is the passing state.

<!-- managed:reconciler:begin schema=2 inputs=sample -->
## Rules (projected from memory: do not edit; edit the source node)
- Sample projected rule, shown so a reader can see what the region looks like when it is full.
<!-- managed:reconciler:end -->

Nothing in the export pipeline may touch the bytes of this file.
