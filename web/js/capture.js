/**
 * Guided 360 capture, in the browser, using the phone's own sensors.
 *
 * Why this exists: every earlier approach handed the hard part to something we do
 * not control. Stitching a video meant inferring camera motion from pixels, which
 * loses to blank walls. Using the phone's Panorama mode meant accepting whatever
 * it decided to give us - typically 220 degrees, and no way to ask for more.
 *
 * Here the phone tells us where it is pointing for every frame, so placement is
 * arithmetic (see sphere.js) and the only thing left to get right is guiding the
 * person holding it. That is a user-interface problem rather than a computer
 * vision one, which is a much better problem to have.
 *
 * What this needs from the device, and what happens when it is missing:
 *
 *   getUserMedia          camera. HTTPS only. Absent on old browsers -> we say so
 *                         and the upload paths stay available.
 *   DeviceOrientation     which way it is pointing. iOS 13+ demands a permission
 *                         prompt fired from a real tap, hence the start button.
 *                         Without it there is no capture at all - guessing would
 *                         be worse than declining.
 */

import {
  createPanoBuilder,
  createFocalEstimator,
  columnProfile,
  hfovFromFocal,
  angleDelta,
  detectRotation,
  rotateFrame,
} from './sphere.js';

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;

/**
 * Field of view across the LONGER image axis, assumed until the sweep measures
 * the real one. Phone main cameras cluster tightly around this.
 *
 * It has to be stated for the long axis, because that is the figure that stays
 * put. An earlier version assumed 65 degrees HORIZONTALLY, which is right for a
 * landscape frame and badly wrong for the portrait one this app asks for: a
 * portrait 16:9 frame is only about 41 degrees across. Every frame was therefore
 * painted 1.56x wider than it really was, so consecutive frames overlapped far
 * more than intended and the same furniture landed several times over. That is
 * what the smeared, doubled-up result was.
 */
const FALLBACK_LONG_FOV = 67;

/** Focal length in pixels implied by FALLBACK_LONG_FOV for a frame this size. */
const fallbackFocalFor = (w, h) =>
  Math.max(w, h) / 2 / Math.tan((FALLBACK_LONG_FOV * RAD) / 2);
/** Reject frames tilted more than this - they would smear the horizon. */
const MAX_ROLL = 14;
/** Buffer frames until the focal estimate settles, then composite them properly. */
const CALIBRATION_FRAMES = 6;

/* ------------------------------------------------------- device orientation */

/**
 * Device Euler angles -> where the back camera is pointing.
 *
 * The W3C rotation is R = Rz(alpha)·Rx(beta)·Ry(gamma), taking device axes into
 * an earth frame of x east, y north, z up. The back camera looks along the
 * device's -z, and the top of the picture is the device's +y, so both fall out of
 * the third and second columns of R. Doing it through the matrix rather than
 * reading beta as "pitch" is what makes it hold up when the phone is not being
 * held in the one orientation the shortcut assumes.
 */
export function cameraFromOrientation(alpha, beta, gamma) {
  const a = alpha * RAD;
  const b = beta * RAD;
  const g = gamma * RAD;
  const cA = Math.cos(a);
  const sA = Math.sin(a);
  const cB = Math.cos(b);
  const sB = Math.sin(b);
  const cG = Math.cos(g);
  const sG = Math.sin(g);

  // Third column: device -z, i.e. where the lens points.
  const dx = -(cA * sG + sA * sB * cG);
  const dy = -(sA * sG - cA * sB * cG);
  const dz = -(cB * cG);

  // Second column: device +y, the top of the frame.
  const ux = -sA * cB;
  const uy = cA * cB;
  const uz = sB;

  const yaw = Math.atan2(dx, dy) * DEG;
  const pitch = Math.asin(Math.max(-1, Math.min(1, dz))) * DEG;

  // Roll is how far the frame's top has rotated about the view axis away from
  // world up. right = d x up_world, then reference up = right x d.
  const rx = dy * 1 - dz * 0;
  const ry = dz * 0 - dx * 1;
  const rz = dx * 0 - dy * 0;
  const rl = Math.hypot(rx, ry, rz) || 1;
  const nx = rx / rl;
  const ny = ry / rl;
  const nz = rz / rl;
  const px = ny * dz - nz * dy;
  const py = nz * dx - nx * dz;
  const pz = nx * dy - ny * dx;
  const roll = Math.atan2(ux * nx + uy * ny + uz * nz, ux * px + uy * py + uz * pz) * DEG;

  return { yaw, pitch, roll };
}

/** Ask for motion access. Resolves to true when we may read the sensors. */
async function requestMotion() {
  const D = window.DeviceOrientationEvent;
  if (!D) return false;
  if (typeof D.requestPermission !== 'function') return true; // Android and desktop
  try {
    return (await D.requestPermission()) === 'granted';
  } catch {
    return false; // thrown when not called from a user gesture
  }
}

/* --------------------------------------------------------------- the overlay */

const html = `
<div class="cap-shade"></div>
<div class="cap-stage">
  <video class="cap-video" playsinline muted autoplay></video>
  <div class="cap-grid"><i></i><i></i></div>
  <div class="cap-tilt"><span></span></div>
</div>
<div class="cap-top">
  <div class="cap-strip"></div>
  <div class="cap-pct"><b>0%</b> of the room</div>
</div>
<div class="cap-say"></div>
<div class="cap-bar">
  <button class="btn sm cap-cancel" type="button">Cancel</button>
  <button class="btn primary cap-start" type="button">Start capture</button>
  <button class="btn primary cap-done hidden" type="button">Use this</button>
</div>`;

/**
 * Run a capture. Resolves with the same shape preparePanorama() returns, so the
 * upload path does not need to know where a panorama came from, or null if the
 * person backed out.
 */
export function captureRoom({ label = 'this room' } = {}) {
  return new Promise((resolve, reject) => {
    const root = document.createElement('div');
    root.className = 'cap';
    root.innerHTML = html;
    document.body.append(root);
    document.body.style.overflow = 'hidden';

    const $ = (s) => root.querySelector(s);
    const video = $('.cap-video');
    const strip = $('.cap-strip');
    const pct = $('.cap-pct b');
    const say = $('.cap-say');
    const tilt = $('.cap-tilt span');
    const startBtn = $('.cap-start');
    const doneBtn = $('.cap-done');

    const SECTORS = 60;
    const cells = [];
    for (let i = 0; i < SECTORS; i++) {
      const c = document.createElement('i');
      strip.append(c);
      cells.push(c);
    }

    let stream = null;
    let raf = 0;
    let running = false;
    let finished = false;

    const orient = { yaw: 0, pitch: 0, roll: 0, seen: false };
    // Only ever one source. Chrome fires both deviceorientation and
    // deviceorientationabsolute, with alpha measured from different references,
    // so listening to both made yaw jump between two frames of reference on
    // alternate events and scattered the frames around the circle.
    let bound = null;
    const onOrient = (ev) => {
      if (bound && ev.type !== bound) return;
      // NOT webkitCompassHeading. That is the heading of the TOP of the device,
      // and this app asks for the phone to be held upright - where the top points
      // at the sky and the heading is degenerate. Only relative yaw is needed
      // here, and alpha is gyro-derived and smooth.
      if (ev.alpha == null || ev.beta == null || ev.gamma == null) return;
      if (!bound) bound = ev.type;
      Object.assign(orient, cameraFromOrientation(ev.alpha, ev.beta, ev.gamma));
      orient.seen = true;
    };

    function cleanup() {
      running = false;
      cancelAnimationFrame(raf);
      window.removeEventListener('deviceorientation', onOrient, true);
      window.removeEventListener('deviceorientationabsolute', onOrient, true);
      stream?.getTracks().forEach((t) => t.stop());
      document.body.style.overflow = '';
      root.remove();
    }

    $('.cap-cancel').onclick = () => {
      if (finished) return;
      finished = true;
      cleanup();
      resolve(null);
    };

    /* ------------------------------------------------------------- capturing */

    const builder = createPanoBuilder();
    let estimator = null; // needs the frame size, so built once the camera is up.
    const pending = []; // held back until the focal length is known
    let focal = null;
    // How the sensor's pixels sit relative to the phone. Measured, never assumed:
    // a phone held upright commonly hands over landscape frames.
    let rotation = null;
    let lastRaw = null;
    let yaw0 = null;
    let lastYaw = null;
    let lastProfile = null;
    let basePitch = 0;
    let grabW = 0;
    let grabH = 0;

    const grab = document.createElement('canvas');
    const gctx = grab.getContext('2d');

    function snapshot() {
      gctx.drawImage(video, 0, 0, grabW, grabH);
      const c = document.createElement('canvas');
      c.width = grabW;
      c.height = grabH;
      c.getContext('2d').drawImage(grab, 0, 0);
      return c;
    }

    function commit(frame, yaw, pitch) {
      // Refine against the overlap: the gyroscope says where the phone pointed,
      // not where the picture was taken, and the two drift apart.
      builder.addFrame(rotateFrame(frame, rotation || 0), { yaw, pitch, focal, refineDeg: 6 });
    }

    /** Width of a frame once it is the right way up. */
    const uprightWidth = () => ((rotation === 90 || rotation === 270) ? grabH : grabW);

    function paintCoverage() {
      const secs = builder.sectors(SECTORS);
      for (let i = 0; i < SECTORS; i++) cells[i].className = secs[i] ? 'on' : '';
      const cov = builder.coverage();
      pct.textContent = `${Math.round(cov * 100)}%`;
      // Where the lens is pointing right now, so the strip reads as a compass.
      if (yaw0 != null) {
        const rel = ((((orient.yaw - yaw0) % 360) + 360) % 360) / 360;
        strip.style.setProperty('--at', `${rel * 100}%`);
      }
      doneBtn.classList.toggle('hidden', builder.frameCount() < 3);
      return cov;
    }

    function tick() {
      if (!running) return;
      raf = requestAnimationFrame(tick);
      if (!orient.seen || video.readyState < 2) return;

      const roll = orient.roll;
      tilt.style.transform = `rotate(${Math.max(-30, Math.min(30, roll))}deg)`;
      tilt.parentElement.classList.toggle('bad', Math.abs(roll) > MAX_ROLL);

      if (yaw0 == null) {
        yaw0 = orient.yaw;
        basePitch = orient.pitch;
      }
      const yaw = angleDelta(orient.yaw, yaw0);
      const pitch = orient.pitch;

      if (Math.abs(roll) > MAX_ROLL) {
        say.textContent = 'Hold the phone upright';
        say.className = 'cap-say warn';
        return;
      }

      const known = focal ?? fallbackFocalFor(grabW, grabH);
      const hfov = hfovFromFocal(known, uprightWidth());
      const step = hfov * 0.5;
      const moved = lastYaw == null ? Infinity : Math.abs(angleDelta(yaw, lastYaw));

      if (moved >= step) {
        const raw = snapshot();
        const moveBy = lastYaw == null ? 0 : angleDelta(yaw, lastYaw);

        // Learn which way up the sensor hands over pixels before trusting any
        // of them. Until that is settled the frames are only held, not placed.
        if (rotation == null && lastRaw) {
          const found = detectRotation(lastRaw, raw, moveBy);
          if (found) rotation = found.degrees;
          else if (pending.length >= CALIBRATION_FRAMES) {
            // Nothing to lock on to - a blank wall. Fall back to the geometry:
            // the phone is upright (roll was checked above), so a landscape frame
            // must be turned a quarter.
            rotation = grabW > grabH ? 90 : 0;
          }
        }

        if (rotation == null) {
          pending.push({ frame: raw, yaw, pitch });
        } else {
          const upright = rotateFrame(raw, rotation);
          const profile = columnProfile(upright);
          if (lastProfile) estimator.observe(lastProfile, profile, moveBy, upright.width);
          lastProfile = profile;

          if (focal == null) {
            pending.push({ frame: raw, yaw, pitch });
            if (estimator.settled() || pending.length >= CALIBRATION_FRAMES) {
              focal = estimator.focal();
              for (const f of pending) commit(f.frame, f.yaw, f.pitch);
              pending.length = 0;
            }
          } else {
            commit(raw, yaw, pitch);
          }
        }

        lastRaw = raw;
        lastYaw = yaw;
      }

      const cov = paintCoverage();
      if (cov >= 0.985) {
        say.textContent = 'Whole room captured - press Use this';
        say.className = 'cap-say good';
      } else if (Math.abs(pitch - basePitch) > 18) {
        say.textContent = 'Keep it level with where you started';
        say.className = 'cap-say warn';
      } else {
        say.textContent = builder.frameCount()
          ? 'Keep turning slowly, on the spot'
          : 'Turn slowly - either way';
        say.className = 'cap-say';
      }
    }

    /* ---------------------------------------------------------------- finish */

    doneBtn.onclick = async () => {
      if (finished) return;
      finished = true;
      running = false;
      cancelAnimationFrame(raf);
      say.textContent = 'Building the panorama...';
      say.className = 'cap-say';

      // Anything still waiting on calibration would otherwise be thrown away.
      if (pending.length) {
        rotation = rotation ?? (grabW > grabH ? 90 : 0);
        focal = focal ?? estimator.focal();
        for (const f of pending) commit(f.frame, f.yaw, f.pitch);
        pending.length = 0;
      }

      const built = builder.finish();
      stream?.getTracks().forEach((t) => t.stop());

      if (!built) {
        cleanup();
        return reject(new Error('Nothing was captured. Try again and turn more slowly.'));
      }

      const blob = await new Promise((r) => built.canvas.toBlob(r, 'image/jpeg', 0.9));
      cleanup();
      if (!blob || blob.size < 1024) {
        return reject(new Error('The browser could not encode the panorama - it may have run out of memory.'));
      }
      resolve({
        blob,
        haov: built.haov,
        vaov: built.vaov,
        vOffset: built.vOffset,
        source: 'captured',
        parts: built.frames,
        placements: null,
        width: built.canvas.width,
        height: built.canvas.height,
        hfov: hfovFromFocal(focal, uprightWidth()),
        rotation,
      });
    };

    /* ----------------------------------------------------------------- start */

    say.textContent = `Stand in the middle of ${label}, hold the phone upright, and turn slowly on the spot.`;

    startBtn.onclick = async () => {
      startBtn.disabled = true;
      try {
        // Motion first: on iOS this prompt only works inside the tap that opened
        // it, and there is no point turning the camera on if it is refused.
        const motion = await requestMotion();
        if (!motion) {
          throw new Error(
            'This needs access to motion sensors to know which way the phone is pointing. ' +
            'Allow it and try again, or use the Panorama photo button instead.'
          );
        }
        window.addEventListener('deviceorientationabsolute', onOrient, true);
        window.addEventListener('deviceorientation', onOrient, true);

        if (!navigator.mediaDevices?.getUserMedia) {
          throw new Error('This browser cannot open the camera. Use the Panorama photo button instead.');
        }
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            facingMode: { ideal: 'environment' },
            width: { ideal: 1920 },
            height: { ideal: 1080 },
          },
          audio: false,
        });
        video.srcObject = stream;
        await video.play();

        // Work at roughly the resolution the output needs. A full circle is 4096
        // px wide, so a 65 degree frame only ever contributes about 740 - reading
        // 1920 for every column would cost memory and buy nothing.
        const vw = video.videoWidth || 720;
        const vh = video.videoHeight || 1280;
        const scale = Math.min(1, 1100 / Math.max(vw, vh));
        grabW = Math.round(vw * scale);
        grabH = Math.round(vh * scale);
        grab.width = grabW;
        grab.height = grabH;
        estimator = createFocalEstimator({ fallbackFocal: fallbackFocalFor(grabW, grabH) });

        // Give the sensors a moment; on some devices the first events lag.
        setTimeout(() => {
          if (!orient.seen && !finished) {
            say.textContent =
              'No motion readings yet. On a desktop there are no sensors - open this page on a phone.';
            say.className = 'cap-say warn';
          }
        }, 2500);

        root.classList.add('live');
        startBtn.classList.add('hidden');
        running = true;
        tick();
      } catch (err) {
        finished = true;
        cleanup();
        reject(err);
      }
    };
  });
}
