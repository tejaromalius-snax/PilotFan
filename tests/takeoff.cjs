const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

class Actor {
    constructor(props = {}) { Object.assign(this, {children: [], opacity: 255}, props); }
    add_child(child) { this.children.push(child); }
    insert_child_at_index(child, index) { this.children.splice(index, 0, child); }
    set_position(x, y) {
        assert(Number.isFinite(x) && Number.isFinite(y));
        Object.assign(this, {x, y});
    }
    ease(props) {
        for (const value of Object.values(props))
            if (typeof value === 'number') assert(Number.isFinite(value));
    }
    connectObject() {}
    disconnectObject() {}
    start() {}
    stop() {}
    destroy() { this.destroyed = true; }
}

const root = path.join(__dirname, '..');
const context = {
    Clutter: {
        AnimationMode: {}, Timeline: Actor,
        KEY_w: 119, KEY_W: 87, KEY_a: 97, KEY_A: 65,
        KEY_s: 115, KEY_S: 83, KEY_d: 100, KEY_D: 68, KEY_Escape: 65307,
        EVENT_STOP: true, EVENT_PROPAGATE: false,
    },
    Gio: {icon_new_for_string: value => value},
    Graphene: {Point: Actor},
    St: {Widget: Actor, Icon: Actor, Label: Actor,
        ThemeContext: {get_for_stage: () => ({scale_factor: context.scale})}},
    Main: {layoutManager: {primaryMonitor: {x: 0, y: 0, width: 1920, height: 1080},
        uiGroup: {add_child() {}}},
    pushModal: actor => ({actor}),
    popModal: () => {}},
    global: {stage: {}},
    logError: error => { throw error; },
};
const source = fs.readFileSync(path.join(root, 'takeoff.js'), 'utf8')
    .replace(/^import .*;\n/gm, '').replace('export class Takeoff', 'class Takeoff');
vm.createContext(context);
vm.runInContext(`${source}\nthis.Takeoff = Takeoff; this.defaults = FLIGHT_DEFAULTS;`, context);

const schema = fs.readFileSync(path.join(root, 'schemas/org.gnome.shell.extensions.pilotfan.gschema.xml'), 'utf8');
const prefs = fs.readFileSync(path.join(root, 'prefs.js'), 'utf8');
const extension = fs.readFileSync(path.join(root, 'extension.js'), 'utf8');
const low = {}, high = {};
for (const [property, value] of Object.entries(context.defaults)) {
    const match = extension.match(new RegExp(`${property}: s\\.get_(?:double|int)\\('([^']+)'\\)`));
    assert(match, `${property} is read from settings`);
    const key = match[1];
    const block = schema.match(new RegExp(`<key name="${key}"[\\s\\S]*?</key>`))[0];
    assert.equal(Number(block.match(/<default>(.*?)<\/default>/)[1]), value);
    assert(prefs.includes(`spinRow(s, '${key}'`), `${key} has a preferences control`);
    const range = block.match(/<range min="(.*?)" max="(.*?)"/);
    low[property] = Number(range[1]);
    high[property] = Number(range[2]);
}

let simulations = 0;
const dustCounts = new Map();
for (const plane of ['airliner', 'fighter', 'prop', 'paper'])
for (const speed of [0.25, 1, 3])
for (const hz of [30, 60, 144])
for (const scale of [1, 2])
for (const parameters of [{}, low, high]) {
    context.scale = scale;
    let completed = 0;
    const flight = new context.Takeoff(5000, {dir: root, plane, speed,
        afterburner: true, sonicBoom: true, rainbow: true, roll: true, sky: 'none', ...parameters},
    async () => 5000, () => completed++);
    const counts = {};
    // Inspect particle construction before replacing emission for inexpensive simulations.
    flight._puff(0, 0, 5, 'pilotfan-exhaust', 500, 0, 0, 2);
    if (flight._cfg.exhaustOpacity > 0)
        assert.equal(flight._fx.children.at(-1).opacity, Math.round(255 * flight._cfg.exhaustOpacity));
    flight._puff = (...args) => { counts[args[3]] = (counts[args[3]] ?? 0) + 1; };
    const frames = Math.ceil(flight._duration * hz / 1000);
    let lastX = -Infinity;
    for (let frame = 1; frame <= frames; frame++) {
        const t = frame / frames;
        flight._step(t, t * flight._duration);
        assert(flight._plane.x >= lastX);
        lastX = flight._plane.x;
        assert(Number.isFinite(flight._plane.rotation_angle_z));
        assert(flight._shadow.opacity >= 0 && flight._shadow.opacity <= flight._cfg.shadowOpacity);
        if (flight._gear.length && t < flight._cfg.liftoff) {
            const rad = flight._plane.rotation_angle_z * Math.PI / 180;
            const wheelX = flight._S * (flight._info.gear[0] / 128 + 0.0225 - 0.5);
            const wheelY = flight._plane.y + flight._S / 2 + wheelX * Math.sin(rad)
                + flight._S * flight._info.ground * Math.cos(rad);
            assert(Math.abs(wheelY - flight._runwayY - flight._S * flight._info.ground) < 0.61);
        }
    }
    for (const gear of flight._gear) assert.equal(gear.opacity, 0);
    if (flight._cfg.particleDensity === 0) assert.equal(Object.keys(counts).length, 0);
    if (parameters === low) {
        flight._puff = context.Takeoff.prototype._puff;
        const before = flight._fx.children.length;
        for (const kind of ['exhaust', 'dust', 'contrail'])
            flight._puff(0, 0, 5, `pilotfan-${kind}`, 500, 0, 0, 2);
        assert.equal(flight._fx.children.length, before, 'zero opacity creates no particle actors');
    }
    if (plane === 'airliner' && scale === 1 && Object.keys(parameters).length === 0)
        dustCounts.set(`${speed}:${hz}`, counts['pilotfan-dust']);
    const actor = flight.actor;
    flight.destroy(); flight.destroy();
    assert.equal(actor.destroyed, true);
    assert.equal(completed, 1);
    assert.equal(flight.actor, null);
    simulations++;
}
for (const speed of [0.25, 1, 3]) {
    const counts = [30, 60, 144].map(hz => dustCounts.get(`${speed}:${hz}`));
    assert(Math.max(...counts) - Math.min(...counts) <= 3);
}
console.log(`Passed ${simulations} mocked flights with defaults and parameter limits; settings wiring, wheel contact, retraction, opacity, emission, and cleanup checks passed.`);

assert(extension.includes("sonicBoom: s.get_boolean('sonic-boom')"));
assert(prefs.includes("switchRow(s, 'sonic-boom', 'Sonic boom'"));
assert.match(schema, /<key name="sonic-boom" type="b">\s*<default>false<\/default>/);
assert(extension.includes("landingGear: s.get_boolean('landing-gear')"));
assert(prefs.includes("switchRow(s, 'landing-gear', 'Show landing gear'"));
assert.match(schema, /<key name="landing-gear" type="b">\s*<default>true<\/default>/);
assert(extension.includes("wasd: s.get_boolean('wasd-control')"));
assert(prefs.includes("switchRow(s, 'wasd-control', 'Flyable with WASD'"));
assert.match(schema, /<key name="wasd-control" type="b">\s*<default>false<\/default>/);
assert(prefs.includes('s.reset(key)'));

for (const plane of ['airliner', 'fighter', 'prop', 'paper'])
for (const landingGear of [false, true]) {
    const flight = new context.Takeoff(5000, {dir: root, plane, speed: 1, landingGear, sky: 'none'},
        async () => 5000, () => {});
    const hasGearPlane = plane === 'airliner' || plane === 'fighter';
    assert.equal(flight._gear.length > 0, landingGear && hasGearPlane);
    flight._step(0.2, 1000);
    flight._step(0.6, 3000);
    flight.destroy();
}
for (const plane of ['airliner', 'fighter', 'prop', 'paper'])
for (const afterburner of [false, true])
for (const sonicBoom of [false, true]) {
    const flight = new context.Takeoff(5000, {dir: root, plane, speed: 1,
        afterburner, sonicBoom, sky: 'none'}, async () => 5000, () => {});
    let booms = 0;
    let flames = 0;
    flight._sonicBoom = () => booms++;
    flight._afterburner = () => flames++;
    flight._step(0.3, 1500);
    assert.equal(booms, 0, 'sonic boom waits for liftoff');
    flight._step(0.45, 2250);
    flight._step(0.6, 3000);
    flight._step(0.8, 4000);
    assert.equal(booms, sonicBoom ? 1 : 0, 'sonic boom fires once independently of afterburner');
    assert.equal(flames > 0, afterburner && plane === 'fighter',
        'afterburner flames depend only on the fighter and afterburner switch');
    flight.destroy();
}
console.log('Passed all 16 aircraft/afterburner/sonic boom combinations.');

// WASD flight test: runway roll stays automatic, then WASD steers until leaving screen.
{
    let pushed = 0, popped = 0;
    const origPush = context.Main.pushModal;
    const origPop = context.Main.popModal;
    context.Main.pushModal = actor => { pushed++; return origPush(actor); };
    context.Main.popModal = m => { popped++; origPop(m); };

    const flight = new context.Takeoff(5000, {dir: root, plane: 'airliner', speed: 1, wasd: true, sky: 'none'},
        async () => 5000, () => {});
    assert.equal(flight._timeline.repeat_count, -1);
    flight._step(0.2, 1000);
    assert.equal(pushed, 0, 'modal is not pushed before liftoff');
    assert.equal(flight._manual, null);

    // Liftoff at t = 0.45 (2250 ms): starts at rotationAngle, then smoothly pitches into sharp climb
    flight._step(0.45, 2250);
    assert.equal(pushed, 1, 'modal is pushed at liftoff');
    assert.ok(flight._manual);
    assert.equal(flight._manual.angle, -flight._cfg.rotationAngle, 'liftoff angle matches runway rotation');
    for (let ms = 2300; ms <= 2800; ms += 50)
        flight._step(ms / flight._duration, ms);
    assert(flight._manual.angle <= -20, 'plane smoothly pitches into sharp climb when nothing is pressed');

    // Pitch up with 'a', speed down with 's' to rotate past vertical and stay on screen past t = 1.0
    const startAngle = flight._manual.angle;
    const startSpeed = flight._manual.speed;
    flight._onKeyPress({get_key_symbol: () => context.Clutter.KEY_a});
    flight._onKeyPress({get_key_symbol: () => context.Clutter.KEY_s});
    for (let ms = 2300; ms <= 3500; ms += 50)
        flight._step(ms / flight._duration, ms);
    assert.equal(flight._finishing, false, 'flight stays active while on screen');
    assert(flight._manual.angle < -90 && flight._manual.angle < startAngle, 'pressing A can rotate past vertical');
    assert(flight._manual.speed < startSpeed, 'pressing S slows down');
    flight._onKeyRelease({get_key_symbol: () => context.Clutter.KEY_a});
    flight._onKeyRelease({get_key_symbol: () => context.Clutter.KEY_s});

    // Pitch down with 'd' and speed up with 'w' until leaving screen
    const midAngle = flight._manual.angle;
    const midSpeed = flight._manual.speed;
    flight._onKeyPress({get_key_symbol: () => context.Clutter.KEY_d});
    flight._onKeyPress({get_key_symbol: () => context.Clutter.KEY_w});
    for (let ms = 3550; ms <= 4100; ms += 50)
        flight._step(ms / flight._duration, ms);
    assert(flight._manual.angle > midAngle, 'pressing D pitches nose down');
    assert(flight._manual.speed > midSpeed, 'pressing W speeds up');
    flight._onKeyRelease({get_key_symbol: () => context.Clutter.KEY_d});
    flight._onKeyRelease({get_key_symbol: () => context.Clutter.KEY_w});

    for (let ms = 4150; ms <= 15000 && !flight._finishing; ms += 50)
        flight._step(ms / flight._duration, ms);
    assert.equal(flight._finishing, true, 'flight finishes when plane leaves screen');
    assert.equal(popped, 1, 'modal is popped when flight finishes');
    flight.destroy();

    // Escape exits WASD flight early
    const escFlight = new context.Takeoff(5000, {dir: root, plane: 'fighter', speed: 1, wasd: true, sky: 'none'},
        async () => 5000, () => {});
    escFlight._step(0.5, 2500);
    escFlight._onKeyPress({get_key_symbol: () => context.Clutter.KEY_Escape});
    assert.equal(escFlight._finishing, true);
    assert.equal(popped, 2);
    escFlight.destroy();

    // Diving into the runway triggers crash animation and keeps runway visible past t > 0.85
    const crashFlight = new context.Takeoff(5000, {dir: root, plane: 'airliner', speed: 1, wasd: true, sky: 'none'},
        async () => 5000, () => {});
    let runwayFaded = false;
    const origRunwayEase = crashFlight._runway.ease.bind(crashFlight._runway);
    crashFlight._runway.ease = props => {
        if (props.opacity === 0) runwayFaded = true;
        return origRunwayEase(props);
    };
    crashFlight._step(0.45, 2250);
    crashFlight._onKeyPress({get_key_symbol: () => context.Clutter.KEY_s});
    crashFlight._onKeyPress({get_key_symbol: () => context.Clutter.KEY_d});
    for (let ms = 2300; ms <= 10000 && !crashFlight._crashed && !crashFlight._finishing; ms += 50) {
        if (crashFlight._manual.angle >= 45)
            crashFlight._onKeyRelease({get_key_symbol: () => context.Clutter.KEY_d});
        crashFlight._step(ms / crashFlight._duration, ms);
    }
    assert.equal(crashFlight._crashed, true, 'diving into runway triggers crash');
    assert.equal(runwayFaded, false, 'runway stays visible in WASD mode');
    assert.equal(popped, 3, 'modal is popped on crash');
    crashFlight.destroy();

    context.Main.pushModal = origPush;
    context.Main.popModal = origPop;
    console.log('Passed WASD flight control and screen-exit checks.');
}
