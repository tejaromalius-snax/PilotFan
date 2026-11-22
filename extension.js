import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {Takeoff} from './takeoff.js';

Gio._promisify(Gio.File.prototype, 'load_contents_async', 'load_contents_finish');

const POLL_SECONDS = 1;
const decoder = new TextDecoder();

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

export default class PilotFanExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._fans = findFanInputs();
        this._samples = [];
        this._armed = true;
        this._cancellable = new Gio.Cancellable();

        this._createIndicator();
        this._settings.connectObject(
            'changed::panel-position', () => this._createIndicator(),
            this
        );

        this._timer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, POLL_SECONDS, () => {
            this._poll().catch(logError);
            return GLib.SOURCE_CONTINUE;
        });
    }

    disable() {
        if (this._timer) {
            GLib.Source.remove(this._timer);
            this._timer = 0;
        }

        this._cancellable.cancel();
        this._cancellable = null;

        this._settings.disconnectObject(this);
        this._settings = null;

        this._anim?.destroy();
        this._anim = null;

        this._indicator.disconnectObject(this);
        this._label.destroy();
        this._indicator.destroy();
        this._indicator = null;
        this._label = null;

        this._fans = null;
        this._samples = null;
    }

    _createIndicator() {
        if (this._indicator) {
            this._indicator.disconnectObject(this);
            this._indicator.destroy();
        }

        this._indicator = new PanelMenu.Button(0.0, this.metadata.name, true);
        this._label = new St.Label({
            text: this._avg === undefined ? '✈ …' : `✈ ${this._avg}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._indicator.add_child(this._label);

        // Click indicator to preview the animation
        this._indicator.connectObject('button-press-event', () => {
            this._play(this._avg ?? 0);
            return Clutter.EVENT_STOP;
        }, this);

        if (this._settings.get_string('panel-position') === 'left')
            Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'left');
        else
            Main.panel.addToStatusArea(this.uuid, this._indicator);
    }

    async _poll() {
        if (this._busy || !this._fans?.length || !this._cancellable)
            return;

        this._busy = true;
        const cancellable = this._cancellable;
        let now;
        try {
            now = await this._readAverage(cancellable);
        } catch (e) {
            if (!e.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                logError(e, 'PilotFan: failed to read fans');
            return;
        } finally {
            this._busy = false;
        }

        if (!this._cancellable || cancellable.is_cancelled() || !this._samples)
            return;

        const threshold = this._settings.get_int('threshold');
        const rearm = threshold - this._settings.get_int('rearm-margin');
        const window = this._settings.get_int('smoothing-seconds');

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

    // Average of the spinning fans; fans reporting 0 (unused headers / stopped) are ignored
    async _readAverage(cancellable) {
        const rpms = await Promise.all(this._fans.map(async f => {
            const [bytes] = await f.load_contents_async(cancellable);
            return parseInt(decoder.decode(bytes), 10);
        }));
        const spinning = rpms.filter(r => r > 0);
        return spinning.length ? spinning.reduce((a, b) => a + b, 0) / spinning.length : 0;
    }

    async _readLiveRpm() {
        try {
            return await this._readAverage(null);
        } catch (e) {
            logError(e, 'PilotFan: failed to read fans');
            return null;
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
            sonicBoom: s.get_boolean('sonic-boom'),
            roll: s.get_boolean('barrel-roll'),
            rainbow: s.get_boolean('rainbow-trail'),
            sky: s.get_string('sky'),
            liftoff: s.get_double('liftoff-fraction'),
            rotationAngle: s.get_double('rotation-angle'),
            climbHeight: s.get_double('climb-height'),
            landingGear: s.get_boolean('landing-gear'),
            gearDelay: s.get_double('gear-retract-delay'),
            gearDuration: s.get_double('gear-retract-duration'),
            shadowOpacity: s.get_int('shadow-opacity'),
            shadowFadeHeight: s.get_double('shadow-fade-height'),
            particleDensity: s.get_double('particle-density'),
            exhaustOpacity: s.get_double('exhaust-opacity'),
            dustOpacity: s.get_double('dust-opacity'),
            trailOpacity: s.get_double('trail-opacity'),
        }, () => this._readLiveRpm(), () => {
            this._anim = null;
        });
    }
}
