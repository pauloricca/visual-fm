#!/usr/bin/env sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
IMAGE="${RUST_WASM_IMAGE:-visual-fm-rust-wasm:1.87}"
CRATE_DIR="/work/rust/visual-fm-kernel"
OUTPUT="/work/src/wasm/visual-fm-kernel.wasm"

mkdir -p "$ROOT/src/wasm"

if [ "${RUST_WASM_SKIP_IMAGE_BUILD:-0}" != "1" ]; then
  docker build \
    -f "$ROOT/rust/visual-fm-kernel/Dockerfile" \
    -t "$IMAGE" \
    "$ROOT"
fi

docker run --rm \
  -v "$ROOT:/work" \
  -w "$CRATE_DIR" \
  "$IMAGE" \
  sh -c "cargo build --release --target wasm32-unknown-unknown && cp target/wasm32-unknown-unknown/release/visual_fm_kernel.wasm '$OUTPUT'"

printf 'Wrote %s\n' "$ROOT/src/wasm/visual-fm-kernel.wasm"
