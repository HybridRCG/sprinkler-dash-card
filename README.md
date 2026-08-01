# 💧 Sprinkler Dash Card

A fully self-contained smart irrigation dashboard card for Home Assistant. Zero YAML scripting required — install the card, create your zone duration helpers, and everything else is configured and auto-created from within the card UI.

![Version](https://img.shields.io/badge/version-v2.9.2-green)
![HACS](https://img.shields.io/badge/HACS-Default-orange)
![HA](https://img.shields.io/badge/Home%20Assistant-2023.1%2B-blue)
![License](https://img.shields.io/github/license/HybridRCG/sprinkler-dash-card)

---

## Support the Project

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/hybridrcg)

---

## Screenshots

| Main Card | Zones & Info Bar | Schedule |
|---|---|---|
| ![Main](Sprinkler1.png) | ![Zones](Sprinkler2.png) | ![Schedule](Sprinkler3.png) |

| Skip Next Run | Settings — General | Settings — Rules & Info Bar |
|---|---|---|
| ![Skip Next Run](Sprinkler_exclude_next_run.png) | ![Settings 1](Sprinkler_Settings1.png) | ![Settings 2](Sprinkler_Settings2.png) |

---

## Features

**Zero setup scripting**
- Auto-creates `script.sprinkler` on first load, built from your configured zones
- Auto-creates the Scheduler entity (defaults to Mon/Wed/Fri at 06:00)
- Auto-creates all required helper entities for skip zones and run history
- Script silently rebuilds whenever zones are changed, reordered, or toggled

**Zone control**
- Up to 12 configurable zones — 2-column grid with toggle, progress bar, countdown timer, and 1-minute adjustable duration
- Manual zone on with auto-stop timer — set duration before turning on, card stops the valve automatically
- Zone last-run badge — shows "last: Xm/Xh/Xd ago" on each tile
- Zone run order indicator — during active schedule, sequence badges show green (current), ✓ (done), amber (queued)
- Per-zone schedule toggle — tick/untick each zone to include or exclude from scheduled runs
- Per-zone skip next run — one-tap skip for the next run only, self-clearing after the schedule fires

**Schedule management**
- Built-in scheduler section — enable/disable, set run days, set run time with mobile-friendly HH/MM editor
- Smart next-run countdown — shows "Tonight 22:00", "Tomorrow 06:00", or "in 3h 45m"
- Start Schedule button — manually triggers the full zone sequence
- Stop Schedule button — immediately stops the script and closes all valves (with confirmation)

**Run history**
- Last Run popup — shows up to 12 previous runs with timestamp, zones watered, durations, and skipped zones
- One-tap "Set up run logging" creates a HA automation that records every run automatically, even when the card is not open

**Info bar**
- 4 configurable header slots — label, searchable MDI icon (7000+ with live preview), up to 2 sensors each
- Weather entities auto-render with condition and temperature
- Dual-sensor slots use unified dash separator (e.g. `4,650L - 97%`, `Possible - 55%`)
- All values title-cased automatically
- Tap any slot to open the entity detail popup

**Automation rules**
- Rain auto-disable — schedule turns off when rain exceeds configured mm threshold (slot turns yellow)
- Rain auto-restore — schedule re-enables automatically after configurable hours (default 48h)
- Jojo/tank low-level shutoff — all valves close immediately when tank drops below configured % (slot turns red)
- Confirmation popups — optional confirmation before any zone or schedule action

**Settings & persistence**
- All settings saved via HA websocket — survives hard refresh and works in sections layout
- Drag-to-reorder zones — script run order matches
- Searchable entity picker for all entity fields
- Version number visible in settings header

---

## Requirements

- Home Assistant 2023.1+
- [Scheduler Component](https://github.com/nielsfaber/scheduler-component) integration (via HACS)
- One `input_number` helper per zone for duration (see Step 2)

---

## Installation

### Via HACS (Recommended)

1. Open HACS → Frontend
2. Search for **Sprinkler Dash Card** and install
3. Hard refresh your browser
4. Add the card: `type: custom:sprinkler-dash-card-v2`

### Manual

1. Download `sprinkler-dash-card.js` from the [latest release](../../releases/latest)
2. Copy to `/config/www/sprinkler-dash-card.js`
3. Go to **Settings → Dashboards → Resources**
4. Add `/local/sprinkler-dash-card.js` as **JavaScript Module**
5. Hard refresh your browser

---

## Setup Guide

### Step 1 — Add the card

```yaml
type: custom:sprinkler-dash-card-v2
```

That's the only YAML needed. All configuration is done inside the card via ⚙️.

---

### Step 2 — Create duration helpers

Go to **Settings → Helpers → Add → Number** and create one per zone:

| Helper | Min | Max | Step | Unit |
|---|---|---|---|---|
| `input_number.valve_1_time` | 0 | 60 | 1 | min |
| `input_number.valve_2_time` | 0 | 60 | 1 | min |
| ... | | | | |
| `input_number.valve_8_time` | 0 | 60 | 1 | min |

Create up to `valve_12_time` for up to 12 zones.

---

### Step 3 — Install Scheduler Component

Install **[Scheduler Component](https://github.com/nielsfaber/scheduler-component)** via HACS (Integration category).

The card auto-creates `script.sprinkler` and the Scheduler entity on first load. Adjust the run days and time directly on the card's Schedule section.

---

### Step 4 — Configure zones in ⚙️

- Set **Active Zones** (1–12)
- For each zone: set **Switch Entity** (valve switch) and **Duration Entity** (`input_number` from Step 2)
- Drag ⠿ to reorder — script run order matches
- Tick checkbox to include zone in scheduled runs
- Tap 💾 Save when done

---

### Step 5 — Configure settings in ⚙️

| Setting | Description |
|---|---|
| Nav path | Where tapping the title navigates |
| Rain sensor | Precipitation sensor in mm |
| Rain limit | mm above which schedule auto-disables |
| Rain restore | Hours before schedule re-enables after rain clears (default 48h) |
| Weather | Any `weather.*` entity |
| Jojo sensor | Water tank litres sensor |
| Jojo low % | Tank % below which all zones shut off immediately |
| Schedule switch | The `switch.schedule_*` entity (auto-detected) |

---

### Step 6 — Configure info bar in ⚙️

4 slots, each with: enable checkbox, label, MDI icon (searchable, live preview), Sensor 1, Sensor 2.

Layout auto-adjusts: 1=full, 2=50/50, 3=3-col, 4=2×2. Tap any slot to open entity detail.

---

### Step 7 — Automation rules in ⚙️

| Rule | Behaviour |
|---|---|
| Confirm before activating | Confirmation popup on all zone/schedule actions |
| Rain: Auto-disable schedule | Disables schedule when rain exceeds limit |
| Rain: Auto-restore schedule | Re-enables schedule after rain clears (configurable hours) |
| Jojo: Low-level zone shutoff | Closes all valves when tank drops below low % |

---

## Skip Next Run

Tap the 📅 calendar icon on any zone to skip it for the next run only. The zone shows an amber dashed border and "Skip next run" status. After the next schedule run, the skip clears automatically.

The card auto-creates `input_text.sprinkler_skip_zones` to track this — no setup needed.

---

## Run History

Tap **Last Run** to see recent schedule runs with timestamps, zone durations and skipped zones.

On first use, tap **⚙️ Set up run logging** to create a HA automation that records every run automatically — even when the card is not open. Stores up to 12 runs (approximately one month at 3 runs per week).

---

## Support

- [Issues](../../issues)
- [Home Assistant Community](https://community.home-assistant.io)

---

## Changelog

| Version | Changes |
|---|---|
| v2.9.2 | Fixed premature manual zone auto-stop after card reload |
| v2.9.1 | Mobile time editor scrolls into view when keyboard opens |
| v2.9.0 | Replaced native time picker with HH/MM number inputs — no mobile scroll issues |
| v2.8.9 | Fixed auto-stop operator bug |
| v2.8.8 | Auto-stop manual zone timer even after card reload |
| v2.8.7 | Card reload no longer interrupts a running schedule |
| v2.8.4 | One-tap "Set up run logging" creates HA automation for persistent history |
| v2.8.3 | Ring buffer run history — 12 runs stored in auto-created helpers |
| v2.8.0 | Updated in-card setup guide with all current features |
| v2.7.9 | All zone duration steps set to 1 minute |
| v2.7.7 | Zone run order indicator fully working |
| v2.7.0 | Zone run order indicator; manual zone timer with auto-stop |
| v2.6.0 | Zone run order badges; manual zone timer; HACS validation |
| v2.5.5 | Mobile time edit — HH/MM number inputs |
| v2.5.0 | Stop Schedule button; Last Run popup; zone last-run badges; rain auto-restore |
| v2.4.0 | Per-zone skip next run; auto-creates skip helper |
| v2.3.0 | White section headings; title-case info bar values; unified dash separator |
| v2.2.0 | Confirmation popups; script delay format fixed |
| v2.1.0 | Settings persist via websocket |
| v2.0.0 | Auto-creates script and Scheduler; zone schedule toggle; sticky settings |
| v1.0.0 | Initial release |

---

[![Buy Me A Coffee](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://buymeacoffee.com/hybridrcg)

---

## License

MIT © [HybridRCG](https://github.com/HybridRCG)
