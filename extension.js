import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Graphene from 'gi://Graphene';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const POLL_SECONDS = 1;
const BASE_DURATION = 5000;  // animation length at speed 1.0, ms
const PLANE_SIZE = 160;
const LIFTOFF = 0.45;        // fraction of the animation spent on the runway

// `back`: distance from icon center to exhaust, in the SVG's 128-unit space
// `propeller`: x position of the propeller, if the plane has one
const PLANES = {
    airliner: {back: 54, flame: true},
    fighter: {back: 56, flame: true},
    prop: {back: 50, flame: false, propeller: 117},
    paper: {back: 44, flame: false},
};

const decoder = new TextDecoder();
const lerp = (a, b, u) => a + (b - a) * u;
const rand = (a, b) => a + Math.random() * (b - a);
const center = () => new Graphene.Point({x: 0.5, y: 0.5});
const {EASE_OUT_QUAD, EASE_IN_QUAD, EASE_OUT_BACK, EASE_OUT_CUBIC, EASE_IN_OUT_SINE, LINEAR} =
    Clutter.AnimationMode;

// HSL(h, 100%, 65%) → css rgb()
function hueColor(h) {
    const f = n => {
        const k = (n + h / 30) % 12;
        return Math.round(255 * (0.65 - 0.35 * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return `rgb(${f(0)}, ${f(8)}, ${f(4)})`;
}

function findFanInputs() {
    const files = [];
    const dir = Gio.File.new_for_path('/sys/class/hwmon');
    let iter;
    try {
        iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
    } catch {
        return files;
    }
    let info;
    while ((info = iter.next_file(null))) {
        const hw = dir.get_child(info.get_name());
        for (let i = 1; i <= 16; i++) {
            const f = hw.get_child(`fan${i}_input`);
            if (f.query_exists(null))
                files.push(f);
        }
    }
    iter.close(null);
    return files;
}

class Takeoff {
    // cfg: {dir, plane, speed, afterburner, roll, rainbow, sky}
    constructor(rpm, cfg, onDone) {
        const mon = Main.layoutManager.primaryMonitor;
        this._cfg = cfg;
        this._info = PLANES[cfg.plane] ?? PLANES.airliner;
        this._k = 1 / cfg.speed;
        this._W = mon.width;
        this._H = mon.height;
        this._S = PLANE_SIZE * St.ThemeContext.get_for_stage(global.stage).scale_factor;
        this._runwayY = this._H * 0.78;
        this._onDone = onDone;
        this._lastTail = null;
        this._frame = 0;

        this.actor = new St.Widget({
            reactive: false,
            x: mon.x, y: mon.y,
            width: mon.width, height: mon.height,
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
            text: `✈  ${rpm} RPM — cleared for takeoff`,
            style_class: 'pilotfan-banner',
            opacity: 0,
            pivot_point: center(),
            scale_x: 0.6, scale_y: 0.6,
        });
        this.actor.add_child(this._banner);
        this._banner.connect('notify::width', () => {
            this._banner.set_position(Math.round((this._W - this._banner.width) / 2), Math.round(this._H * 0.14));
        });

        this.actor.ease({opacity: 255, duration: 300, mode: EASE_OUT_QUAD});
        this._banner.ease({opacity: 255, scale_x: 1, scale_y: 1, delay: 300, duration: 500, mode: EASE_OUT_BACK});

        this._duration = BASE_DURATION * this._k;
        this._timeline = new Clutter.Timeline({actor: this.actor, duration: this._duration});
        this._timeline.connect('new-frame', (_tl, ms) => this._step(ms / this._duration, ms));
        this._timeline.connect('completed', () => this._finish());
        this._step(0, 0);
        this._timeline.start();
    }

    _buildSky(kind) {
        const {_W: W, _H: H} = this;
        this._sky = new St.Widget({style_class: `pilotfan-sky-${kind}`, width: W, height: H, opacity: 0});
        this.actor.add_child(this._sky);
        this._sky.ease({opacity: 210, duration: 600, mode: EASE_OUT_QUAD});

        if (kind === 'night') {
            for (let i = 0; i < 80; i++) {
                const size = Math.round(rand(1, 3.5));
                const star = new St.Widget({
                    style_class: 'pilotfan-star',
                    style: `border-radius: ${size}px;`,
                    width: size, height: size,
                    x: rand(0, W), y: rand(0, H * 0.75),
                    opacity: Math.round(rand(80, 255)),
                });
                this._sky.add_child(star);
                star.ease({
                    opacity: Math.round(rand(10, 60)),
                    duration: rand(300, 1200), delay: rand(0, 600),
                    repeatCount: -1, autoReverse: true, mode: EASE_IN_OUT_SINE,
                });
            }
            this._sky.add_child(new St.Widget({
                style_class: 'pilotfan-moon', style: 'border-radius: 45px;',
                width: 90, height: 90, x: W * 0.82, y: H * 0.1,
            }));
        } else {
            const sun = new St.Widget({
                style_class: 'pilotfan-sun', style: 'border-radius: 130px;',
                width: 260, height: 260, x: W * 0.62, y: H * 0.5,
            });
            this._sky.add_child(sun);
            sun.ease({translation_y: H * 0.12, duration: BASE_DURATION * this._k, mode: LINEAR});
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
                    width: r, height: r,
                    x: j * base * 0.55, y: rand(-r * 0.3, r * 0.2),
                }));
            }
            cloud.set_position(rand(0.1, 1.1) * this._W, rand(0.05, 0.5) * this._H);
            this.actor.add_child(cloud);
            cloud.ease({opacity: target, duration: 800, mode: EASE_OUT_QUAD});
            // parallax drift: plane is moving right, clouds slide left
            cloud.ease({translation_x: -this._W * rand(0.3, 0.6), duration: BASE_DURATION * this._k, mode: LINEAR});
        }
    }

    _buildRunway() {
        const y = this._runwayY + this._S * 0.15;
        this._runway = new St.Widget({opacity: 0});
        this._runway.add_child(new St.Widget({
            style_class: 'pilotfan-runway', x: 0, y, width: this._W, height: 10,
        }));
        for (let x = 20; x < this._W; x += 90) {
            this._runway.add_child(new St.Widget({
                style_class: 'pilotfan-dash', x, y: y + 4, width: 40, height: 2,
            }));
        }
        this.actor.add_child(this._runway);
        this._runway.ease({opacity: 255, duration: 400, mode: EASE_OUT_QUAD});
    }

    _buildPlane() {
        const S = this._S;
        this._plane = new St.Widget({width: S, height: S, pivot_point: center()});
        this._plane.add_child(new St.Icon({
            gicon: Gio.icon_new_for_string(`${this._cfg.dir}/planes/${this._cfg.plane}.svg`),
            icon_size: PLANE_SIZE,
        }));
        if (this._info.propeller) {
            this._prop = new St.Widget({
                style_class: 'pilotfan-propeller',
                width: Math.max(2, S * 0.025), height: S * 0.42,
                x: S * this._info.propeller / 128, y: S * 0.29,
                pivot_point: center(),
            });
            this._plane.add_child(this._prop);
        }
        this.actor.add_child(this._plane);
    }

    _step(t, ms) {
        const {_W: W, _H: H, _S: S, _runwayY: ry} = this;
        this._frame++;

        // x accelerates the whole way; y only changes after liftoff
        const cx = -0.15 * W + 1.45 * W * Math.pow(t, 1.6);
        const dxdt = 1.45 * W * 1.6 * Math.pow(t, 0.6);
        const rise = ry + 0.3 * H;
        let cy = ry, dydt = 0, scale = 1, u = 0;
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
        const tail = {x: cx - Math.cos(rad) * back, y: cy - Math.sin(rad) * back};

        if (t > 0.15)
            this._emitTrail(tail);
        if (this._info.flame && t > 0.25) {
            if (this._cfg.afterburner)
                this._afterburner(tail, rad, scale);
            else
                this._puff(tail.x, tail.y, rand(10, 18), 'pilotfan-flame', 220, -8, 0, 0.3);
        }
        if (t < LIFTOFF + 0.05 && this._frame % 2 === 0)
            this._puff(cx + rand(-20, 10), ry + S * 0.13, rand(8, 16),
                'pilotfan-dust', 900, rand(-60, -20), rand(-30, -10), 2.5);
        if (Math.random() < t * 0.8)
            this._speedLine();

        if (t > 0.85 && !this._fading) {
            this._fading = true;
            for (const a of [this._banner, this._runway, this._sky].filter(Boolean))
                a.ease({opacity: 0, duration: 500, mode: EASE_IN_QUAD});
        }
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
        const cos = Math.cos(rad), sin = Math.sin(rad);
        const layers = [['pilotfan-ab-core', 12], ['pilotfan-flame', 18], ['pilotfan-ab-outer', 14]];
        layers.forEach(([cls, size], i) => {
            const d = (i * 10 + rand(0, 6)) * scale;
            this._puff(tail.x - cos * d, tail.y - sin * d, size * rand(0.8, 1.2) * scale,
                cls, 160, -cos * 24, -sin * 24, 0.4);
        });
    }

    _sonicBoom(x, y) {
        for (let i = 0; i < 2; i++) {
            const ring = new St.Widget({
                style_class: 'pilotfan-boom', style: 'border-radius: 40px;',
                width: 80, height: 80, x: x - 40, y: y - 40,
                pivot_point: center(), scale_x: 0.2, scale_y: 0.2,
            });
            this._fx.add_child(ring);
            ring.ease({
                scale_x: 9, scale_y: 9, opacity: 0,
                delay: i * 140 * this._k, duration: 900 * this._k, mode: EASE_OUT_CUBIC,
                onStopped: () => ring.destroy(),
            });
        }
        const flash = new St.Widget({style_class: 'pilotfan-flash', width: this._W, height: this._H, opacity: 110});
        this._fx.add_child(flash);
        flash.ease({opacity: 0, duration: 350 * this._k, mode: EASE_OUT_QUAD, onStopped: () => flash.destroy()});
    }

    _puff(x, y, size, styleClass, duration, dx, dy, grow, color = null) {
        const p = new St.Widget({
            style_class: styleClass,
            style: `border-radius: ${Math.round(size / 2)}px;${color ? ` background-color: ${color};` : ''}`,
            width: size, height: size,
            x: x - size / 2, y: y - size / 2,
            pivot_point: center(),
        });
        this._fx.add_child(p);
        p.ease({
            opacity: 0, scale_x: grow, scale_y: grow,
            translation_x: dx, translation_y: dy,
            duration: duration * this._k, mode: EASE_OUT_QUAD,
            onStopped: () => p.destroy(),
        });
    }

    _speedLine() {
        const w = rand(80, 220);
        const line = new St.Widget({
            style_class: 'pilotfan-speedline',
            width: w, height: 2,
            x: this._W, y: rand(0.05, 0.95) * this._H,
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
            opacity: 0, duration: 400, mode: EASE_OUT_QUAD,
            onStopped: () => this.destroy(),
        });
    }

    destroy() {
        if (!this._timeline)
            return;
        this._timeline.stop();
        this._timeline = null;
        this.actor.destroy();
        this._onDone();
    }
}

export default class PilotFanExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._fans = findFanInputs();
        this._samples = [];
        this._armed = true;
        this._cancellable = new Gio.Cancellable();

        this._createIndicator();
        this._settings.connectObject('changed::panel-position', () => this._createIndicator(), this);

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._poll().catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        GLib.Source.remove(this._timer);
        this._timer = 0;
        this._cancellable.cancel();
        this._cancellable = null;
        this._settings.disconnectObject(this);
        this._settings = null;
        this._anim?.destroy();
        this._anim = null;
        this._indicator.destroy();
        this._indicator = null;
        this._label = null;
        this._fans = null;
        this._samples = null;
    }

    _createIndicator() {
        this._indicator?.destroy();
        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._label = new St.Label({
            text: this._avg === undefined ? '✈ …' : `✈ ${this._avg}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._label);
        // click the indicator to preview the animation
        this._indicator.connect('button-press-event', () => {
            this._play(this._avg ?? 0);
            return Clutter.EVENT_STOP;
        });
        if (this._settings.get_string('panel-position') === 'left')
            Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'left');
        else
            Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    async _poll() {
        if (this._busy || !this._fans.length)
            return;
        this._busy = true;
        const cancellable = this._cancellable;
        let rpms;
        try {
            rpms = await Promise.all(this._fans.map(async f => {
                const [bytes] = await f.load_contents_async(cancellable);
                return parseInt(decoder.decode(bytes), 10);
            }));
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'PilotFan: failed to read fans');
            return;
        } finally {
            this._busy = false;
        }
        if (cancellable.is_cancelled())
            return;

        const threshold = this._settings.get_int('threshold');
        const rearm = threshold - this._settings.get_int('rearm-margin');
        const window = this._settings.get_int('smoothing-seconds');

        // fans reporting 0 (unused headers / stopped) are ignored
        const spinning = rpms.filter(r => r > 0);
        const now = spinning.length ? spinning.reduce((a, b) => a + b, 0) / spinning.length : 0;
        this._samples.push(now);
        while (this._samples.length > window)
            this._samples.shift();
        this._avg = Math.round(this._samples.reduce((a, b) => a + b, 0) / this._samples.length);

        this._label.text = `✈ ${this._avg}`;
        if (this._avg > threshold)
            this._label.add_style_class_name('pilotfan-hot');
        else
            this._label.remove_style_class_name('pilotfan-hot');

        if (this._armed && this._avg > threshold) {
            this._armed = false;
            this._play(this._avg);
        } else if (this._avg < rearm) {
            this._armed = true;
        }
    }

    _play(rpm) {
        if (this._anim)
            return;
        const s = this._settings;
        this._anim = new Takeoff(rpm, {
            dir: this.path,
            plane: s.get_string('plane'),
            speed: s.get_double('speed'),
            afterburner: s.get_boolean('afterburner'),
            roll: s.get_boolean('barrel-roll'),
            rainbow: s.get_boolean('rainbow-trail'),
            sky: s.get_string('sky'),
        }, () => {
            this._anim = null;
        });
    }
}
