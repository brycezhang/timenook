# Native E2E audio

`silence-1s.mp3` is one second of generated silence, with no microphone input or personal content. The native E2E injects it at the RecorderManager boundary; file persistence and project state use the actual mini-program implementation. It is not an ASR or device-recording acceptance sample.

Recreate with:

```sh
ffmpeg -f lavfi -i anullsrc=r=16000:cl=mono -t 1 -codec:a libmp3lame -b:a 32k -map_metadata -1 silence-1s.mp3
```
