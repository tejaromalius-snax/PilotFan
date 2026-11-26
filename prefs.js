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
    const sync = () => {
        const index = Math.max(0, values.indexOf(settings.get_string(key)));
        if (row.selected !== index)
            row.selected = index;
    };
    sync();
    row.connect('notify::selected', () => settings.set_string(key, values[row.selected]));
    const handlerId = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(handlerId));
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
        flight.add(switchRow(s, 'wasd-control', 'Flyable with WASD',
            'Steer the plane with W, A, S, D after liftoff until it leaves the screen'));
        page.add(flight);

        const effects = new Adw.PreferencesGroup({title: 'Effects'});
        effects.add(switchRow(s, 'afterburner', 'Afterburner',
            'Bigger engine flame on the fighter jet'));
        effects.add(switchRow(s, 'sonic-boom', 'Sonic boom',
            'Shockwave and flash at liftoff'));
        effects.add(switchRow(s, 'barrel-roll', 'Barrel roll', 'A quick roll halfway through the climb'));
        effects.add(switchRow(s, 'rainbow-trail', 'Rainbow contrail', 'Contrail cycles through colors'));
        page.add(effects);

        const motion = new Adw.PreferencesGroup({title: 'Takeoff motion'});
        motion.add(spinRow(s, 'liftoff-fraction', 'Runway time',
            'Fraction of the flight spent accelerating on the runway', 0.3, 0.6, 0.05, 2));
        motion.add(spinRow(s, 'rotation-angle', 'Rotation angle',
            'Extra nose-up pitch at liftoff, in degrees', 0.0, 15.0, 1.0, 0));
        motion.add(spinRow(s, 'climb-height', 'Climb height',
            'Total climb as a fraction of screen height', 0.5, 1.5, 0.05, 2));
        page.add(motion);

        const ground = new Adw.PreferencesGroup({title: 'Landing gear and shadow'});
        ground.add(switchRow(s, 'landing-gear', 'Show landing gear',
            'Display retractable landing gear on jet aircraft'));
        const gearDelayRow = spinRow(s, 'gear-retract-delay', 'Gear retraction delay',
            'Fraction of the climb before jet landing gear starts retracting', 0.0, 0.4, 0.02, 2);
        const gearDurationRow = spinRow(s, 'gear-retract-duration', 'Gear retraction duration',
            'Fraction of the climb spent retracting jet landing gear', 0.05, 0.5, 0.05, 2);
        s.bind('landing-gear', gearDelayRow, 'sensitive', Gio.SettingsBindFlags.GET);
        s.bind('landing-gear', gearDurationRow, 'sensitive', Gio.SettingsBindFlags.GET);
        ground.add(gearDelayRow);
        ground.add(gearDurationRow);
        ground.add(spinRow(s, 'shadow-opacity', 'Shadow strength',
            'Ground shadow opacity, from 0 (hidden) to 255', 0, 255, 5, 0));
        ground.add(spinRow(s, 'shadow-fade-height', 'Shadow fade height',
            'Altitude at which the shadow disappears, as a fraction of screen height', 0.05, 0.6, 0.05, 2));
        page.add(ground);

        const particles = new Adw.PreferencesGroup({title: 'Particles'});
        particles.add(spinRow(s, 'particle-density', 'Particle density',
            '0 disables particles; 1 is normal; 2 doubles the emission rate', 0.0, 2.0, 0.25, 2));
        particles.add(spinRow(s, 'exhaust-opacity', 'Exhaust opacity',
            'Opacity of subtle jet exhaust, from 0 to 1', 0.0, 1.0, 0.05, 2));
        particles.add(spinRow(s, 'dust-opacity', 'Dust opacity',
            'Opacity of runway dust, from 0 to 1', 0.0, 1.0, 0.05, 2));
        particles.add(spinRow(s, 'trail-opacity', 'Contrail opacity',
            'Opacity of white and rainbow trails, from 0 to 1', 0.0, 1.0, 0.05, 2));
        page.add(particles);

        const panel = new Adw.PreferencesGroup({
            title: 'Top bar',
            description: 'Tip: click the ✈ reading in the top bar to preview a takeoff.',
        });
        panel.add(comboRow(s, 'panel-position', 'Position', null, [
            ['right', 'Right side'], ['left', 'Far left'],
        ]));
        page.add(panel);

        const resetGroup = new Adw.PreferencesGroup();
        const resetButton = new Gtk.Button({
            label: 'Reset',
            valign: Gtk.Align.CENTER,
            css_classes: ['destructive-action'],
        });
        resetButton.connect('clicked', () => {
            for (const key of s.settings_schema.list_keys())
                s.reset(key);
        });
        const resetRow = new Adw.ActionRow({
            title: 'Reset to defaults',
            subtitle: 'Restore all settings to their default values',
            activatable_widget: resetButton,
        });
        resetRow.add_suffix(resetButton);
        resetGroup.add(resetRow);
        page.add(resetGroup);
    }
}
