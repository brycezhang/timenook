# Synthetic MP3 fixture

synthetic-1s.mp3 is a generated440Hz sine wave, not a person's voice. Generated with FFmpeg8.1.1:

```sh
ffmpeg -hide_banner -loglevel error -f lavfi -i 'sine=frequency=440:sample_rate=16000:duration=1' -ac 1 -c:a libmp3lame -b:a 48k -write_xing 0 -id3v2_version 0 synthetic-1s.mp3
```

6480bytes; MP3/16kHz/mono/48kbps; 1080ms decoded frames including encoder padding. SHA-256: `11acbbcff6041a9f144e26d84400ec07264bb42885c3473a380cee08e75d1016`. Tests concatenate280 copies for a decoded302.4second rejection without storing a large fixture. CI only needs the pinned decoder.

`synthetic-576ms.mp3` is the first 16 complete frames of the same synthetic sine wave, with no voice or private sample. Each frame is 216 bytes and decodes to 36ms. This shorter quota fixture is derived once from the committed file, not encoded or parsed at test runtime:

```sh
python3 - <<'PY'
from pathlib import Path
fixtures = Path('apps/api/test/fixtures')
audio = (fixtures / 'synthetic-1s.mp3').read_bytes()
(fixtures / 'synthetic-576ms.mp3').write_bytes(audio[:16 * 216])
PY
```

3456 bytes; MP3/16kHz/mono/48kbps; **576ms** from complete strict decoding with the pinned FFmpeg 8.1.1 minimal build (18432 PCM bytes). SHA-256: `7ec4ca61f1bff58664e1675bbb9cde206fb97ea175e06191d322acfecd53af80`. T14 API and browser tests read these files directly; audio validation still runs the pinned decoder, including the actual duration/hash/quota checks. No encoder, lavfi, or libmp3lame capability is required in CI.

`catalog-synthetic.json` 是 T08 独立本地测试夹具。印刷规格、商业期限/额度/地区、身份和审核引用全部是合成值，不是已批准销售参数；仅导入随机测试 schema，并在测试后清理。

`privacy-upgrade.test.ts` 从固定提交 `321f0e15a0687f458df6d60ad88bff793cd3c8d4` 提取并运行真实历史代码，以验证原有撤回/删除事实在升级及旧备份恢复后不会丢失。该历史代码依赖的 `otplib@13.5.0` 仅列为 API 的固定开发依赖，供隔离历史测试通过 `NODE_PATH` 解析；当前应用、生产依赖及飞书登录均不使用它。升级后历史操作人只保留禁用、未绑定的审计身份，旧密码/MFA 会话拒绝访问；测试为当前部署显式建立新的飞书白名单身份，不迁移旧凭据或猜测飞书绑定。
