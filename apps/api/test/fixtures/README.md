# Synthetic MP3 fixture

synthetic-1s.mp3 is a generated440Hz sine wave, not a person's voice. Generated with FFmpeg8.1.1:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=1' -ac 1 -c:a libmp3lame -b:a 48k -write_xing 0 -id3v2_version 0 synthetic-1s.mp3
```

6480bytes; MP3/16kHz/mono/48kbps; 1080ms decoded frames including encoder padding. SHA-256: `11acbbcff6041a9f144e26d84400ec07264bb42885c3473a380cee08e75d1016`. Tests concatenate280 copies for a decoded302.4second rejection without storing a large fixture. CI only needs the pinned decoder.

`catalog-synthetic.json` 是 T08 独立本地测试夹具。印刷规格、商业期限/额度/地区、身份和审核引用全部是合成值，不是已批准销售参数；仅导入随机测试 schema，并在测试后清理。
