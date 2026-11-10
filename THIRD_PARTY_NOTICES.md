# Third-party notices

Greenroom is MIT-licensed (see `LICENSE`). Some small pieces below come from other projects under their own licences, and the platform marks drawn in the
nameplate are their owners' trademarks. This file carries the notices those licences ask for. The packages in `package.json` and `sidecar/package.json` are
installed from npm with their own licences; their notices travel with them in `node_modules`.

## Boxicons 2.1.4: the TikTok and Twitch glyphs (MIT)

`overlay/nameplate-shared.js` contains the TikTok glyph (byte-identical to Boxicons' `bxl-tiktok`) and a Twitch glyph derived from the Boxicons one.

```
MIT License

Copyright (c) 2015-2021 Aniket Suvarna

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Google Material Icons: the Discord glyph (Apache License 2.0)

`overlay/nameplate-shared.js` contains the Discord glyph of Google's Material Icons set (<https://github.com/google/material-design-icons>), which is
licensed under the Apache License, Version 2.0. The outline is the one the Iconify distribution of that set publishes as `ic:baseline-discord` (checked
against it; the coordinates here are written to a different precision). It is not the glyph of the Pictogrammers "Material Design Icons" set
(`mdi:discord`), which is a different drawing. The upstream copyright line was not confirmed. The licence text is at
<https://www.apache.org/licenses/LICENSE-2.0.txt>, and its standard notice reads:

```
Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

## Other glyphs and marks

The X, Bluesky, YouTube and Instagram glyphs in `overlay/nameplate-shared.js` are marked "source unconfirmed" in the comment above `const ICONS`; they are
simplified drawings of those services' marks, used only to show which service a handle is on. Twitch, Discord, TikTok, X, Bluesky, YouTube and Instagram
are trademarks of their respective owners. Greenroom is not affiliated with, sponsored by or endorsed by any of them, nor by Streamer.bot or VDO.ninja.
The mute and deafen badges in the Discord roster and the globe for a plain website link are original to this kit.
