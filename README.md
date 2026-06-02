# cssadapt

Recolour any web page in real time from the dominant colours your camera
sees. Frames are analysed in the browser; the most common colours are split
into low- and high-luminosity groups and written to CSS custom properties on
`:root` so the rest of your stylesheet can react.

Inspired by [viddybg](https://github.com/ear1grey/viddybg), but instead of
showing the video, the page is *retinted* by what the camera sees.

**Camera frames never leave the browser.** No network calls, no analytics,
no third-party scripts.

## Try the demo

```sh
git clone https://github.com/ear1grey/cssadapt.git
cd cssadapt
python3 -m http.server 8080      # or: npx http-server . -p 8080
```

Open <http://localhost:8080> and click **Start camera**.
`getUserMedia` only works on `https://` or `http://localhost`.

## Use it on your own page

### Drop-in script (auto-start)

The simplest possible integration — pinned to a tag for safety:

```html
<script
	type="module"
	src="https://cdn.jsdelivr.net/gh/ear1grey/cssadapt@v1.0.0/index.js"
	data-cssadapt-autostart
></script>
```

The browser will prompt for camera access on first load. Only do this on
pages where the camera prompt is expected, otherwise use the gesture-driven
form below.

### Module import (start on user gesture — recommended)

```html
<button id="theme-from-camera">Theme from camera</button>
<script type="module">
	import { init } from 'https://cdn.jsdelivr.net/gh/ear1grey/cssadapt@v1.0.0/index.js';

	const cssadapt = await init();
	document
		.getElementById('theme-from-camera')
		.addEventListener('click', () => cssadapt.start());
</script>
```

With a bundler:

```js
import { init } from 'cssadapt';
const handle = await init({ intervalMs: 1000 });
await handle.start();
```

### CSS variables it sets on `:root`

| Variable | Source |
| --- | --- |
| `--bg`, `--bg-1` &hellip; `--bg-4` | dominant **low** luminosity colours |
| `--fg`, `--fg-1` &hellip; `--fg-4` | dominant **high** luminosity colours |
| `--accent` | the second-most common high luminosity colour |
| `--transition-time` | the current sample period (e.g. `1.000s`) |

Then use them as normal:

```css
body { background: var(--bg); color: var(--fg); }
a    { color: var(--accent); }
```

Luminosity is the Rec. 709 relative-luminance formula on linearised RGB.
The default split point is 0.5.

## Options

`init(options)` accepts:

| Option | Default | Notes |
| --- | --- | --- |
| `autoStart` | `false` | Call `getUserMedia` immediately. Prefer a user gesture. |
| `sampleRateHz` | `2` | Samples per second. Converted to an interval at start. |
| `intervalMs` | `null` | Explicit interval in milliseconds; overrides `sampleRateHz` when set. |
| `sampleSize` | `64` | Down-sampled frame edge, in pixels, for speed. |
| `hueBuckets` / `satBuckets` / `lumBuckets` | `12` / `3` / `4` | Quantisation grid. |
| `paletteSize` | `4` | How many `--bg-N` / `--fg-N` slots to fill. |
| `lumSplit` | `0.5` | Boundary between low and high luminosity. |
| `prefix` | `'--'` | Custom-property prefix, e.g. `'--theme-'`. |
| `target` | `document.documentElement` | Element to set variables on. |
| `video` / `canvas` | hidden, auto-created | Bring your own elements (e.g. to show a preview). |
| `constraints` | `{ audio: false, video: { width: 640, height: 360 } }` | Passed to `getUserMedia`. |
| `onPalette` | `null` | `(palette, { lows, highs }) => void` callback after each frame. |

The returned handle exposes `start()`, `stop()`, `tick()`,
`setSampleRate(hz)`, `setInterval(ms)`, `running`, plus the `video` and
`canvas` elements actually in use. `setSampleRate` / `setInterval` restart
the internal timer immediately, so you can tie them to a slider.

The library also fires DOM events you can listen for on `document`:

- `cssadapt:start`
- `cssadapt:stop`
- `cssadapt:palette` &mdash; `event.detail = { palette, groups }`
- `cssadapt:error` &mdash; `event.detail = Error`

## Requirements & gotchas

- **HTTPS or localhost.** Browsers will not expose the camera otherwise.
- **Embedding in an iframe?** The parent page must allow it:
  `<iframe src="..." allow="camera"></iframe>`.
- **User gesture.** Browsers strongly prefer permission prompts to be
  triggered by a click. Use `data-cssadapt-autostart` only when that's the
  whole point of the page.
- **Permissions Policy.** If your site sends a `Permissions-Policy` header,
  ensure `camera=(self)` (or include the embedder's origin) is allowed.
- **Stop when hidden.** Listen for `document.visibilitychange` and call
  `handle.stop()` to release the camera when the tab is hidden.

## License

[MIT](LICENSE) © 2026 Rich Boakes
