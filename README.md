# 💧 Sprinkler Dash Card

A fully self-contained smart irrigation dashboard card for Home Assistant. Zero YAML scripting required — install the card, create your duration helpers, and everything else is configured and auto-created from the card UI.

![Version](https://img.shields.io/badge/version-v2.0.0-green)
![HACS](https://img.shields.io/badge/HACS-Custom-orange)
![HA](https://img.shields.io/badge/Home%20Assistant-2023.1%2B-blue)

---

## Screenshots

| Main Card | Zones & Info Bar | Schedule |
|---|---|---|
| ![Main](Sprinkler1.png) | ![Zones](Sprinkler2.png) | ![Schedule](Sprinkler3.png) |

| Settings — General | Settings — Info Bar & Rules |
|---|---|
| ![Settings 1](Sprinkler_Settings1.png) | ![Settings 2](Sprinkler_Settings2.png) |

---

## Features

- **Up to 10 configurable zones** — 2-column grid with toggle switch, progress bar, countdown timer, and adjustable duration
- **Auto-creates everything** — on first load creates `script.sprinkler` and the Scheduler entity automatically; no manual scripting needed
- **Zone schedule toggle** — tick/untick each zone to include or skip it in scheduled runs
- **Built-in scheduler section** — enable/disable, set run days, set run time, shows next run countdown
- **4-slot configurable info bar** — label, searchable MDI icon, up to 2 sensors per slot; tap any slot to open the entity detail popup
- **Searchable entity picker** — find any HA entity by typing in all entity fields
- **MDI icon picker** — search 7000+ icons with live preview
- **Rain auto-disable** — when rain exceeds your configured mm threshold the schedule auto-disables (slot turns yellow)
- **Jojo/tank low-level shutoff** — when tank drops below your configured %, all running zones shut off immediately (slot turns red)
- **Automation rules panel** — enable/disable each rule individually from settings
- **Drag-to-reorder zones** — reorder in settings; script run order matches
- **All Off** — cuts all zones in a single service call directly from the card
- **Navigation** — tap the card title to navigate to any HA view
- **Fully UI-configurable** — one line of YAML, everything else in ⚙️ settings
- **HACS compatible**

---

## Installation

### Via HACS (Recommended)

1. Open HACS → Frontend
2. Click the three-dot menu → **Custom repositories**
3. Add `HybridRCG/sprinkler-dash-card` as category **Lovelace**
4. Search for "Sprinkler Dash Card" and install
5. Hard refresh your browser

### Manual

1. Download `sprinkler-dash-card.js` from the [latest release](../../releases/latest)
2. Copy to `/config/www/sprinkler-dash-card.js`
3. Go to **Settings → Dashboards → Resources**
4. Add `/local/sprinkler-dash-card.js` as type **JavaScript Module**
5. Hard refresh your browser

---

## Setup Guide

### Step 1 — Add the card

```yaml
type: custom:sprinkler-dash-card-v2
```

That's the only YAML you need. All configuration is done inside the card via the ⚙️ gear icon.

---

### Step 2 — Create duration helpers

Go to **Settings → Helpers → Add Helper → Number** and create one per zone:

| Helper | Min | Max | Step | Unit |
|---|---|---|---|---|
| `input_number.valve_1_time` | 0 | 60 | 5 | min |
| `input_number.valve_2_time` | 0 | 60 | 5 | min |
| `input_number.valve_3_time` | 0 | 60 | 5 | min |
| `input_number.valve_4_time` | 0 | 60 | 5 | min |
| `input_number.valve_5_time` | 0 | 60 | 5 | min |
| `input_number.valve_6_time` | 0 | 60 | 5 | min |
| `input_number.valve_7_time` | 0 | 60 | 5 | min |
| `input_number.valve_8_time` | 0 | 60 | 5 | min |

Create up to `valve_10_time` if using 9 or 10 zones.

---

### Step 3 — Install Scheduler integration

Install **[Scheduler Component](https://github.com/nielsfaber/scheduler-component)** via HACS (Integration category).

That's all — on first load the card automatically:
- Creates `script.sprinkler` built from your configured zones in sequence
- Creates the Scheduler entity (defaults to Mon/Wed/Fri at 06:00)

> Adjust the days and time directly on the card's Schedule section. The script silently rebuilds whenever you change zones, reorder them, or toggle their schedule checkbox.

---

### Step 4 — Configure zones in ⚙️

- Set **Active Zones** (1–10) — controls how many zones appear in the grid
- For each zone set the **Switch Entity** (valve switch) and **Duration Entity** (`input_number` from Step 2)
- Use the search field to find entities by typing
- Drag **⠿** to reorder — script run order matches zone order
- **Checkbox** next to each zone name — tick to include in scheduled runs, untick to skip

---

### Step 5 — Configure settings in ⚙️

| Setting | Description |
|---|---|
| Nav path | Where tapping the title navigates (e.g. `/lovelace`) |
| Rain sensor | Precipitation sensor in mm |
| Rain limit | mm threshold above which schedule auto-disables |
| Weather | Any `weather.*` entity |
| Jojo sensor | Water tank litres sensor |
| Jojo low % | Tank level % below which all zones shut off immediately |
| Schedule switch | The `switch.schedule_*` entity from Scheduler (auto-detected) |

---

### Step 6 — Configure info bar in ⚙️

4 slots in the header. Each slot has:

| Field | Description |
|---|---|
| Enable | Checkbox to show/hide the slot |
| Label | Text shown before the value |
| Icon | Searchable MDI icon with live preview |
| Sensor 1 | Primary value (`weather.*` entities auto-render with icon + temp) |
| Sensor 2 | Optional second value appended inline |

**Tap any info bar item** to open the entity detail popup in HA.

Layout auto-adjusts: 1 enabled = full width, 2 = 50/50, 3 = 3 equal columns, 4 = 2×2 grid.

---

### Step 7 — Automation rules in ⚙️

| Rule | Behaviour |
|---|---|
| Rain: Auto-disable schedule | Rain sensor ≥ limit → schedule turns off, slot turns yellow |
| Jojo: Low-level zone shutoff | Tank level < low % → all running zones switch off, slot turns red |

---

## How All Off and Start Schedule work

- **All Off** — calls `switch.turn_off` on all active zone switches simultaneously from the card. No script involved.
- **Start Schedule** — fires `script.sprinkler` which the card auto-created. Zones run sequentially in order, each for their configured duration. Only zones with the schedule checkbox ticked are included.

---

## Support

- [Issues](../../issues)
- [Home Assistant Community](https://community.home-assistant.io)

---

## Changelog

| Version | Changes |
|---|---|
| v2.2.1 | Max zones increased to 12; screenshots added to README |
| v2.2.0 | Confirmation popup on zones, All Off, Start Schedule, schedule toggle; enable/disable in rules settings; fixed script delay format (was hours, now minutes) |
| v2.1.0 | Settings save via websocket (works in sections layout); frozen config deep-clone fix; all settings now persist on hard refresh |
| v2.0.0 | Auto-creates `script.sprinkler` and Scheduler entity on first load; zone schedule checkbox; automation rules panel; sticky setup instructions with always-visible buttons; bigger fonts; info bar items clickable |
| v1.8.0 | Auto-rebuild script on zone changes; setup instructions modal |
| v1.7.0 | Info bar enable/disable per slot; MDI icon picker; smart grid layout |
| v1.6.0 | 4 configurable info bar slots; Jojo low % setting; nav_path fix |
| v1.5.0 | Max 10 zones; entity search fixed; Switch + Duration Entity per zone |
| v1.4.0 | Rain auto-disable; Jojo level display; threshold settings |
| v1.3.0 | Full settings panel; drag-to-reorder; entity search; nav path |
| v1.2.0 | Built-in scheduler section; progress bar; live duration countdown |
| v1.1.0 | All Off direct switch calls; +/- duration buttons; sequence numbers |
| v1.0.0 | Initial release |

---

## License

MIT © [HybridRCG](https://github.com/HybridRCG)
