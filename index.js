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
	minContrast: 4.5, // WCAG AA for body text; 0 disables the readability pass
	minSpread: 0.02, // below this luminance range the frame is treated as flat
	prefix: '--',
	target: null, // resolved to document.documentElement at init time
	video: null, // optional HTMLVideoElement; one is created if absent
	canvas: null, // optional HTMLCanvasElement; one is created if absent
	facingMode: 'environment', // 'environment' (world) or 'user' (selfie)
	deviceId: null, // explicit device wins over facingMode when set
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

// Inverse of rgbToHsl; h in degrees, s/l in 0..1, returns 0..255 channels.
const hslToRgb = (h, s, l) => {
	if (s === 0) {
		const v = Math.round(l * 255);
		return [v, v, v];
	}
	const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
	const p = 2 * l - q;
	const hk = ((h % 360) + 360) % 360 / 360;
	const channel = (t) => {
		let tc = t;
		if (tc < 0) tc += 1;
		if (tc > 1) tc -= 1;
		if (tc < 1 / 6) return p + (q - p) * 6 * tc;
		if (tc < 1 / 2) return q;
		if (tc < 2 / 3) return p + (q - p) * (2 / 3 - tc) * 6;
		return p;
	};
	return [
		Math.round(channel(hk + 1 / 3) * 255),
		Math.round(channel(hk) * 255),
		Math.round(channel(hk - 1 / 3) * 255),
	];
};

// Rec. 709 relative luminance on linearised RGB (0..1).
const relativeLuminance = (r, g, b) => {
	const lin = (c) => {
		const cs = c / 255;
		return cs <= 0.03928 ? cs / 12.92 : ((cs + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};

// WCAG 2.x contrast ratio, 1..21, from two relative luminances.
const contrastRatio = (l1, l2) => {
	const hi = Math.max(l1, l2);
	const lo = Math.min(l1, l2);
	return (hi + 0.05) / (lo + 0.05);
};

// Push a colour's lightness away from a reference until it clears `ratio`.
// Hue and saturation are preserved, so the result still belongs to the scene.
const forceContrast = (colour, againstLuminance, ratio) => {
	if (contrastRatio(colour.luminance, againstLuminance) >= ratio) return colour;

	// Choose the direction that can actually reach the target, not the one the
	// colour happens to start on: against a dark background, darkening a
	// slightly-darker foreground bottoms out at black and still fails.
	const canLighten = contrastRatio(1, againstLuminance) >= ratio;
	const canDarken = contrastRatio(0, againstLuminance) >= ratio;
	// When both work, go the way the colour already leans; when neither does
	// (mid-grey backgrounds cap at ~5.3:1 either way) take the better of the
	// two extremes so we still return the most legible colour available.
	let darken;
	if (canLighten && canDarken) darken = colour.luminance <= againstLuminance;
	else if (canLighten) darken = false;
	else if (canDarken) darken = true;
	else darken = contrastRatio(0, againstLuminance) > contrastRatio(1, againstLuminance);

	// Search the full lightness range, not just beyond the colour's current
	// lightness, so a foreground on the wrong side can cross over.
	let lo = 0;
	let hi = 1;
	let best = darken ? 0 : 1;

	// 12 bisections lands within ~0.02% lightness; cheap at 1-2 Hz.
	// Invariant: `best` is the most conservative lightness found that passes.
	for (let i = 0; i < 12; i += 1) {
		const mid = (lo + hi) / 2;
		const [r, g, b] = hslToRgb(colour.h, colour.s, mid);
		const lum = relativeLuminance(r, g, b);
		if (contrastRatio(lum, againstLuminance) >= ratio) {
			best = mid;
			// Passing: pull back toward the background for a subtler result.
			if (darken) lo = mid; else hi = mid;
		} else if (darken) hi = mid; else lo = mid;
	}

	const [r, g, b] = hslToRgb(colour.h, colour.s, best);
	return {
		...colour,
		r,
		g,
		b,
		l: best,
		luminance: relativeLuminance(r, g, b),
		css: hslToCss(colour.h, colour.s, best),
		adjusted: true,
	};
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

// Order by hue, then lightness; greys (no meaningful hue) sort to the front so
// the coloured run reads as a spectrum rather than being interrupted by them.
const byHue = (colours) => [...colours].sort((a, z) => {
	const ga = a.s < 0.1;
	const gz = z.s < 0.1;
	if (ga !== gz) return ga ? -1 : 1;
	if (ga && gz) return a.l - z.l;
	return a.h - z.h || a.l - z.l;
});

const splitByLuminance = (palette, opts) => {
	// A capped lens or a blown-out frame collapses to one narrow luminance
	// band; splitting it yields bg and fg that are nearly identical. Detect
	// that here so applyPalette can widen the pair rather than emit mush.
	const lums = palette.map((c) => c.luminance);
	const spread = palette.length
		? Math.max(...lums) - Math.min(...lums)
		: 0;
	const flat = spread < opts.minSpread;

	const lows = palette.filter((c) => c.luminance < opts.lumSplit).slice(0, opts.paletteSize);
	const highs = palette.filter((c) => c.luminance >= opts.lumSplit).slice(0, opts.paletteSize);

	// Fallbacks for monochrome / uniformly lit scenes.
	if (lows.length === 0 && palette.length) {
		lows.push([...palette].sort((a, z) => a.luminance - z.luminance)[0]);
	}
	if (highs.length === 0 && palette.length) {
		highs.push([...palette].sort((a, z) => z.luminance - a.luminance)[0]);
	}
	return { lows, highs, spread, flat };
};

// Resolve the three headline roles, guaranteeing --fg and --accent are legible
// on --bg. Returns the colours actually written so callers can display them.
const resolveRoles = ({ lows, highs }, opts) => {
	const bg = lows[0] || highs[0];
	let fg = highs[0] || lows[0];
	let accent = highs[1] || lows[1] || fg;
	if (!bg || !fg) return { bg, fg, accent };

	if (opts.minContrast > 0) {
		// Prefer a real colour from the scene that already passes; only
		// synthesise a lightness when nothing sampled is good enough.
		const candidates = [...highs, ...lows];
		const passing = candidates.find(
			(c) => contrastRatio(c.luminance, bg.luminance) >= opts.minContrast,
		);
		fg = passing || forceContrast(fg, bg.luminance, opts.minContrast);

		const accentPassing = candidates.find(
			(c) => c !== fg
				&& contrastRatio(c.luminance, bg.luminance) >= opts.minContrast,
		);
		accent = accentPassing
			|| forceContrast(accent, bg.luminance, opts.minContrast);
	}
	return { bg, fg, accent };
};

const applyPalette = (target, groups, opts) => {
	const { lows, highs } = groups;
	const p = opts.prefix;
	const pick = (arr, i) => arr[i] || arr[arr.length - 1];

	for (let i = 0; i < opts.paletteSize; i += 1) {
		const lo = pick(lows, i);
		const hi = pick(highs, i);
		if (lo) target.style.setProperty(`${p}bg-${i + 1}`, lo.css);
		if (hi) target.style.setProperty(`${p}fg-${i + 1}`, hi.css);
	}

	const { bg, fg, accent } = resolveRoles(groups, opts);
	if (bg) target.style.setProperty(`${p}bg`, bg.css);
	if (fg) target.style.setProperty(`${p}fg`, fg.css);
	if (accent) target.style.setProperty(`${p}accent`, accent.css);
	return { bg, fg, accent };
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
	let frozen = false;
	let resumeOnVisible = false;
	let lastRoles = null;

	// Merge facingMode / deviceId into whatever video constraints were given,
	// without clobbering a caller's width/height.
	const buildConstraints = () => {
		const base = opts.constraints || {};
		const video = typeof base.video === 'object' && base.video !== null
			? { ...base.video }
			: {};
		if (opts.deviceId) {
			video.deviceId = { exact: opts.deviceId };
			delete video.facingMode;
		} else if (opts.facingMode) {
			// Not `exact`: desktops have no environment camera and would throw
			// OverconstrainedError rather than falling back to the only cam.
			video.facingMode = opts.facingMode;
			delete video.deviceId;
		}
		return { ...base, video };
	};

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
		if (frozen) return;
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
		const roles = applyPalette(opts.target, groups, opts);
		lastRoles = roles;
		const detail = { palette, groups, roles };
		if (typeof opts.onPalette === 'function') opts.onPalette(palette, groups, roles);
		document.dispatchEvent(new CustomEvent('cssadapt:palette', { detail }));
	};

	const start = async () => {
		if (running) return handle;
		if (!navigator.mediaDevices?.getUserMedia) {
			throw new Error('cssadapt: getUserMedia is not available (needs HTTPS or localhost).');
		}
		stream = await navigator.mediaDevices.getUserMedia(buildConstraints());
		// Record what we actually got: the browser may ignore facingMode on a
		// device that has only one camera, and the UI should reflect reality.
		const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
		if (settings.facingMode) opts.facingMode = settings.facingMode;
		if (settings.deviceId) opts.deviceId = settings.deviceId;
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

	// Switching cameras means tearing the stream down and asking again; the
	// timer keeps running so the palette simply resumes on the new feed.
	const useCamera = async ({ facingMode, deviceId } = {}) => {
		if (deviceId) {
			opts.deviceId = deviceId;
		} else if (facingMode) {
			opts.facingMode = facingMode;
			opts.deviceId = null;
		}
		if (!running) return handle;
		if (stream) stream.getTracks().forEach((t) => t.stop());
		stream = await navigator.mediaDevices.getUserMedia(buildConstraints());
		const settings = stream.getVideoTracks()[0]?.getSettings?.() || {};
		if (settings.facingMode) opts.facingMode = settings.facingMode;
		if (settings.deviceId) opts.deviceId = settings.deviceId;
		video.srcObject = stream;
		await video.play().catch(() => { /* autoplay blocks are tolerated */ });
		document.dispatchEvent(
			new CustomEvent('cssadapt:camera', { detail: { facingMode: opts.facingMode } }),
		);
		return handle;
	};

	const listCameras = async () => {
		if (!navigator.mediaDevices?.enumerateDevices) return [];
		const devices = await navigator.mediaDevices.enumerateDevices();
		return devices.filter((d) => d.kind === 'videoinput');
	};

	// Release the camera when the tab is hidden; resume only if we stopped it.
	const onVisibility = () => {
		if (document.hidden) {
			if (running) {
				resumeOnVisible = true;
				stop();
			}
		} else if (resumeOnVisible) {
			resumeOnVisible = false;
			start().catch((err) => {
				document.dispatchEvent(new CustomEvent('cssadapt:error', { detail: err }));
			});
		}
	};
	document.addEventListener('visibilitychange', onVisibility);

	const handle = {
		start,
		stop,
		tick,
		useCamera,
		listCameras,
		switchCamera: () => useCamera({
			facingMode: opts.facingMode === 'environment' ? 'user' : 'environment',
		}),
		freeze: () => {
			frozen = true;
			document.dispatchEvent(new CustomEvent('cssadapt:freeze'));
			return handle;
		},
		thaw: () => {
			frozen = false;
			document.dispatchEvent(new CustomEvent('cssadapt:thaw'));
			return handle;
		},
		get frozen() { return frozen; },
		get facingMode() { return opts.facingMode; },
		get roles() { return lastRoles; },
		// Serialise the live variables so a palette can be lifted out of the
		// page and pasted straight into a stylesheet.
		toCss: () => {
			const p = opts.prefix;
			const names = [`${p}bg`, `${p}fg`, `${p}accent`];
			for (let i = 1; i <= opts.paletteSize; i += 1) {
				names.push(`${p}bg-${i}`, `${p}fg-${i}`);
			}
			const lines = names
				.map((n) => [n, opts.target.style.getPropertyValue(n).trim()])
				.filter(([, v]) => v)
				.map(([n, v]) => `\t${n}: ${v};`);
			return `:root {\n${lines.join('\n')}\n}`;
		},
		destroy: () => {
			stop();
			document.removeEventListener('visibilitychange', onVisibility);
			return handle;
		},
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
	resolveRoles,
	byHue,
	rgbToHsl,
	hslToRgb,
	hslToCss,
	relativeLuminance,
	contrastRatio,
	forceContrast,
	DEFAULTS,
};

export default { init };
