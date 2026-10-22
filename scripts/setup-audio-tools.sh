#!/usr/bin/env bash
set -euo pipefail
# Reproducible, minimal FFmpeg/ffprobe build for S0 validation. No global install.
prefix="${1:?pass an absolute installation directory}"
case "$prefix" in /*) ;; *) exit 2 ;; esac
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
curl --fail --silent --show-error --location --max-time 120 https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz -o "$work/source.tar.xz"
expected=b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3
actual="$(shasum -a 256 "$work/source.tar.xz" | cut -d ' ' -f 1)"
test "$actual" = "$expected"
tar -xJf "$work/source.tar.xz" -C "$work"
cd "$work/ffmpeg-8.1.1"
./configure --prefix="$prefix" --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-x86asm \
  --enable-ffmpeg --enable-ffprobe --enable-protocol=file,pipe --enable-demuxer=mp3 \
  --enable-decoder=mp3,mp3float --enable-encoder=pcm_s16le --enable-muxer=pcm_s16le \
  --enable-filter=aresample,anull --enable-swresample > "$work/configure.log" 2>&1
make -j2 > "$work/build.log" 2>&1
make install > "$work/install.log" 2>&1
"$prefix/bin/ffmpeg" -version | head -1
"$prefix/bin/ffprobe" -version | head -1
