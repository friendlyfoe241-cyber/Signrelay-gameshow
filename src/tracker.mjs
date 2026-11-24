import { FilesetResolver, HandLandmarker, PoseLandmarker } from '@mediapipe/tasks-vision';
import { gatherFrame } from './upstream-preprocess.mjs';

let hand, pose, canvas, context, prevPose, sequence = 0, lastTimestamp = 0;
const asset = path => new URL(path, self.location.href).href;

async function verified(path, expected) {
  const response = await fetch(asset(path));
  if (!response.ok) throw new Error('Missing ' + path + ' (' + response.status + ')');
  const bytes = await response.arrayBuffer();
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  const sha = Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
  if (sha !== expected) throw new Error('Fingerprint mismatch for ' + path);
  return new Uint8Array(bytes);
}
async function start(files, handTask, poseTask, delegate) {
  const options = buffer => ({ baseOptions: { modelAssetBuffer: buffer, delegate }, runningMode: 'VIDEO' });
  const results = await Promise.allSettled([
    HandLandmarker.createFromOptions(files, { ...options(handTask), numHands: 2 }),
    PoseLandmarker.createFromOptions(files, { ...options(poseTask), numPoses: 1 }),
  ]);
  const [hand, pose] = results;
  if (hand.status === 'fulfilled' && pose.status === 'fulfilled') return { hand: hand.value, pose: pose.value };
  for (const result of results) if (result.status === 'fulfilled') result.value.close();
  throw hand.status === 'rejected' ? hand.reason : pose.status === 'rejected' ? pose.reason : new Error('Tracking models could not start');
}

/**
 * Which delegate to run the landmarkers on. The tracker used to hardcode CPU, which costs tens of
 * milliseconds per frame on booth laptops and shows up as a laggy hand overlay, while the same GPU
 * work is several times faster. Pick by measurement rather than assumption: skip software WebGL
 * renderers (they cannot accelerate the tasks and stall on synchronous shader readback), then time a
 * few probe frames on each delegate and keep the faster one.
 */
async function probeDelegate(startFn) {
  const graphics = new OffscreenCanvas(1, 1).getContext('webgl2');
  if (!graphics) return 'CPU';
  const info = graphics.getExtension('WEBGL_debug_renderer_info');
  const renderer = String(graphics.getParameter(info ? info.UNMASKED_RENDERER_WEBGL : graphics.RENDERER));
  graphics.getExtension('WEBGL_lose_context')?.loseContext();
  if (/SwiftShader|llvmpipe|softpipe|software|Microsoft Basic Render/i.test(renderer)) return 'CPU';

  const probe = new OffscreenCanvas(640, 480);
  const context = probe.getContext('2d');
  if (!context) return 'CPU';
  context.fillStyle = '#808080';
  context.fillRect(0, 0, probe.width, probe.height);
  async function time(delegate, budgetMs = Infinity) {
    let candidate;
    try {
      candidate = await startFn(delegate);
      const probeStartedAt = performance.now();
      for (let t = 1; t <= 3; t++) {
        candidate.hand.detectForVideo(probe, t);
        candidate.pose.detectForVideo(probe, t);
        if (performance.now() - probeStartedAt > budgetMs) return Infinity;
      }
      const startedAt = performance.now();
      for (let t = 4; t <= 11; t++) {
        candidate.hand.detectForVideo(probe, t);
        candidate.pose.detectForVideo(probe, t);
        if (performance.now() - startedAt > budgetMs) return Infinity;
      }
      return performance.now() - startedAt;
    } catch {
      return Infinity;
    } finally {
      candidate?.hand.close();
      candidate?.pose.close();
    }
  }
  const cpu = await time('CPU');
  // Software WebGL can spend seconds per probe frame; stop once GPU work exceeds the CPU budget.
  const gpu = await time('GPU', Number.isFinite(cpu) ? Math.max(1500, cpu * 2) : 5000);
  return gpu < cpu ? 'GPU' : 'CPU';
}

async function initialize() {
  const [files, handTask, poseTask] = await Promise.all([
    FilesetResolver.forVisionTasks(asset('vision')),
    verified('vision/hand_landmarker.task', 'fbc2a30080c3c557093b5ddfc334698132eb341044ccee322ccf8bcf3607cde1'),
    verified('vision/pose_landmarker_lite.task', '59929e1d1ee95287735ddd833b19cf4ac46d29bc7afddbbf6753c459690d574a'),
  ]);
  const startFn = delegate => start(files, handTask, poseTask, delegate);
  let delegate = await probeDelegate(startFn);
  try {
    const tasks = await startFn(delegate);
    hand = tasks.hand; pose = tasks.pose;
  } catch (error) {
    if (delegate === 'CPU') throw error;
    delegate = 'CPU';
    const tasks = await startFn(delegate);
    hand = tasks.hand; pose = tasks.pose;
  }
  const warmup = new OffscreenCanvas(320, 240);
  const warmupContext = warmup.getContext('2d');
  warmupContext.fillStyle = '#444';
  warmupContext.fillRect(0, 0, warmup.width, warmup.height);
  hand.detectForVideo(warmup, 1);
  pose.detectForVideo(warmup, 1);
  lastTimestamp = 1;
  return delegate;
}

function track({ bitmap, timestamp, id, compact, overlay = true }) {
  const began = performance.now();
  const long = Math.max(bitmap.width, bitmap.height);
  const ratio = Math.min(1, (compact ? 352 : 960) / long);
  const width = Math.round(bitmap.width * ratio);
  const height = Math.round(bitmap.height * ratio);
  try {
    if (!canvas || canvas.width !== width || canvas.height !== height) {
      canvas = new OffscreenCanvas(width, height);
      context = canvas.getContext('2d');
      prevPose = null;
    }
    context.drawImage(bitmap, 0, 0, width, height);
  } finally {
    bitmap.close();
  }
  lastTimestamp = Math.max(lastTimestamp + 1, timestamp);
  const detected = hand.detectForVideo(canvas, lastTimestamp);
  if (!prevPose || sequence++ % (compact ? 3 : 2) === 0) prevPose = pose.detectForVideo(canvas, lastTimestamp);
  const observation = gatherFrame(detected, prevPose, null, width, height);
  self.postMessage({ type: 'frame', id, timestamp, observation, handCount: detected.landmarks.length,
    hands: overlay ? detected.landmarks : [],
    ms: Math.round(performance.now() - began) }, [observation.buffer]);
}

self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      const delegate = await initialize();
      self.postMessage({ type: 'ready', delegate });
    } else if (data.type === 'frame') {
      track(data);
    }
  } catch (error) {
    self.postMessage({ type: 'error', detail: error.message || String(error) });
  }
};

