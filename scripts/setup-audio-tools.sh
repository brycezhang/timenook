#!/usr/bin/env bash
set -euo pipefail
# Reproducible, minimal FFmpeg/ffprobe build for S0 validation. No global install.
download_audio_archive() {
  local directory="$1" primary_url="$2" expected="$3" mirror_url="$4" mirror_expected="$5"
  local archive="$directory/source.tar.xz" actual status
  # No implicit curlrc/retries: each source gets one bounded transfer. Integrity
  # or certificate/HTTP failures must not be hidden by switching sources.
  if curl --disable --fail --silent --show-error --location --connect-timeout 10 --max-time 45 --retry 0 "$primary_url" -o "$archive"; then
    :
  else
    status=$?
    case "$status" in
      5|6|7|18|28|35|52|55|56|92) ;;
      *) return "$status" ;;
    esac
    rm -f "$archive"
    archive="$directory/source.tar.gz"
    expected="$mirror_expected"
    echo 'FFmpeg release transport unavailable; trying pinned upstream mirror' >&2
    curl --disable --fail --silent --show-error --location --connect-timeout 10 --max-time 45 --retry 0 "$mirror_url" -o "$archive" || return $?
  fi
  actual="$(shasum -a 256 "$archive" | cut -d ' ' -f 1)" || return $?
  if [[ "$actual" != "$expected" ]]; then
    echo 'FFmpeg source checksum mismatch' >&2
    return 1
  fi
  printf '%s\n' "$archive"
}
# Sourcing exposes only the acquisition seam to controlled transport tests.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then return; fi
prefix="${1:?pass an absolute installation directory}"
case "$prefix" in /*) ;; *) exit 2 ;; esac
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive="$(download_audio_archive "$work" \
  https://ffmpeg.org/releases/ffmpeg-8.1.1.tar.xz \
  b6863adde98898f42602017462871b5f6333e65aec803fdd7a6308639c52edf3 \
  https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/239f2c733de417201d7ad3b3b8b0d9b63285b2b1 \
  ec0aa20fb9f6fd3692ffc04dc12ffa43cfffc4a479e388ccd7910ec6cfe188a2)"
if [[ "$archive" == *.tar.xz ]]; then
  tar -xJf "$archive" -C "$work"
  cd "$work/ffmpeg-8.1.1"
else
  tar -xzf "$archive" -C "$work"
  cd "$work/FFmpeg-239f2c733de417201d7ad3b3b8b0d9b63285b2b1"
fi
./configure --prefix="$prefix" --disable-everything --disable-autodetect --disable-doc --disable-debug --disable-x86asm \
  --enable-ffmpeg --enable-ffprobe --enable-protocol=file,pipe --enable-demuxer=mp3 \
  --enable-decoder=mp3,mp3float --enable-encoder=pcm_s16le --enable-muxer=pcm_s16le \
  --enable-filter=aresample,anull --enable-swresample > "$work/configure.log" 2>&1
make -j2 > "$work/build.log" 2>&1
make install > "$work/install.log" 2>&1
"$prefix/bin/ffmpeg" -version | head -1
"$prefix/bin/ffprobe" -version | head -1
