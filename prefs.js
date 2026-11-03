import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

function spinRow(settings, key, title, subtitle, lower, upper, step, digits = 0) {
    const row = new Adw.SpinRow({
        title, subtitle, digits,
        adjustment: new Gtk.Adjustment({lower, upper, step_increment: step, page_increment: step * 10}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

// choices: [[value, label], ...] for a string key with <choices>
function comboRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title, subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const values = choices.map(([value]) => value);
    row.selected = Math.max(0, values.indexOf(settings.get_string(key)));
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    return row;
}

export default class PilotFanPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'PilotFan', icon_name: 'weather-few-clouds-symbolic'});
        window.add(page);

        const fans = new Adw.PreferencesGroup({title: 'Fan speed'});
        fans.add(spinRow(s, 'threshold', 'Takeoff speed', 'Average RPM that starts a takeoff', 500, 20000, 100));
        fans.add(spinRow(s, 'rearm-margin', 'Re-arm margin',
            'RPM the fans must drop below the takeoff speed before the next flight', 0, 5000, 50));
        fans.add(spinRow(s, 'smoothing-seconds', 'Averaging window', 'Seconds of readings to average', 1, 60, 1));
        page.add(fans);

        const flight = new Adw.PreferencesGroup({title: 'Flight'});
        flight.add(comboRow(s, 'plane', 'Plane', null, [
            ['airliner', 'Airliner'], ['fighter', 'Fighter jet'], ['prop', 'Propeller plane'], ['paper', 'Paper plane'],
        ]));
        flight.add(spinRow(s, 'speed', 'Animation speed', '1.0 is normal, 2.0 is twice as fast', 0.25, 3, 0.25, 2));
        flight.add(comboRow(s, 'sky', 'Sky', 'Tint the screen during the flight', [
            ['none', 'None'], ['night', 'Night with stars'], ['sunset', 'Sunset'],
        ]));
        page.add(flight);

        const effects = new Adw.PreferencesGroup({title: 'Effects'});
        effects.add(switchRow(s, 'afterburner', 'Afterburner and sonic boom',
            'Bigger engine flame, plus a shockwave at liftoff'));
        effects.add(switchRow(s, 'barrel-roll', 'Barrel roll', 'A quick roll halfway through the climb'));
        effects.add(switchRow(s, 'rainbow-trail', 'Rainbow contrail', 'Contrail cycles through colors'));
        page.add(effects);

        const panel = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'Tip: click the ✈ reading in the top bar to preview a takeoff.',
        });
        panel.add(comboRow(s, 'panel-position', 'Position', null, [
            ['right', 'Right side'], ['left', 'Far left'],
        ]));
        page.add(panel);
    }
}
