import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

const BASE_DURATION = 5000;  // animation length at speed 1.0, ms
const PLANE_SIZE = 160;
const LIFTOFF = 0.45;        // fraction of the animation spent on the runway
const RPM_READ_MS = 250;     // how often the banner re-reads the fans during takeoff

// `back`: distance from icon center to exhaust, in the SVG's 128-unit space
// `propeller`: x position of the propeller, if the plane has one
const PLANES = {
    airliner: {back: 54, flame: true},
    fighter: {back: 56, flame: true},
    prop: {back: 50, flame: false, propeller: 117},
    paper: {back: 44, flame: false},
};

const lerp = (a, b, u) => a + (b - a) * u;
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

// HSL(h, 100%, 65%) → css rgb()
function hueColor(h) {
    const f = n => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (0.65 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return `rgb(${f(0)}, ${f(8)}, ${f(4)})`;
}

export class Takeoff {
    // cfg: {dir, plane, speed, afterburner, roll, rainbow, sky}
    constructor(rpm, cfg, readRpm, onDone) {
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
        this._frame = 0;
        this._destroyed = false;

        this.actor = new St.Widget({
            reactive: false,
            x: mon.x,
            y: mon.y,
            width: mon.width,
            height: mon.height,
            clip_to_allocation: true,
            opacity: 0,
        });
        Main.layoutManager.uiGroup.add_child(this.actor);

        if (cfg.sky !== 'none')
            this._buildSky(cfg.sky);
        this._buildClouds();
        this._buildRunway();

        this._fx = new St.Widget();
        this.actor.add_child(this._fx);
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
        });
        this._timeline.connectObject(
            'new-frame', (_tl, ms) => this._step(ms / this._duration, ms),
            'completed', () => this._finish(),
            this
        );
        this._step(0, 0);
        this._timeline.start();
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
        const y = this._runwayY + this._S * 0.15;
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
        this.actor.add_child(this._plane);
    }

    _step(t, ms) {
        const {_W: W, _H: H, _S: S, _runwayY: ry} = this;
        this._frame++;
        if (!this._reading && ms - this._lastRead >= RPM_READ_MS)
            this._refreshRpm(ms);

        // x accelerates the whole way; y only changes after liftoff
        const cx = -0.15 * W + 1.45 * W * Math.pow(t, 1.6);
        const dxdt = 1.45 * W * 1.6 * Math.pow(t, 0.6);
        const rise = ry + 0.3 * H;
        let cy = ry;
        let dydt = 0;
        let scale = 1;
        let u = 0;

        if (t > LIFTOFF) {
            u = (t - LIFTOFF) / (1 - LIFTOFF);
            cy = ry - rise * u * u;
            dydt = -rise * 2 * u / (1 - LIFTOFF);
            scale = lerp(1, 0.55, u);
        } else {
            cy += Math.sin(ms * 0.09) * 1.5 * (t / LIFTOFF); // runway rumble
        }
        const angle = Math.max(-35, Math.atan2(dydt, Math.max(dxdt, 1)) * 180 / Math.PI);

        this._plane.set_position(Math.round(cx - S / 2), Math.round(cy - S / 2));
        this._plane.rotation_angle_z = angle;
        this._plane.scale_x = this._plane.scale_y = scale;

        if (this._cfg.roll) {
            const p = Math.min(1, Math.max(0, (u - 0.25) / 0.3));
            this._plane.rotation_angle_x = 360 * p * p * (3 - 2 * p);
        }
        if (this._prop)
            this._prop.scale_y = Math.cos(ms * 0.5);

        // screen shake around liftoff
        const shake = Math.max(0, 1 - Math.abs(t - LIFTOFF) / 0.1) * 3;
        this.actor.translation_x = rand(-shake, shake);
        this.actor.translation_y = rand(-shake, shake);

        if (t >= LIFTOFF && !this._lifted) {
            this._lifted = true;
            if (this._cfg.afterburner)
                this._sonicBoom(cx, cy);
        }

        const rad = angle * Math.PI / 180;
        const back = S * (this._info.back / 128) * scale;
        const tail = {
            x: cx - Math.cos(rad) * back,
            y: cy - Math.sin(rad) * back,
        };

        if (t > 0.15)
            this._emitTrail(tail);
        if (this._info.flame && t > 0.25) {
            if (this._cfg.afterburner)
                this._afterburner(tail, rad, scale);
            else
                this._puff(tail.x, tail.y, rand(10, 18), 'pilotfan-flame', 220, -8, 0, 0.3);
        }
        if (t < LIFTOFF + 0.05 && this._frame % 2 === 0) {
            this._puff(cx + rand(-20, 10), ry + S * 0.13, rand(8, 16),
                'pilotfan-dust', 900, rand(-60, -20), rand(-30, -10), 2.5);
        }
        if (Math.random() < t * 0.8)
            this._speedLine();

        if (t > 0.85 && !this._fading) {
            this._fading = true;
            for (const a of [this._banner, this._runway, this._sky].filter(Boolean))
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

    _emitTrail(tail) {
        // fill the gap since last frame so the contrail stays continuous at speed
        const prev = this._lastTail ?? tail;
        const dist = Math.hypot(tail.x - prev.x, tail.y - prev.y);
        const n = Math.min(6, Math.max(1, Math.ceil(dist / 8)));
        for (let i = 1; i <= n; i++) {
            const color = this._cfg.rainbow ? hueColor((this._frame * 6 + i * 6) % 360) : null;
            this._puff(lerp(prev.x, tail.x, i / n), lerp(prev.y, tail.y, i / n), rand(8, 14),
                'pilotfan-contrail', 1600, rand(-10, 10), rand(4, 14), 3.2, color);
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
        const p = new St.Widget({
            style_class: styleClass,
            style: `border-radius: ${Math.round(size / 2)}px;${color ? ` background-color: ${color};` : ''}`,
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

    _finish() {
        this.actor.ease({
            opacity: 0,
            duration: 400,
            mode: EASE_OUT_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    destroy() {
        this._destroyed = true;
        if (this._timeline) {
            this._timeline.stop();
            this._timeline.disconnectObject(this);
            this._timeline = null;
        }
        this._banner?.disconnectObject(this);

        // children go with this.actor anyway; destroyed explicitly so cleanup is easy to audit
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

        if (this._onDone) {
            this._onDone();
            this._onDone = null;
        }
    }
}
