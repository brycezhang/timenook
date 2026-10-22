# Synthetic HEIC sample

`synthetic.heic` is a 96 × 64 solid RGB (36,123,147) image, generated locally on
2026-10-22 using sharp 0.34.5 to PNG and macOS `/usr/bin/sips -s format heic`.
It contains real HEVC data, not a renamed JPEG. There is no person's image,
location, title, or recording. Source pixels are defined in `photo.test.mjs`.
This generated sample may be used under the repository's terms.

The decoder test verifies HEVC metadata, the output dimensions, and decoded
RGB against the independent source color, with tolerance for lossy encoding.
It is a candidate single-image conversion proof, not coverage of every iPhone
HEIC variant, HDR/ICC combination, EXIF orientation or image sequence.
