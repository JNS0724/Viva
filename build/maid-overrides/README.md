# Approved half-body runtime overrides

These quality-90 WebP files supersede three files from the base V7 delivery:

- `greeting-motion.webp`: V7.1 wrist wave, 1.98-second loop with a 720 ms rest.
- `done.webp` and `done-motion.webp`: V7.2 card lift and thumbs-up; 400px still, 256px animation, 11 frames and a 2.59-second loop with an 850 ms high-point hold.

They were exported once from the approved lossless deliveries with Pillow 12.0.0 / libwebp 1.6.0, quality 90, method 4 and animation size minimization. `manifest.json` records original lossless delivery hashes, compressed hashes and playback metadata.

`scripts/optimize-maid-assets.py` validates and copies these exact compressed bytes when reproducing `src/assets/maid/`. It does not encode a lossy copy again. The rest of the art still comes from the recorded base delivery commit. This directory stays outside `out/` and the packaged application; production uses only the copies in `src/assets/maid/`.

The manifest digest normalizes CRLF to LF so Git's Windows text checkout produces the same recorded hash. WebP file hashes always cover the original binary bytes.
