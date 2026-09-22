// Simulates the mobile lifecycle that broke the build: start, hide tab
// (stream torn down), return, resume. Mobile browsers invalidate deviceIds
// across a teardown, so an `exact` deviceId constraint fails on resume.

let generation = 0;
const camerasFor = (gen) => [
  { deviceId: `back-${gen}`, label: 'Back Camera', facingMode: 'environment' },
  { deviceId: `front-${gen}`, label: 'Front Camera', facingMode: 'user' },
];

// iOS Safari omits facingMode from getSettings(); Android Chrome includes it.
const makeDevice = ({ reportsFacingMode }) => ({
  getUserMedia(constraints) {
    const v = constraints.video || {};
    const cams = camerasFor(generation);
    let pick = null;

    if (v.deviceId?.exact) {
      pick = cams.find((c) => c.deviceId === v.deviceId.exact);
      if (!pick) {
        const e = new Error('Requested device not found');
        e.name = 'OverconstrainedError';
        throw e;
      }
    } else {
      if (v.deviceId?.ideal) pick = cams.find((c) => c.deviceId === v.deviceId.ideal);
      if (!pick && v.facingMode) pick = cams.find((c) => c.facingMode === v.facingMode);
      if (!pick) pick = cams[0];
    }

    return {
      getVideoTracks: () => [{
        label: pick.label,
        getSettings: () => (reportsFacingMode
          ? { deviceId: pick.deviceId, facingMode: pick.facingMode }
          : { deviceId: pick.deviceId }),
        stop() { generation += 1; }, // teardown invalidates ids
      }],
      getTracks() { return this.getVideoTracks(); },
    };
  },
});

// --- the two buildConstraints implementations -------------------------------
const OLD = (opts) => {
  const video = {};
  if (opts.deviceId) { video.deviceId = { exact: opts.deviceId }; }
  else if (opts.facingMode) { video.facingMode = opts.facingMode; }
  return { video };
};

const NEW = (opts) => {
  const video = {};
  if (opts.deviceId) {
    video.deviceId = { ideal: opts.deviceId };
    if (opts.facingMode) video.facingMode = opts.facingMode;
  } else if (opts.facingMode) {
    video.facingMode = opts.facingMode;
  }
  return { video };
};

// OLD latched resolved deviceId into opts; NEW keeps it separate.
const run = ({ build, latchDeviceId, reportsFacingMode }) => {
  generation = 0;
  const dev = makeDevice({ reportsFacingMode });
  const opts = { facingMode: 'environment', deviceId: null };
  let active = null, stream = null;

  const record = () => {
    const t = stream.getVideoTracks()[0];
    const s = t.getSettings();
    active = s.deviceId;
    if (latchDeviceId && s.deviceId) opts.deviceId = s.deviceId;
    if (s.facingMode) opts.facingMode = s.facingMode;
    else if (t.label) {
      const l = t.label.toLowerCase();
      if (/\bback\b|\brear\b/.test(l)) opts.facingMode = 'environment';
      else if (/\bfront\b/.test(l)) opts.facingMode = 'user';
    }
  };

  const start = () => { stream = dev.getUserMedia(build(opts)); record(); };
  const stop = () => { stream.getTracks().forEach((t) => t.stop()); stream = null; };

  start();
  const first = opts.facingMode;
  for (let i = 0; i < 3; i += 1) { stop(); start(); } // hide/return cycles
  return { facing: opts.facingMode, first, active };
};

const scenarios = [
  ['iOS Safari  (no facingMode in getSettings)', false],
  ['Android Chrome (facingMode reported)', true],
];

let failures = 0;
for (const [name, reportsFacingMode] of scenarios) {
  for (const [label, cfg] of [
    ['OLD', { build: OLD, latchDeviceId: true }],
    ['NEW', { build: NEW, latchDeviceId: false }],
  ]) {
    let result;
    try {
      const r = run({ ...cfg, reportsFacingMode });
      const ok = r.facing === 'environment';
      result = ok ? `ok  (facing=${r.facing})` : `WRONG CAMERA (facing=${r.facing})`;
      if (!ok && label === 'NEW') failures += 1;
    } catch (e) {
      result = `THREW ${e.name}`;
      if (label === 'NEW') failures += 1;
    }
    console.log(`${name.padEnd(44)} ${label}: ${result}`);
  }
}

console.log(failures === 0 ? '\nPASS: new logic survives resume' : `\nFAIL: ${failures}`);
process.exit(failures === 0 ? 0 : 1);
