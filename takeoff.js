import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BASE_DURATION = 5000;  // animation length at speed 1.0, ms
const PLANE_SIZE = 160;
const RPM_READ_MS = 250;     // how often the banner re-reads the fans during takeoff

const FLIGHT_DEFAULTS = {
    liftoff: 0.45,
    rotationAngle: 7.0,
    climbHeight: 1.08,
    gearDelay: 0.08,
    gearDuration: 0.22,
    shadowOpacity: 90,
    shadowFadeHeight: 0.28,
    particleDensity: 1.0,
    exhaustOpacity: 0.12,
    dustOpacity: 0.28,
    trailOpacity: 0.5,
};

// `back`: distance from icon center to exhaust, in the SVG's 128-unit space
// `propeller`: x position of the propeller, if the plane has one
const PLANES = {
    airliner: {back: 54, engines: [[-12, 14]], gear: [60, 110], ground: 0.25},
    fighter: {back: 56, engines: [[-56, 0]], flame: true, gear: [45, 98], ground: 0.25},
    prop: {back: 50, propeller: 117, ground: 0.1875},
    paper: {back: 44, ground: 0.1},
};

const lerp = (a, b, u) => a + (b - a) * u;
const smooth = u => {
    const v = Math.max(0, Math.min(1, u));
    return v * v * (3 - 2 * v);
};
const rand = (a, b) => a + Math.random() * (b - a);
const center = () => new Graphene.Point({x: 0.5, y: 0.5});
const bannerText = rpm => `✈  ${rpm} RPM — cleared for takeoff`;

const {
    EASE_OUT_QUAD,
    EASE_IN_QUAD,
    EASE_OUT_BACK,
    EASE_OUT_CUBIC,
    EASE_IN_OUT_SINE,
    LINEAR,
} = Clutter.AnimationMode;

const KEY_DIRS = {
    [Clutter.KEY_a]: 'up', [Clutter.KEY_A]: 'up',
    [Clutter.KEY_d]: 'down', [Clutter.KEY_D]: 'down',
    [Clutter.KEY_w]: 'faster', [Clutter.KEY_W]: 'faster',
    [Clutter.KEY_s]: 'slower', [Clutter.KEY_S]: 'slower',
};

// HSL(h, 100%, 65%) → css rgb()
function hueColor(h) {
    const f = n => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (0.65 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return `rgb(${f(0)}, ${f(8)}, ${f(4)})`;
}

export class Takeoff {
    // cfg: {dir, plane, speed, afterburner, sonicBoom, roll, rainbow, sky, ...FLIGHT_DEFAULTS}
    constructor(rpm, cfg, readRpm, onDone) {
        cfg = {...FLIGHT_DEFAULTS, ...cfg};
        const mon = Main.layoutManager.primaryMonitor;
        this._cfg = cfg;
        this._info = PLANES[cfg.plane] ?? PLANES.airliner;
        this._k = 1 / cfg.speed;
        this._W = mon.width;
        this._H = mon.height;
        this._S = PLANE_SIZE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._runwayY = this._H * 0.78;
        this._readRpm = readRpm;
        this._reading = false;
        this._lastRead = -Infinity;
        this._onDone = onDone;
        this._lastTail = null;
        this._lastMs = 0;
        this._lastFrameMs = 0;
        this._totalMs = 0;
        this._particleTime = 0;
        this._keys = new Set();
        this._manual = null;
        this._modal = null;
        this._finishing = false;
        this._destroyed = false;

        this.actor = new St.Widget({
            reactive: Boolean(cfg.wasd),
            can_focus: Boolean(cfg.wasd),
            x: mon.x,
            y: mon.y,
            width: mon.width,
            height: mon.height,
            clip_to_allocation: true,
            opacity: 0,
        });
        Main.layoutManager.uiGroup.add_child(this.actor);
        if (cfg.wasd) {
            this.actor.connectObject(
                'key-press-event', (_actor, event) => this._onKeyPress(event),
                'key-release-event', (_actor, event) => this._onKeyRelease(event),
                this
            );
        }

        if (cfg.sky !== 'none')
            this._buildSky(cfg.sky);
        this._buildClouds();
        this._buildRunway();

        this._fx = new St.Widget();
        this.actor.add_child(this._fx);
        this._shadow = new St.Widget({
            style_class: 'pilotfan-shadow',
            width: this._S * 0.8,
            height: this._S * 0.065,
            pivot_point: center(),
        });
        this.actor.add_child(this._shadow);
        this._buildPlane();

        this._banner = new St.Label({
            text: bannerText(rpm),
            style_class: 'pilotfan-banner',
            opacity: 0,
            pivot_point: center(),
            scale_x: 0.6,
            scale_y: 0.6,
        });
        this.actor.add_child(this._banner);
        this._banner.connectObject('notify::width', () => {
            const bx = Math.round((this._W - this._banner.width) / 2);
            const by = Math.round(this._H * 0.14);
            this._banner.set_position(bx, by);
        }, this);

        this.actor.ease({
            opacity: 255,
            duration: 300,
            mode: EASE_OUT_QUAD,
        });
        this._banner.ease({
            opacity: 255,
            scale_x: 1,
            scale_y: 1,
            delay: 300,
            duration: 500,
            mode: EASE_OUT_BACK,
        });

        this._duration = BASE_DURATION * this._k;
        this._timeline = new Clutter.Timeline({
            actor: this.actor,
            duration: this._duration,
            ...(cfg.wasd ? {repeat_count: -1} : {}),
        });
        this._timeline.connectObject(
            'new-frame', (_tl, ms) => {
                let dt = ms - this._lastFrameMs;
                if (dt < 0)
                    dt += this._duration;
                this._lastFrameMs = ms;
                this._totalMs += dt;
                this._step(this._totalMs / this._duration, this._totalMs);
            },
            'completed', () => {
                if (!this._cfg.wasd)
                    this._finish();
            },
            this
        );
        this._step(0, 0);
        this._timeline.start();
    }

    _onKeyPress(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this._finish();
            return Clutter.EVENT_STOP;
        }
        const dir = KEY_DIRS[sym];
        if (dir) {
            this._keys.add(dir);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _onKeyRelease(event) {
        const dir = KEY_DIRS[event.get_key_symbol()];
        if (dir) {
            this._keys.delete(dir);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _buildSky(kind) {
        const {_W: W, _H: H} = this;
        this._sky = new St.Widget({
            style_class: `pilotfan-sky-${kind}`,
            width: W,
            height: H,
            opacity: 0,
        });
        this.actor.add_child(this._sky);
        this._sky.ease({opacity: 210, duration: 600, mode: EASE_OUT_QUAD});

        if (kind === 'night') {
            for (let i = 0; i < 80; i++) {
                const size = Math.round(rand(1, 3.5));
                const star = new St.Widget({
                    style_class: 'pilotfan-star',
                    style: `border-radius: ${size}px;`,
                    width: size,
                    height: size,
                    x: rand(0, W),
                    y: rand(0, H * 0.75),
                    opacity: Math.round(rand(80, 255)),
                });
                this._sky.add_child(star);
                star.ease({
                    opacity: Math.round(rand(10, 60)),
                    duration: rand(300, 1200),
                    delay: rand(0, 600),
                    repeatCount: -1,
                    autoReverse: true,
                    mode: EASE_IN_OUT_SINE,
                });
            }
            this._sky.add_child(new St.Widget({
                style_class: 'pilotfan-moon',
                style: 'border-radius: 45px;',
                width: 90,
                height: 90,
                x: W * 0.82,
                y: H * 0.1,
            }));
        } else {
            const sun = new St.Widget({
                style_class: 'pilotfan-sun',
                style: 'border-radius: 130px;',
                width: 260,
                height: 260,
                x: W * 0.62,
                y: H * 0.5,
            });
            this._sky.add_child(sun);
            sun.ease({
                translation_y: H * 0.12,
                duration: BASE_DURATION * this._k,
                mode: LINEAR,
            });
        }
    }

    _buildClouds() {
        const target = this._cfg.sky === 'night' ? 70 : 160;
        for (let i = 0; i < 5; i++) {
            const cloud = new St.Widget({opacity: 0});
            const base = rand(40, 80);
            for (let j = 0; j < 4; j++) {
                const r = base * rand(0.6, 1.1);
                cloud.add_child(new St.Widget({
                    style_class: 'pilotfan-cloud',
                    style: `border-radius: ${Math.round(r / 2)}px;`,
                    width: r,
                    height: r,
                    x: j * base * 0.55,
                    y: rand(-r * 0.3, r * 0.2),
                }));
            }
            cloud.set_position(rand(0.1, 1.1) * this._W, rand(0.05, 0.5) * this._H);
            this.actor.add_child(cloud);
            cloud.ease({opacity: target, duration: 800, mode: EASE_OUT_QUAD});
            // parallax drift: plane is moving right, clouds slide left
            cloud.ease({
                translation_x: -this._W * rand(0.3, 0.6),
                duration: BASE_DURATION * this._k,
                mode: LINEAR,
            });
        }
    }

    _buildRunway() {
        const y = this._runwayY + this._S * this._info.ground;
        this._runway = new St.Widget({opacity: 0});
        this._runway.add_child(new St.Widget({
            style_class: 'pilotfan-runway',
            x: 0,
            y,
            width: this._W,
            height: 10,
        }));
        for (let x = 20; x < this._W; x += 90) {
            this._runway.add_child(new St.Widget({
                style_class: 'pilotfan-dash',
                x,
                y: y + 4,
                width: 40,
                height: 2,
            }));
        }
        this.actor.add_child(this._runway);
        this._runway.ease({opacity: 255, duration: 400, mode: EASE_OUT_QUAD});
    }

    _buildPlane() {
        const S = this._S;
        this._plane = new St.Widget({
            width: S,
            height: S,
            pivot_point: center(),
        });
        this._plane.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._cfg.dir}/planes/${this._cfg.plane}.svg`),
            icon_size: PLANE_SIZE,
        }));
        if (this._info.propeller) {
            this._prop = new St.Widget({
                style_class: 'pilotfan-propeller',
                width: Math.max(2, S * 0.025),
                height: S * 0.42,
                x: S * this._info.propeller / 128,
                y: S * 0.29,
                pivot_point: center(),
            });
            this._plane.add_child(this._prop);
        }
        this._gear = [];
        if (this._cfg.landingGear !== false) {
            for (const x of this._info.gear ?? []) {
                const gear = new St.Widget({
                    x: S * x / 128,
                    y: S * 0.56,
                    width: S * 0.045,
                    height: S * 0.19,
                    pivot_point: new Graphene.Point({x: 0.5, y: 0}),
                });
                gear.add_child(new St.Widget({
                    style_class: 'pilotfan-gear-strut',
                    x: S * 0.016,
                    width: Math.max(1, S * 0.012),
                    height: S * 0.16,
                }));
                gear.add_child(new St.Widget({
                    style_class: 'pilotfan-wheel',
                    y: S * 0.145,
                    width: S * 0.045,
                    height: S * 0.045,
                }));
                this._gear.push(gear);
                this._plane.insert_child_at_index(gear, 0);
            }
        }
        this.actor.add_child(this._plane);
    }

    _step(t, ms) {
        if (this._crashed || this._finishing || this._destroyed)
            return;
        const {_W: W, _H: H, _S: S, _runwayY: ry} = this;
        const elapsed = Math.max(0, ms - this._lastMs);
        this._lastMs = ms;
        this._particleTime += elapsed;
        const interval = this._cfg.particleDensity > 0
            ? 32 * this._k / this._cfg.particleDensity : Infinity;
        const emissions = Math.min(16, Math.floor(this._particleTime / interval));
        this._particleTime %= interval;
        if (!this._reading && ms - this._lastRead >= RPM_READ_MS)
            this._refreshRpm(ms);

        const liftoff = this._cfg.liftoff;
        const groundDistance = W * 0.45;
        const liftSpeed = 2 * groundDistance / liftoff;
        let cx, cy, u, scale, angle, flipY = 1;

        if (this._cfg.wasd && t >= liftoff) {
            const justLifted = !this._manual;
            if (justLifted) {
                try {
                    this._modal = Main.pushModal?.(this.actor) ?? null;
                } catch {}
                this._manual = {
                    x: -W * 0.1 + groundDistance,
                    y: ry,
                    speed: liftSpeed * (1000 / this._duration),
                    angle: -this._cfg.rotationAngle,
                    omega: 0,
                    hasPitched: false,
                };
            }
            const dtSec = justLifted ? 0 : elapsed / 1000;
            const pitchInput = (this._keys.has('down') ? 1 : 0) - (this._keys.has('up') ? 1 : 0);
            if (pitchInput !== 0)
                this._manual.hasPitched = true;
            const targetAngle = -Math.max(this._cfg.rotationAngle, 22);
            const targetOmega = this._manual.hasPitched
                ? pitchInput * 135
                : Math.max(-90, Math.min(90, (targetAngle - this._manual.angle) * 5));
            const turnBlend = 1 - Math.exp(-8 * dtSec);
            this._manual.omega = lerp(this._manual.omega, targetOmega, turnBlend);
            this._manual.angle += this._manual.omega * dtSec;

            const throttle = (this._keys.has('faster') ? 1 : 0) - (this._keys.has('slower') ? 1 : 0);
            if (throttle !== 0) {
                const minSpeed = Math.max(W, H) * 0.08 * this._cfg.speed;
                const maxSpeed = Math.max(W, H) * 0.95 * this._cfg.speed;
                const accel = Math.max(W, H) * 0.45 * this._cfg.speed;
                this._manual.speed = Math.max(minSpeed,
                    Math.min(maxSpeed, this._manual.speed + throttle * accel * dtSec));
            }

            const manualRad = this._manual.angle * Math.PI / 180;
            this._manual.x += this._manual.speed * Math.cos(manualRad) * dtSec;
            this._manual.y += this._manual.speed * Math.sin(manualRad) * dtSec;
            cx = this._manual.x;
            cy = this._manual.y;
            u = Math.min(1, (t - liftoff) / (1 - liftoff));
            angle = this._manual.angle;
            scale = lerp(1, 0.72, smooth(u));

            const pad = S * 0.6;
            if (cx < -pad || cx > W + pad || cy < -pad || cy > H + pad) {
                this._finish();
                return;
            }
            const groundLine = ry + S * this._info.ground * (1 - scale);
            if (cy >= groundLine && Math.sin(manualRad) > 0) {
                this._crash(cx, ry + S * this._info.ground);
                return;
            }
        } else {
            // Match position and velocity at rotation, then ease into the climb.
            const groundT = Math.min(t, liftoff) / liftoff;
            const flightT = Math.max(0, t - liftoff);
            cx = -W * 0.1 + groundDistance * groundT * groundT
                + liftSpeed * flightT + W * 0.18 * flightT * flightT;
            const dxdt = t < liftoff ? liftSpeed * groundT : liftSpeed + W * 0.36 * flightT;
            const rise = this._cfg.climbHeight * H;
            u = Math.max(0, (t - liftoff) / (1 - liftoff));
            const rotation = smooth((t - liftoff + 0.08) / 0.08);
            cy = ry - rise * u * u;
            const dydt = -rise * 2 * u / (1 - liftoff);
            scale = lerp(1, 0.62, smooth(u));
            if (t < liftoff)
                cy += Math.sin(ms / this._k * 0.055) * 0.6 * groundT;
            angle = Math.max(-35,
                Math.atan2(dydt, Math.max(dxdt, 1)) * 180 / Math.PI
                - this._cfg.rotationAngle * rotation * (1 - smooth(u)));

            // Rotate around the main wheels while keeping them on the runway.
            if (this._gear.length) {
                const rad = angle * Math.PI / 180;
                const wheelX = S * (this._info.gear[0] / 128 + 0.0225 - 0.5);
                cy += (S * this._info.ground * (1 - Math.cos(rad))
                    - wheelX * Math.sin(rad)) * (1 - smooth(u / 0.15));
            }
        }
        this._plane.set_position(cx - S / 2, cy - S / 2);
        this._plane.rotation_angle_z = angle;
        this._plane.scale_x = scale;
        this._plane.scale_y = scale * flipY;

        if (this._cfg.roll) {
            const p = Math.min(1, Math.max(0, (u - 0.25) / 0.3));
            this._plane.rotation_angle_x = 360 * p * p * (3 - 2 * p);
        }
        if (this._prop)
            this._prop.scale_y = Math.cos(ms * 0.5);

        const retract = smooth((u - this._cfg.gearDelay) / this._cfg.gearDuration);
        for (const gear of this._gear) {
            gear.scale_y = 1 - retract;
            gear.opacity = Math.round(255 * (1 - retract));
        }
        const altitude = Math.max(0, ry - cy);
        const shadowFade = Math.max(0, 1 - altitude / (H * this._cfg.shadowFadeHeight));
        this._shadow.set_position(cx - S * 0.4, ry + S * this._info.ground);
        this._shadow.scale_x = lerp(1, 1.65, 1 - shadowFade);
        this._shadow.scale_y = lerp(1, 2.5, 1 - shadowFade);
        this._shadow.opacity = Math.round(this._cfg.shadowOpacity * shadowFade);

        if (t >= liftoff && !this._lifted) {
            this._lifted = true;
            if (this._cfg.sonicBoom)
                this._sonicBoom(cx, cy);
        }

        const rad = angle * Math.PI / 180;
        const back = S * (this._info.back / 128) * scale;
        const tail = {
            x: cx - Math.cos(rad) * back,
            y: cy - Math.sin(rad) * back,
        };

        for (let emission = 0; emission < emissions; emission++) {
            if (u > 0.12 || (this._cfg.rainbow && t > 0.15))
                this._emitTrail(tail, rad, scale, ms, flipY);
            if (this._info.flame && t > 0.25) {
                if (this._cfg.afterburner)
                    this._afterburner(tail, rad, scale);
                else
                    this._puff(tail.x, tail.y, 9 * scale,
                        'pilotfan-exhaust', 450, -18, 2, 2);
            } else if (this._info.engines && t > 0.15) {
                for (const [ex, ey] of this._info.engines) {
                    const fy = ey * flipY;
                    const x = cx + (ex * Math.cos(rad) - fy * Math.sin(rad)) * S / 128 * scale;
                    const y = cy + (ex * Math.sin(rad) + fy * Math.cos(rad)) * S / 128 * scale;
                    this._puff(x, y, 6 * scale, 'pilotfan-exhaust', 550, -20, 3, 2.5);
                }
            }
            if (t < liftoff && t > 0.12) {
                this._puff(cx - S * 0.1, ry + S * this._info.ground, rand(4, 8),
                    'pilotfan-dust', 650, rand(-35, -15), rand(-8, -2), 2);
            }
            if (Math.random() < t * 0.3)
                this._speedLine();
        }

        if (t > 0.85 && !this._fading) {
            this._fading = true;
            const actors = this._cfg.wasd
                ? [this._banner]
                : [this._banner, this._runway, this._sky];
            for (const a of actors.filter(Boolean))
                a.ease({opacity: 0, duration: 500, mode: EASE_IN_QUAD});
        }
    }

    _refreshRpm(ms) {
        this._reading = true;
        this._lastRead = ms;
        this._readRpm().then(rpm => {
            if (!this._destroyed && rpm !== null && this._banner)
                this._banner.text = bannerText(Math.round(rpm));
        }).catch(e => {
            logError(e, 'PilotFan: banner RPM refresh failed');
        }).finally(() => {
            this._reading = false;
        });
    }

    _emitTrail(tail, rad, scale, ms, flipY = 1) {
        // Airliner vapor originates behind its wing-mounted engine.
        if (this._info.engines && !this._info.flame) {
            const [ex, ey] = this._info.engines[0];
            const fy = ey * flipY;
            const back = this._S * this._info.back / 128 * scale;
            tail = {
                x: tail.x + Math.cos(rad) * back
                    + (ex * Math.cos(rad) - fy * Math.sin(rad)) * this._S / 128 * scale,
                y: tail.y + Math.sin(rad) * back
                    + (ex * Math.sin(rad) + fy * Math.cos(rad)) * this._S / 128 * scale,
            };
        }
        // fill the gap since last frame so the contrail stays continuous at speed
        const prev = this._lastTail ?? tail;
        const dist = Math.hypot(tail.x - prev.x, tail.y - prev.y);
        const n = Math.min(6, Math.max(1, Math.ceil(dist / 8)));
        for (let i = 1; i <= n; i++) {
            const color = this._cfg.rainbow ? hueColor((ms / this._k * 0.12 + i * 6) % 360) : null;
            this._puff(lerp(prev.x, tail.x, i / n), lerp(prev.y, tail.y, i / n), rand(3, 6) * scale,
                'pilotfan-contrail', 1400, rand(-4, 4), rand(2, 8), 3, color);
        }
        this._lastTail = tail;
    }

    _afterburner(tail, rad, scale) {
        const cos = Math.cos(rad);
        const sin = Math.sin(rad);
        const layers = [
            ['pilotfan-ab-core', 12],
            ['pilotfan-flame', 18],
            ['pilotfan-ab-outer', 14],
        ];
        layers.forEach(([cls, size], i) => {
            const d = (i * 10 + rand(0, 6)) * scale;
            this._puff(tail.x - cos * d, tail.y - sin * d, size * rand(0.8, 1.2) * scale,
                cls, 160, -cos * 24, -sin * 24, 0.4);
        });
    }

    _sonicBoom(x, y) {
        for (let i = 0; i < 2; i++) {
            const ring = new St.Widget({
                style_class: 'pilotfan-boom',
                style: 'border-radius: 40px;',
                width: 80,
                height: 80,
                x: x - 40,
                y: y - 40,
                pivot_point: center(),
                scale_x: 0.2,
                scale_y: 0.2,
            });
            this._fx.add_child(ring);
            ring.ease({
                scale_x: 9,
                scale_y: 9,
                opacity: 0,
                delay: i * 140 * this._k,
                duration: 900 * this._k,
                mode: EASE_OUT_CUBIC,
                onStopped: () => ring.destroy(),
            });
        }
        const flash = new St.Widget({
            style_class: 'pilotfan-flash',
            width: this._W,
            height: this._H,
            opacity: 110,
        });
        this._fx.add_child(flash);
        flash.ease({
            opacity: 0,
            duration: 350 * this._k,
            mode: EASE_OUT_QUAD,
            onStopped: () => flash.destroy(),
        });
    }

    _puff(x, y, size, styleClass, duration, dx, dy, grow, color = null) {
        const opacity = {
            'pilotfan-exhaust': this._cfg.exhaustOpacity,
            'pilotfan-dust': this._cfg.dustOpacity,
            'pilotfan-contrail': this._cfg.trailOpacity,
        }[styleClass];
        if (opacity === 0)
            return;
        const background = color ?? {
            'pilotfan-exhaust': 'rgb(170, 185, 200)',
            'pilotfan-dust': 'rgb(168, 148, 120)',
            'pilotfan-contrail': 'rgb(255, 255, 255)',
        }[styleClass];
        const p = new St.Widget({
            style_class: styleClass,
            opacity: Math.round(255 * (opacity ?? 1)),
            style: `border-radius: ${Math.round(size / 2)}px;${background ? ` background-color: ${background};` : ''}`,
            width: size,
            height: size,
            x: x - size / 2,
            y: y - size / 2,
            pivot_point: center(),
        });
        this._fx.add_child(p);
        p.ease({
            opacity: 0,
            scale_x: grow,
            scale_y: grow,
            translation_x: dx,
            translation_y: dy,
            duration: duration * this._k,
            mode: EASE_OUT_QUAD,
            onStopped: () => p.destroy(),
        });
    }

    _speedLine() {
        const w = rand(80, 220);
        const line = new St.Widget({
            style_class: 'pilotfan-speedline',
            width: w,
            height: 2,
            x: this._W,
            y: rand(0.05, 0.95) * this._H,
        });
        this._fx.add_child(line);
        line.ease({
            translation_x: -this._W - w * 2,
            duration: rand(350, 650) * this._k,
            mode: LINEAR,
            onStopped: () => line.destroy(),
        });
    }

    _crash(x, y) {
        if (this._crashed || this._finishing || this._destroyed)
            return;
        this._crashed = true;
        if (this._modal) {
            Main.popModal?.(this._modal);
            this._modal = null;
        }
        this._shadow.ease({opacity: 0, duration: 150, mode: EASE_OUT_QUAD});
        this._plane.ease({
            opacity: 0,
            scale_x: 0.25,
            scale_y: 0.25,
            rotation_angle_z: this._plane.rotation_angle_z + 45,
            duration: 350,
            mode: EASE_OUT_QUAD,
        });

        const ring = new St.Widget({
            style_class: 'pilotfan-boom',
            style: 'border-radius: 40px;',
            width: 80,
            height: 80,
            x: x - 40,
            y: y - 40,
            pivot_point: center(),
            scale_x: 0.2,
            scale_y: 0.2,
        });
        this._fx.add_child(ring);
        ring.ease({
            scale_x: 5,
            scale_y: 5,
            opacity: 0,
            duration: 900,
            mode: EASE_OUT_CUBIC,
            onStopped: () => {
                ring.destroy();
                this._finish();
            },
        });

        for (let i = 0; i < 18; i++) {
            const a = rand(-Math.PI, 0);
            const dist = rand(30, 140);
            const cls = i < 6 ? 'pilotfan-ab-core' : i < 12 ? 'pilotfan-flame' : 'pilotfan-ab-outer';
            this._puff(x + rand(-12, 12), y + rand(-6, 6), rand(14, 34), cls,
                rand(450, 850), Math.cos(a) * dist, Math.sin(a) * dist, rand(1.8, 3.2));
        }
        for (let i = 0; i < 12; i++) {
            this._puff(x + rand(-20, 20), y, rand(18, 40), 'pilotfan-smoke',
                rand(700, 1100), rand(-50, 50), rand(-120, -40), rand(2.2, 3.8), 'rgb(55, 65, 81)');
        }
    }

    _finish() {
        if (this._finishing || this._destroyed)
            return;
        this._finishing = true;
        if (this._modal) {
            Main.popModal?.(this._modal);
            this._modal = null;
        }
        this.actor.ease({
            opacity: 0,
            duration: 400,
            mode: EASE_OUT_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._modal) {
            Main.popModal?.(this._modal);
            this._modal = null;
        }
        if (this._timeline) {
            this._timeline.stop();
            this._timeline.disconnectObject(this);
            this._timeline = null;
        }
        this.actor?.disconnectObject(this);
        this._banner?.disconnectObject(this);

        // children go with this.actor anyway; destroyed explicitly so cleanup is easy to audit
        this._shadow?.destroy();
        this._prop?.destroy();
        this._plane?.destroy();
        this._banner?.destroy();
        this._sky?.destroy();
        this._runway?.destroy();
        this._fx?.destroy();
        this.actor?.destroy();

        this.actor = null;
        this._fx = null;
        this._banner = null;
        this._sky = null;
        this._runway = null;
        this._plane = null;
        this._prop = null;
        this._shadow = null;
        this._gear = [];

        if (this._onDone) {
            this._onDone();
            this._onDone = null;
        }
    }
}
