<div align="center">

<img src="assets/icon.png" alt="PilotFan icon: a plane climbing away from a spinning fan" width="128">

# PilotFan

**When your laptop sounds like it's about to take off, it might as well look the part.**

A small GNOME Shell extension that watches your fans and, the moment they
pass **4500 RPM**, sends a little plane down a runway and up across your screen.

`GNOME 46–51` · `Wayland (and X11 where your GNOME still has it)` · `GPL-2.0-or-later`

</div>

---

## Why

You know the sound. You open one too many browser tabs, start a build or join a
video call, and suddenly your laptop is spooling up like an airliner
at the end of runway 27L.

PilotFan doesn't make it any quieter, but it might make you smile when it happens.

## What you'll see

**In the top bar:** a quiet `✈ 3400` showing your average fan speed.
It warms to orange once you're above the threshold.

**When the fans pass 4500 RPM**, for about five seconds:

- 🛫 A plane rolls down a dashed runway, kicking up dust as it gathers speed
- 🌍 The screen rumbles for a moment as the wheels leave the ground
- ☁️ It climbs past drifting clouds, its nose following the climb
- 💨 A white contrail and a flickering orange engine glow trail behind it
- ⚡ Speed lines streak by faster and faster
- 🏷️ A banner tells you exactly how loud things got: *"4812 RPM — cleared for takeoff"*

Then it's gone, and your desktop is exactly as you left it.
The animation never takes focus or blocks a click. Keep working right through it.

> **Tip:** click the `✈` in the top bar to watch a takeoff any time,
> with no need to make your fans suffer.

## Pick your flight

Open **Extensions → PilotFan → Settings** to choose your plane and effects:

| | |
| --- | --- |
| **Plane** | ✈️ Airliner · 🛩️ Fighter jet · 🪂 Propeller plane (with a spinning prop) · 📄 Paper plane |
| **Sky** | None · 🌌 Night, with twinkling stars and a moon · 🌅 Sunset, with a sinking sun |
| **Afterburner and sonic boom** | A roaring flame, plus a shockwave and flash at the moment of liftoff |
| **Barrel roll** | Because you can |
| **Rainbow contrail** | A trail of every color |
| **Animation speed** | From a leisurely 0.25× to a frantic 3× |
| **Top bar position** | Right side, or tucked away at the far left |

The extra effects start switched off, so you get the classic flight until you
decide otherwise.

## Polite by design

PilotFan tries to be a good guest on your desktop:

- **It won't nag.** It flies once each time you cross 4500 RPM, then waits
  until things calm down below 4200 before it can fly again. (Both numbers
  can be changed in settings.)
- **It doesn't react to spikes.** Speeds are averaged over the last few seconds,
  so a one-second burst won't set it off. You can change that window too.
- **It's light on resources.** Between flights, all it does is glance at the
  fan sensors once a second, without ever making your desktop wait.
- **It cleans up after itself.** Turn it off and it's fully gone, with nothing left running.

## Install

### From extensions.gnome.org

Search for **PilotFan** and flip the switch.

### From a zip file

```sh
gnome-extensions install pilotfan@tejaromalius.shell-extension.zip
```

Log out and back in (on Wayland this is the only way GNOME picks up a new extension), then:

```sh
gnome-extensions enable pilotfan@tejaromalius
```

### From source

From the project folder, build the zip and install it:

```sh
gnome-extensions pack --force \
  --extra-source=takeoff.js --extra-source=planes --extra-source=LICENSE \
  --schema=schemas/org.gnome.shell.extensions.pilotfan.gschema.xml \
  --out-dir=dist .
gnome-extensions install --force dist/pilotfan@tejaromalius.shell-extension.zip
```

Then log out, log back in and enable it as above. The same zip is what gets
uploaded to extensions.gnome.org.

## Will it work on my machine?

PilotFan reads the standard Linux fan sensors in `/sys/class/hwmon`. To find out
if your machine has them, run:

```sh
cat /sys/class/hwmon/*/fan*_input
```

If you see a number or two, you're cleared for takeoff. 🎉

| Usually works | Often doesn't |
| --- | --- |
| ASUS laptops | Many HP, IdeaPad, Acer and MSI laptops |
| ThinkPads | Microsoft Surface |
| Many Dell laptops | Apple Silicon Macs |
| Intel MacBooks | Virtual machines |
| Framework (recent kernels) | Fanless devices (lucky you) |
| Desktops, after `sudo sensors-detect` | |

If the top bar shows `✈ …` and never a number, your fans aren't visible to
Linux. That isn't something PilotFan can work around, sorry!

**A note for desktops:** PilotFan averages *every* fan it finds, so a fast CPU
fan next to three slow case fans may never add up to 4500. It's tuned for
laptops, where the fans speed up and slow down together.

## Make it yours

Most things can be changed in **Settings**: takeoff RPM, re-arm margin,
averaging window, plane, sky, effects, speed and top bar position. Changes
apply on the next flight, with no need to log out.

For deeper changes, colors live in `stylesheet.css` and each plane is an SVG in
`planes/`. Repaint one in your favorite airline's livery, rebuild and reinstall
(see [From source](#from-source)), then log out and back in to see it.

## Troubleshooting

Something not right? The system log usually knows why. This catches both the
extension and its settings window:

```sh
journalctl -f -o cat | grep -i pilotfan
```

If the settings window won't open after installing by hand, make sure you
installed the zip rather than copying the folder, because the zip install
also prepares the settings.

## Contributing

Bug reports, new liveries, and support for more hardware are all welcome.
Please keep pull requests small and friendly.

## License

[GPL-2.0-or-later](LICENSE), the same license as GNOME Shell itself.

<div align="center">

<sub>Made for everyone whose laptop has ever sounded like a jet engine. ✈</sub>

</div>
