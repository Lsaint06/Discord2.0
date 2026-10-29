# Milestone 14 ? sound asset manifest

Generated from `desktop/src/renderer/src/assets/sounds/manifest.json`, which the renderer
script writes when it renders the files. Every number below is measured from the actual file.

## Provenance and license

| Item | Value |
| --- | --- |
| Source | Original procedural synthesis in `desktop/scripts/sounds/render-sounds.mjs` (FM bells, Karplus?Strong plucks, kalimba tines, band-limited pulse/saw waves, filtered noise, Freeverb-style reverb) |
| Third-party audio | **None.** No samples, recordings or downloaded sound packs. No Discord sounds were referenced or copied. |
| License | Original work for Discord 2.0 (`assets/sounds/LICENSE.md` ships with the app) |
| Format | WAV, PCM s16le, 48 kHz, mono |
| Files | 144 (6 packs ? 24 events) |
| Total size | 8.87 MiB |
| Reproducible | `node scripts/sounds/render-sounds.mjs --check` re-renders and compares SHA-256 (byte-identical) |

## Objective QA method

- Loudness: ITU-R BS.1770 K-weighting at 48 kHz, measured as the loudest 400 ms window ("momentary max", LUFS). Targets: alerts ?18, standard ?20, controls ?25 LUFS. Minimal is 2 LU quieter and Arcade 1 LU quieter, both by design.
- Peak ceiling: ?1.5 dBFS sample peak, applied as a gain change only (no limiter, so no distortion). The true peak is approximated with 4? cubic interpolation.
- Mastering: 70 Hz high-pass (removes DC and rumble), 1.5 ms fade-in and 25 ms fade-out, tail trimmed below ?58 dBFS (a 20 ms tail is kept), TPDF dither, and exact-zero first and last samples.
- The automated tests (`desktop/src/renderer/src/sound/packs.test.ts`) check every file:
  - header (48 kHz, mono, 16-bit) and SHA-256 hash;
  - loudness window and peak headroom;
  - no clipped samples and small DC offset;
  - zero edge samples, leading silence ? 30 ms and trailing silence ? 25 ms;
  - duration between 40 ms and 2 s;
  - uniqueness and the size budget.
- **Human listening:** none. Nobody has listened to these files yet; that is the owner's audition checklist in the manual test guide.

## Summary per pack

| Pack | Files | Size (KiB) | Duration range (ms) | Loudness range (LUFS) | Max peak (dBFS) | Clipped samples |
| --- | --- | --- | --- | --- | --- | --- |
| signature | 24 | 2120 | 442?1361 | -25.14 ? -18 | -3.37 | 0 |
| classic | 24 | 1282 | 181?909 | -25.08 ? -18 | -3.79 | 0 |
| minimal | 24 | 719 | 65?399 | -27.13 ? -20 | -4.67 | 0 |
| cyber | 24 | 1665 | 340?1092 | -25.16 ? -18 | -3.27 | 0 |
| cozy | 24 | 2596 | 498?1616 | -25.02 ? -18 | -6.88 | 0 |
| arcade | 24 | 702 | 65?496 | -26.12 ? -19 | -6.03 | 0 |

## Every file

| File | Class | Bytes | ms | LUFS (mom. max) | Peak dBFS | ~True peak | Lead ms | SHA-256 (first 16) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| `signature/message.wav` | standard | 95450 | 994 | -20 | -10.47 | -10.47 | 0.5 | `b2407c4cbec5a1db` |
| `signature/mention.wav` | alert | 110396 | 1150 | -18 | -8.75 | -8.72 | 0.5 | `5a695d3ac8879d3a` |
| `signature/directMessage.wav` | alert | 109870 | 1144 | -18 | -8.41 | -8.36 | 0.4 | `1c6f4ba13e7508ec` |
| `signature/friendRequest.wav` | alert | 118910 | 1238 | -18 | -8.11 | -8.11 | 0.4 | `784a1cb28e130a4f` |
| `signature/friendAccepted.wav` | standard | 118220 | 1231 | -20 | -9.3 | -9.3 | 0.3 | `632279a0e29ac2f4` |
| `signature/voiceJoin.wav` | standard | 95050 | 990 | -20 | -9.19 | -9.16 | 0.4 | `b0794e965ba1f88d` |
| `signature/voiceLeave.wav` | standard | 95162 | 991 | -20 | -9.9 | -9.89 | 0.4 | `0a19fa0fc310bd20` |
| `signature/connect.wav` | standard | 113322 | 1180 | -20 | -9.75 | -9.72 | 0.5 | `a7ee4e79ff7b065e` |
| `signature/disconnect.wav` | standard | 101298 | 1055 | -20 | -10.63 | -10.62 | 0.4 | `324a1b58741b8d91` |
| `signature/voiceDrop.wav` | alert | 130716 | 1361 | -18 | -8.76 | -8.75 | 0.4 | `94306bc1de1135da` |
| `signature/reconnect.wav` | standard | 90326 | 940 | -20 | -10.29 | -10.29 | 0.4 | `9022f78281301d5d` |
| `signature/streamStart.wav` | standard | 122714 | 1278 | -20 | -11.52 | -11.51 | 16.4 | `e29fc864c495bc1b` |
| `signature/streamStop.wav` | standard | 103606 | 1079 | -20 | -9.72 | -9.72 | 5.6 | `ba2c5f052d51ccce` |
| `signature/streamRemoteStart.wav` | standard | 89690 | 934 | -20 | -11.86 | -11.86 | 0.4 | `acc1ed64ac8b45a1` |
| `signature/streamRemoteStop.wav` | standard | 91424 | 952 | -20 | -11.38 | -11.35 | 0.4 | `10d6d650413419d3` |
| `signature/mute.wav` | control | 51222 | 533 | -25.14 | -3.98 | -3.97 | 0.2 | `f9ff24682b8d5399` |
| `signature/unmute.wav` | control | 46432 | 483 | -25.09 | -3.37 | -3.35 | 0.1 | `c5f137c217edfce7` |
| `signature/deafen.wav` | control | 54872 | 571 | -25.04 | -7.06 | -7.03 | 0.2 | `871cb9cf97930a98` |
| `signature/undeafen.wav` | control | 55062 | 573 | -25.05 | -8.13 | -8.13 | 0.2 | `d9c0e8fbf70423f0` |
| `signature/pttOn.wav` | control | 42516 | 442 | -25.07 | -6.6 | -6.6 | 0.2 | `c2fe80b72441105a` |
| `signature/pttOff.wav` | control | 46188 | 481 | -25.08 | -5.35 | -5.34 | 0.1 | `5ce2e589f532a47a` |
| `signature/uploadDone.wav` | standard | 98852 | 1029 | -20 | -10.69 | -10.68 | 0.4 | `f2fb583e898b7cd9` |
| `signature/uploadFailed.wav` | standard | 95298 | 992 | -20 | -10.16 | -10.16 | 0.4 | `946fc7a8fec5e5b4` |
| `signature/sendFailed.wav` | standard | 94044 | 979 | -20 | -10.67 | -10.66 | 0.4 | `fd2e8c7b80336cde` |
| `classic/message.wav` | standard | 53276 | 555 | -20 | -8.71 | -8.7 | 0.7 | `6246cc9045b29fa3` |
| `classic/mention.wav` | alert | 75754 | 789 | -18 | -8.5 | -8.49 | 0.7 | `aab0ec01b1649e93` |
| `classic/directMessage.wav` | alert | 74844 | 779 | -18 | -8.24 | -8.22 | 0.4 | `f80239086a945e39` |
| `classic/friendRequest.wav` | alert | 77744 | 809 | -18 | -7.82 | -7.82 | 0.5 | `a054e0183970909a` |
| `classic/friendAccepted.wav` | standard | 77714 | 809 | -20 | -8.29 | -8.28 | 0.4 | `5833a59e0577a0b2` |
| `classic/voiceJoin.wav` | standard | 56572 | 589 | -20 | -8.73 | -8.73 | 0.4 | `9bad0992be37d23e` |
| `classic/voiceLeave.wav` | standard | 56594 | 589 | -20 | -8.44 | -8.44 | 0.4 | `215b2023df2190d0` |
| `classic/connect.wav` | standard | 70012 | 729 | -20 | -7.97 | -7.97 | 0.5 | `8a629253d3dc6034` |
| `classic/disconnect.wav` | standard | 71950 | 749 | -20 | -9.82 | -9.82 | 0.4 | `ab7acf08a70285df` |
| `classic/voiceDrop.wav` | alert | 87348 | 909 | -18 | -8.24 | -8.24 | 0.4 | `3034eedecf433762` |
| `classic/reconnect.wav` | standard | 47982 | 499 | -20 | -8.24 | -8.24 | 0.4 | `352090de505838c9` |
| `classic/streamStart.wav` | standard | 83436 | 869 | -20 | -9.42 | -9.41 | 0.5 | `509136cefb3af6fb` |
| `classic/streamStop.wav` | standard | 67154 | 699 | -20 | -9.44 | -9.43 | 0.6 | `22491f69f3571b89` |
| `classic/streamRemoteStart.wav` | standard | 54662 | 569 | -20 | -9.26 | -9.26 | 0.6 | `881f317ecf659983` |
| `classic/streamRemoteStop.wav` | standard | 54680 | 569 | -20 | -10.02 | -10 | 0.5 | `b53e37fe2c246869` |
| `classic/mute.wav` | control | 19320 | 201 | -25.08 | -4.97 | -4.95 | 0.2 | `22fe46f6d1bc364b` |
| `classic/unmute.wav` | control | 21324 | 222 | -25.06 | -3.79 | -3.79 | 0.2 | `bfb1a839554a1ca0` |
| `classic/deafen.wav` | control | 25632 | 267 | -25.03 | -5.87 | -5.86 | 0.2 | `20ea1cf05a906e05` |
| `classic/undeafen.wav` | control | 24356 | 253 | -25.04 | -6.89 | -6.86 | 0.1 | `a4764e30c91a1144` |
| `classic/pttOn.wav` | control | 17452 | 181 | -25.06 | -7.1 | -7.1 | 0.3 | `5ae285add00701a0` |
| `classic/pttOff.wav` | control | 21092 | 219 | -25.07 | -5.39 | -5.38 | 0.2 | `71398666b842f454` |
| `classic/uploadDone.wav` | standard | 57566 | 599 | -20 | -9.23 | -9.21 | 0.5 | `ffa061ac05758ef0` |
| `classic/uploadFailed.wav` | standard | 62366 | 649 | -20 | -9.53 | -9.53 | 0.4 | `a7018d278939df85` |
| `classic/sendFailed.wav` | standard | 53736 | 559 | -20 | -8.58 | -8.57 | 0.4 | `19d39649ef332a12` |
| `minimal/message.wav` | standard | 38330 | 399 | -22 | -9.66 | -9.63 | 0.6 | `c6a15172fb980573` |
| `minimal/mention.wav` | alert | 38374 | 399 | -20 | -9.16 | -9.11 | 0.5 | `4e9c33e7da2ebc5a` |
| `minimal/directMessage.wav` | alert | 38380 | 399 | -20 | -8.3 | -8.28 | 0.4 | `aa79406a71c7aebe` |
| `minimal/friendRequest.wav` | alert | 38370 | 399 | -20 | -8.01 | -7.99 | 0.6 | `4c743033cf007e25` |
| `minimal/friendAccepted.wav` | standard | 38370 | 399 | -22 | -10.2 | -10.17 | 0.6 | `0dbf08cdd6a02cb9` |
| `minimal/voiceJoin.wav` | standard | 38352 | 399 | -22 | -8.78 | -8.78 | 0.4 | `c5b1432a2e2f45a7` |
| `minimal/voiceLeave.wav` | standard | 38310 | 399 | -22 | -9.29 | -9.29 | 0.4 | `d9beddfbafef22c8` |
| `minimal/connect.wav` | standard | 38382 | 399 | -22 | -9.42 | -9.42 | 0.4 | `e6d7e61873fe69e0` |
| `minimal/disconnect.wav` | standard | 38316 | 399 | -22 | -9.42 | -9.42 | 0.4 | `95baca525baa239c` |
| `minimal/voiceDrop.wav` | alert | 38384 | 399 | -20 | -7.22 | -7.22 | 0.4 | `2dad69fe4d2df731` |
| `minimal/reconnect.wav` | standard | 38326 | 399 | -22 | -8.91 | -8.91 | 0.4 | `71ea0cb2ffe873b0` |
| `minimal/streamStart.wav` | standard | 38356 | 399 | -22 | -11.32 | -11.32 | 0.5 | `50d9ad70fc7a6e4c` |
| `minimal/streamStop.wav` | standard | 32612 | 339 | -22 | -10.15 | -10.15 | 0.4 | `1b1b2735018699b4` |
| `minimal/streamRemoteStart.wav` | standard | 38342 | 399 | -22 | -10.77 | -10.72 | 0.5 | `ba42130fc5431351` |
| `minimal/streamRemoteStop.wav` | standard | 38324 | 399 | -22 | -10.9 | -10.9 | 0.4 | `e638a6be84b83753` |
| `minimal/mute.wav` | control | 6276 | 65 | -27.13 | -4.67 | -4.67 | 0.2 | `a1f4870833822df2` |
| `minimal/unmute.wav` | control | 6270 | 65 | -27.09 | -6.76 | -6.72 | 0.2 | `64f99b75c0c962e5` |
| `minimal/deafen.wav` | control | 13478 | 140 | -27.03 | -8.58 | -8.53 | 0.3 | `2ab5836ea5b2fa02` |
| `minimal/undeafen.wav` | control | 13438 | 140 | -27.04 | -9.03 | -9 | 0.2 | `76b40c1403f95095` |
| `minimal/pttOn.wav` | control | 6248 | 65 | -27.13 | -8.52 | -8.52 | 0.2 | `f2c6e002b879cebf` |
| `minimal/pttOff.wav` | control | 6268 | 65 | -27.11 | -7.46 | -7.38 | 0.2 | `1cd04262d4c0c4ea` |
| `minimal/uploadDone.wav` | standard | 38362 | 399 | -22 | -9.84 | -9.82 | 0.6 | `7b641f334e773899` |
| `minimal/uploadFailed.wav` | standard | 38344 | 399 | -22 | -9.27 | -9.27 | 0.4 | `2ca5829651085770` |
| `minimal/sendFailed.wav` | standard | 38338 | 399 | -22 | -8.8 | -8.8 | 0.4 | `076f1503bb80dac0` |
| `cyber/message.wav` | standard | 69970 | 728 | -20 | -5.29 | -5.2 | 0.4 | `4bc8faaa24e85313` |
| `cyber/mention.wav` | alert | 89936 | 936 | -18 | -5.05 | -4.92 | 0.4 | `2f93f846be8e9ccd` |
| `cyber/directMessage.wav` | alert | 91832 | 956 | -18 | -4.75 | -4.64 | 0.3 | `aa4e9c475a36c9b8` |
| `cyber/friendRequest.wav` | alert | 93530 | 974 | -18 | -3.27 | -3.27 | 0.4 | `d9c4cf2e25734b8e` |
| `cyber/friendAccepted.wav` | standard | 92412 | 962 | -20 | -6.02 | -5.96 | 0.3 | `8c5855a9293895d3` |
| `cyber/voiceJoin.wav` | standard | 81264 | 846 | -20 | -3.87 | -3.78 | 0.3 | `be57efcb4a20e5e1` |
| `cyber/voiceLeave.wav` | standard | 73870 | 769 | -20 | -3.89 | -3.64 | 0.3 | `fffa749e78bd0e84` |
| `cyber/connect.wav` | standard | 87226 | 908 | -20 | -5.37 | -5.22 | 0.3 | `c8f32d387b0f24ec` |
| `cyber/disconnect.wav` | standard | 89142 | 928 | -20 | -4.83 | -4.73 | 0.3 | `aecb6f1d7accb664` |
| `cyber/voiceDrop.wav` | alert | 104898 | 1092 | -18 | -3.28 | -3.02 | 0.3 | `cbbf130485c3d60f` |
| `cyber/reconnect.wav` | standard | 65142 | 678 | -20 | -4.31 | -4.31 | 0.3 | `881b4c69f271dced` |
| `cyber/streamStart.wav` | standard | 92386 | 962 | -20 | -7.96 | -7.95 | 0.4 | `857c76c7539ded2a` |
| `cyber/streamStop.wav` | standard | 84394 | 879 | -20 | -4.69 | -4.69 | 0.4 | `54c0d31337ce9202` |
| `cyber/streamRemoteStart.wav` | standard | 71252 | 742 | -20 | -6.46 | -6.14 | 0.4 | `ce721dec05e4a0ee` |
| `cyber/streamRemoteStop.wav` | standard | 67206 | 700 | -20.01 | -6.06 | -6.06 | 0.4 | `2936259969004647` |
| `cyber/mute.wav` | control | 35500 | 369 | -25.16 | -5.59 | -5.52 | 0.1 | `dd10689fb400b8d0` |
| `cyber/unmute.wav` | control | 36120 | 376 | -25.16 | -6.34 | -6.28 | 0.1 | `c572eb5bf617c056` |
| `cyber/deafen.wav` | control | 42868 | 446 | -25.06 | -7.52 | -7.42 | 0.1 | `726e4cbde2855426` |
| `cyber/undeafen.wav` | control | 42904 | 446 | -25.08 | -9.28 | -9.23 | 0.1 | `74cd01a32b6906a5` |
| `cyber/pttOn.wav` | control | 32636 | 340 | -25.16 | -7.02 | -6.89 | 0.1 | `7f5542421379c2f9` |
| `cyber/pttOff.wav` | control | 35256 | 367 | -25.16 | -6.63 | -6.5 | 0.1 | `458cdb543cde9b74` |
| `cyber/uploadDone.wav` | standard | 74462 | 775 | -20 | -6 | -5.86 | 0.3 | `1a13c33a9e727fbe` |
| `cyber/uploadFailed.wav` | standard | 79270 | 825 | -20 | -4.03 | -4.02 | 0.3 | `a25514ee963983e7` |
| `cyber/sendFailed.wav` | standard | 71604 | 745 | -20 | -3.81 | -3.56 | 0.3 | `408d43b1017396aa` |
| `cozy/message.wav` | standard | 117330 | 1222 | -20 | -9.92 | -9.9 | 0.3 | `12f45d7936168018` |
| `cozy/mention.wav` | alert | 144516 | 1505 | -18 | -7.91 | -7.89 | 0.4 | `8b81d599c2d7712a` |
| `cozy/directMessage.wav` | alert | 143238 | 1492 | -18 | -8.54 | -8.51 | 0.2 | `6bb66e7277c86734` |
| `cozy/friendRequest.wav` | alert | 135190 | 1408 | -18 | -6.88 | -6.87 | 0.2 | `ea6e66b14f7c17bb` |
| `cozy/friendAccepted.wav` | standard | 133664 | 1392 | -20 | -9.32 | -9.31 | 0.1 | `ab1c22cdf861dfc0` |
| `cozy/voiceJoin.wav` | standard | 116188 | 1210 | -20 | -9.59 | -9.59 | 0.2 | `2c4d4ad64dd07f63` |
| `cozy/voiceLeave.wav` | standard | 117620 | 1225 | -20 | -10.17 | -10.17 | 0.1 | `4913a9c836acde13` |
| `cozy/connect.wav` | standard | 127036 | 1323 | -20 | -9.16 | -9.15 | 0.2 | `be27d4dd688a7f89` |
| `cozy/disconnect.wav` | standard | 131490 | 1369 | -20 | -10.38 | -10.37 | 0.2 | `84fe872975b7c8e6` |
| `cozy/voiceDrop.wav` | alert | 155192 | 1616 | -18 | -8.17 | -8.17 | 0.2 | `33a8a473382af4a6` |
| `cozy/reconnect.wav` | standard | 125188 | 1304 | -20 | -8.66 | -8.66 | 0.3 | `92a61823055b420a` |
| `cozy/streamStart.wav` | standard | 141434 | 1473 | -20 | -10.59 | -10.57 | 23.5 | `922d3c2c81410708` |
| `cozy/streamStop.wav` | standard | 145640 | 1517 | -20 | -9.47 | -9.47 | 11.1 | `d3140aea8df32f4f` |
| `cozy/streamRemoteStart.wav` | standard | 112580 | 1172 | -20 | -10.05 | -10.05 | 0.2 | `49ab3a8f38d2c772` |
| `cozy/streamRemoteStop.wav` | standard | 101770 | 1060 | -20 | -10.24 | -10.24 | 0.1 | `e581341dcf4645d4` |
| `cozy/mute.wav` | control | 59534 | 620 | -25.02 | -6.89 | -6.89 | 0.2 | `ce7d7693c10014d4` |
| `cozy/unmute.wav` | control | 58996 | 614 | -25.02 | -7.41 | -7.41 | 0.1 | `615b7d9e8abf205c` |
| `cozy/deafen.wav` | control | 71898 | 748 | -25.01 | -8.54 | -8.53 | 0.2 | `5b2002472ef3b02e` |
| `cozy/undeafen.wav` | control | 64976 | 676 | -25.01 | -9.89 | -9.89 | 0.2 | `051675de65cf2839` |
| `cozy/pttOn.wav` | control | 47816 | 498 | -25.02 | -9.86 | -9.85 | 0.1 | `0ac93b5299875e53` |
| `cozy/pttOff.wav` | control | 52626 | 548 | -25.02 | -8.53 | -8.52 | 0.1 | `aed29ab7f610d834` |
| `cozy/uploadDone.wav` | standard | 114986 | 1197 | -20 | -10.1 | -10.09 | 0.2 | `d3b99c1c471d24bd` |
| `cozy/uploadFailed.wav` | standard | 122560 | 1276 | -20 | -9.75 | -9.75 | 0.4 | `93e9bc28fb39ee24` |
| `cozy/sendFailed.wav` | standard | 117074 | 1219 | -20 | -10.72 | -10.72 | 0.3 | `6b3c25e8abc557c2` |
| `arcade/message.wav` | standard | 31966 | 333 | -21.01 | -7.29 | -7.28 | 0.2 | `60b6e0dc3ab5aae4` |
| `arcade/mention.wav` | alert | 39050 | 406 | -19 | -6.95 | -6.95 | 0.2 | `9c576b748f54f655` |
| `arcade/directMessage.wav` | alert | 35076 | 365 | -19.01 | -6.03 | -6.03 | 0.2 | `c69bc4ac0e73368f` |
| `arcade/friendRequest.wav` | alert | 43738 | 455 | -19 | -6.1 | -6.05 | 0.2 | `4cce8bac615578b6` |
| `arcade/friendAccepted.wav` | standard | 37012 | 385 | -21.02 | -6.98 | -6.98 | 0.1 | `e6c332b0e8f8dba0` |
| `arcade/voiceJoin.wav` | standard | 34374 | 358 | -21.01 | -6.77 | -6.77 | 0.2 | `414b3c811575ba1f` |
| `arcade/voiceLeave.wav` | standard | 34316 | 357 | -21.01 | -6.83 | -6.82 | 0.2 | `70ac4973373fb62b` |
| `arcade/connect.wav` | standard | 38322 | 399 | -21.01 | -6.92 | -6.85 | 0.2 | `6ce98f60724528cc` |
| `arcade/disconnect.wav` | standard | 39636 | 412 | -21.01 | -7.19 | -7.19 | 0.2 | `b9a9c6300afef51b` |
| `arcade/voiceDrop.wav` | alert | 43732 | 455 | -19.01 | -6.36 | -6.35 | 0.2 | `09ef8ef804bdc0c2` |
| `arcade/reconnect.wav` | standard | 32316 | 336 | -21.01 | -6.66 | -6.66 | 0.2 | `5fadee6529af2794` |
| `arcade/streamStart.wav` | standard | 47702 | 496 | -21 | -8.52 | -8.52 | 0.2 | `6f6df0462b383cc7` |
| `arcade/streamStop.wav` | standard | 39712 | 413 | -21.01 | -7.4 | -7.4 | 0.2 | `e15d17a88d6eac8e` |
| `arcade/streamRemoteStart.wav` | standard | 32956 | 343 | -21.01 | -7.94 | -7.93 | 0.2 | `3e1e5f3a2e722108` |
| `arcade/streamRemoteStop.wav` | standard | 32906 | 342 | -21.02 | -8.1 | -8.08 | 0.2 | `003498a28a256858` |
| `arcade/mute.wav` | control | 6288 | 65 | -26.12 | -10.12 | -10.08 | 0.1 | `fcf24283e7a0cc82` |
| `arcade/unmute.wav` | control | 6286 | 65 | -26.11 | -11.37 | -11.35 | 0.1 | `6b8f58a88b1cfb9d` |
| `arcade/deafen.wav` | control | 13492 | 140 | -26.06 | -12.26 | -12.26 | 0.1 | `f8e3e153e0900ee3` |
| `arcade/undeafen.wav` | control | 13486 | 140 | -26.05 | -14.35 | -14.26 | 0.1 | `6364ab4baf73d79f` |
| `arcade/pttOn.wav` | control | 6286 | 65 | -26.12 | -12.64 | -12.6 | 0.1 | `8bb2dc9a78e7781f` |
| `arcade/pttOff.wav` | control | 6392 | 66 | -26.12 | -11.64 | -11.6 | 0.1 | `c68e9323672bc4f4` |
| `arcade/uploadDone.wav` | standard | 32966 | 343 | -21.01 | -7.78 | -7.75 | 0.2 | `0f5e8d6ba0b5270f` |
| `arcade/uploadFailed.wav` | standard | 36274 | 377 | -21.01 | -7.65 | -7.59 | 0.1 | `778bdf6086804edc` |
| `arcade/sendFailed.wav` | standard | 34928 | 363 | -21.01 | -6.95 | -6.92 | 0.1 | `927312c768216197` |
