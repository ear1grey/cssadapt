/**
 * cssadapt — recolour a page from what the camera sees.
 *
 * Frames are grabbed from the user's camera, dominant colours are extracted
 * and split into low- / high-luminosity groups, and the result is written to
 * CSS custom properties on a target element (defaults to :root).
 *
 * Usage (module):
 *   import { init } from 'cssadapt';
 *   const handle = await init({ autoStart: false });
 *   document.querySelector('button').addEventListener('click', handle.start);
 *
 * Usage (script tag, opt-in auto-start):
 *   <script type="module"
 *           src="https://cdn.jsdelivr.net/gh/ear1grey/cssadapt@v1.0.0/index.js"
 *           data-cssadapt-autostart></script>
 *
 * Camera frames never leave the browser.
 */

const DEFAULTS = {
	sampleRateHz: 2, // samples per second; converted to intervalMs at start()
	intervalMs: null, // explicit interval overrides sampleRateHz if set
	sampleSize: 64,
	hueBuckets: 12,
	satBuckets: 3,
	lumBuckets: 4,
	paletteSize: 4,
	lumSplit: 0.5,
	prefix: '--',
	target: null, // resolved to document.documentElement at init time
	video: null, // optional HTMLVideoElement; one is created if absent
	canvas: null, // optional HTMLCanvasElement; one is created if absent
	constraints: { audio: false, video: { width: 640, height: 360 } },
	autoStart: false,
	onPalette: null, // (palette, groups) => void
};

// --- Colour maths --------------------------------------------------------

const rgbToHsl = (r, g, b) => {
	const rn = r / 255;
	const gn = g / 255;
	const bn = b / 255;
	const max = Math.max(rn, gn, bn);
	const min = Math.min(rn, gn, bn);
	const l = (max + min) / 2;
	let h = 0;
	let s = 0;
	if (max !== min) {
		const d = max - min;
		s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
		switch (max) {
			case rn: h = (gn - bn) / d + (gn < bn ? 6 : 0); break;
			case gn: h = (bn - rn) / d + 2; break;
			default: h = (rn - gn) / d + 4; break;
		}
		h *= 60;
	}
	return [h, s, l];
};

const hslToCss = (h, s, l) =>
	`hsl(${h.toFixed(0)} ${(s * 100).toFixed(0)}% ${(l * 100).toFixed(0)}%)`;

// Rec. 709 relative luminance on linearised RGB (0..1).
const relativeLuminance = (r, g, b) => {
	const lin = (c) => {
		const cs = c / 255;
		return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

// --- Frame analysis ------------------------------------------------------

const analyseImageData = (data, opts) => {
	const bins = new Map();
	for (let i = 0; i < data.length; i += 4) {
		const r = data[i];
		const g = data[i + 1];
		const b = data[i + 2];
		if (data[i + 3] < 128) continue;
		const [h, s, l] = rgbToHsl(r, g, b);
		const hb = Math.floor((h / 360) * opts.hueBuckets) % opts.hueBuckets;
		const sb = Math.min(opts.satBuckets - 1, Math.floor(s * opts.satBuckets));
		const lb = Math.min(opts.lumBuckets - 1, Math.floor(l * opts.lumBuckets));
		const key = `${hb}|${sb}|${lb}`;
		const entry = bins.get(key);
		if (entry) {
			entry.count += 1;
			entry.r += r;
			entry.g += g;
			entry.b += b;
		} else {
			bins.set(key, { count: 1, r, g, b });
		}
	}

	const palette = [];
	bins.forEach((entry) => {
		const r = entry.r / entry.count;
		const g = entry.g / entry.count;
		const b = entry.b / entry.count;
		const [h, s, l] = rgbToHsl(r, g, b);
		palette.push({
			count: entry.count,
			r,
			g,
			b,
			h,
			s,
			l,
			luminance: relativeLuminance(r, g, b),
			css: hslToCss(h, s, l),
		});
	});
	palette.sort((a, z) => z.count - a.count);
	return palette;
};

const splitByLuminance = (palette, opts) => {
	const lows = palette.filter((c) => c.luminance < opts.lumSplit).slice(0, opts.paletteSize);
	const highs = palette.filter((c) => c.luminance >= opts.lumSplit).slice(0, opts.paletteSize);

	// Fallbacks for monochrome / uniformly lit scenes.
	if (lows.length === 0 && palette.length) {
		lows.push([...palette].sort((a, z) => a.luminance - z.luminance)[0]);
	}
	if (highs.length === 0 && palette.length) {
		highs.push([...palette].sort((a, z) => z.luminance - a.luminance)[0]);
	}
	return { lows, highs };
};

const applyPalette = (target, { lows, highs }, opts) => {
	const p = opts.prefix;
	const pick = (arr, i) => arr[i] || arr[arr.length - 1];

	for (let i = 0; i < opts.paletteSize; i += 1) {
		const lo = pick(lows, i);
		const hi = pick(highs, i);
		if (lo) target.style.setProperty(`${p}bg-${i + 1}`, lo.css);
		if (hi) target.style.setProperty(`${p}fg-${i + 1}`, hi.css);
	}
	const bg = lows[0] || highs[0];
	const fg = highs[0] || lows[0];
	const accent = highs[1] || lows[1] || fg;
	if (bg) target.style.setProperty(`${p}bg`, bg.css);
	if (fg) target.style.setProperty(`${p}fg`, fg.css);
	if (accent) target.style.setProperty(`${p}accent`, accent.css);
};

// --- DOM plumbing --------------------------------------------------------

const createHiddenVideo = () => {
	const v = document.createElement('video');
	v.autoplay = true;
	v.muted = true;
	v.playsInline = true;
	v.setAttribute('aria-hidden', 'true');
	v.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px;';
	document.body.append(v);
	return v;
};

const createHiddenCanvas = () => {
	const c = document.createElement('canvas');
	c.setAttribute('aria-hidden', 'true');
	c.style.cssText = 'position:fixed;left:-9999px;width:1px;height:1px;';
	document.body.append(c);
	return c;
};

// --- Public API ----------------------------------------------------------

const init = async (userOptions = {}) => {
	const opts = { ...DEFAULTS, ...userOptions };
	opts.target = opts.target || document.documentElement;

	const video = opts.video || createHiddenVideo();
	const canvas = opts.canvas || createHiddenCanvas();
	const ctx = canvas.getContext('2d', { willReadFrequently: true });

	let stream = null;
	let timerId = null;
	let running = false;

	const effectiveIntervalMs = () => (opts.intervalMs != null
		? opts.intervalMs
		: Math.max(1, Math.round(1000 / opts.sampleRateHz)));

	const publishTiming = () => {
		const ms = effectiveIntervalMs();
		opts.target.style.setProperty(`${opts.prefix}transition-time`, `${(ms / 1000).toFixed(3)}s`);
	};

	const restartTimer = () => {
		if (timerId) clearInterval(timerId);
		timerId = running ? setInterval(tick, effectiveIntervalMs()) : null;
		publishTiming();
	};

	const tick = () => {
		if (video.readyState < 2) return;
		const vw = video.videoWidth || opts.sampleSize;
		const vh = video.videoHeight || opts.sampleSize;
		const scale = opts.sampleSize / Math.max(vw, vh);
		canvas.width = Math.max(1, Math.round(vw * scale));
		canvas.height = Math.max(1, Math.round(vh * scale));
		ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
		const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
		const palette = analyseImageData(data, opts);
		if (!palette.length) return;
		const groups = splitByLuminance(palette, opts);
		applyPalette(opts.target, groups, opts);
		if (typeof opts.onPalette === 'function') opts.onPalette(palette, groups);
		document.dispatchEvent(
			new CustomEvent('cssadapt:palette', { detail: { palette, groups } }),
		);
	};

	const start = async () => {
		if (running) return handle;
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('cssadapt: getUserMedia is not available (needs HTTPS or localhost).');
		}
		stream = await navigator.mediaDevices.getUserMedia(opts.constraints);
		video.srcObject = stream;
		await new Promise((resolve) => {
			if (video.readyState >= 1) resolve();
			else video.addEventListener('loadedmetadata', resolve, { once: true });
		});
		await video.play().catch(() => { /* autoplay blocks are tolerated */ });
		running = true;
		tick();
		timerId = setInterval(tick, effectiveIntervalMs());
		publishTiming();
		document.dispatchEvent(new CustomEvent('cssadapt:start'));
		return handle;
	};

	const stop = () => {
		running = false;
		if (timerId) clearInterval(timerId);
		timerId = null;
		if (stream) stream.getTracks().forEach((t) => t.stop());
		stream = null;
		document.dispatchEvent(new CustomEvent('cssadapt:stop'));
		return handle;
	};

	const handle = {
		start,
		stop,
		tick,
		setSampleRate: (hz) => {
			opts.sampleRateHz = hz;
			opts.intervalMs = null;
			restartTimer();
			return handle;
		},
		setInterval: (ms) => {
			opts.intervalMs = ms;
			restartTimer();
			return handle;
		},
		get running() { return running; },
		get video() { return video; },
		get canvas() { return canvas; },
		options: opts,
	};

	if (opts.autoStart) {
		try {
			await start();
		} catch (err) {
			document.dispatchEvent(new CustomEvent('cssadapt:error', { detail: err }));
		}
	} else {
		publishTiming();
	}

	return handle;
};

// Auto-attach when included via <script data-cssadapt-autostart>.
const bootFromScriptTag = () => {
	if (typeof document === 'undefined') return;
	const script = document.currentScript
		|| document.querySelector('script[data-cssadapt-autostart]');
	if (!script || !script.hasAttribute('data-cssadapt-autostart')) return;
	const run = () => init({ autoStart: true }).then((h) => {
		if (typeof window !== 'undefined') window.cssadapt = h;
	});
	if (document.readyState === 'loading') {
		window.addEventListener('DOMContentLoaded', run, { once: true });
	} else {
		run();
	}
};

bootFromScriptTag();

if (typeof window !== 'undefined') {
	window.cssadapt = window.cssadapt || { init };
}

export {
	init,
	analyseImageData,
	splitByLuminance,
	applyPalette,
	rgbToHsl,
	hslToCss,
	relativeLuminance,
	DEFAULTS,
};

export default { init };
