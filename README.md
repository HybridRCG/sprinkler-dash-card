# 💧 Sprinkler Dash Card

A fully self-contained smart irrigation dashboard card for Home Assistant. No dependencies on `scheduler-card` or any other custom card — everything is built in.

![Version](https://img.shields.io/badge/version-v1.7.0-green)
![HACS](https://img.shields.io/badge/HACS-Custom-orange)
![HA](https://img.shields.io/badge/Home%20Assistant-2023.1%2B-blue)

---

## Features

- **2-column zone grid** — up to 10 zones, each with toggle switch, progress bar, countdown timer, and adjustable duration
- **Built-in scheduler** — enable/disable, set run days and time, shows next run countdown; powered by the [Scheduler integration](https://github.com/nielsfaber/scheduler-component)
- **4-slot configurable info bar** — each slot has a label, MDI icon, and up to 2 sensors; supports weather entities with auto icons
- **Rain auto-disable** — if rain sensor exceeds configured mm threshold, schedule is automatically disabled (shown yellow)
- **Jojo/tank shutoff** — if tank level drops below configured %, all running zones are immediately switched off (shown red)
- **Drag-to-reorder zones** in settings
- **Searchable entity picker** for all entity fields
- **MDI icon picker** with live preview for info bar slots
- **Navigation** — tap the card title to navigate to any HA view
- **All Off** button cuts all zones in a single service call (no script dependency)
- **Fully configurable in UI** — no YAML editing needed after initial setup
- **HACS compatible**

---

## Screenshots

> Card with 4 info bar slots, 8 active zones, and schedule section

---

## Installation

### Via HACS (Recommended)

1. Open HACS → Frontend
2. Click the three-dot menu → **Custom repositories**
3. Add `HybridRCG/sprinkler-dash-card` as category **Lovelace**
4. Search for "Sprinkler Dash Card" and install
5. Clear browser cache / hard refresh

### Manual

1. Download `sprinkler-dash-card.js` from the [latest release](../../releases/latest)
2. Copy to `/config/www/sprinkler-dash-card.js`
3. Go to **Settings → Dashboards → Resources**
4. Add `/local/sprinkler-dash-card.js` as type **JavaScript Module**
5. Clear browser cache

---

## Card Configuration

Add the card to your dashboard (raw YAML editor):

```yaml
type: custom:sprinkler-dash-card-v2
```

That's it — all configuration is done via the ⚙️ settings panel on the card itself.

---

## Prerequisites

### Required: Scheduler Integration

Install the [Scheduler Component](https://github.com/nielsfaber/scheduler-component) via HACS (Integration category). After installing, create a schedule for `script.sprinkler` — the resulting `switch.schedule_*` entity is what the card controls.

### Required: Valve Duration Helpers

Create one `input_number` helper per zone in **Settings → Helpers → Add → Number**:

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

### Optional: Sprinkler Script

The **Start Schedule** button calls `script.sprinkler`. Create this script to run your zones sequentially using the valve duration helpers.

---

## Settings Panel

Tap the ⚙️ gear icon on the card to open settings:

### Active Zones
Set how many zones (1–10) are shown in the grid. Zones beyond the active count are hidden but their config is preserved.

### Zones — Drag to Reorder
Each zone has:
- **Name** — display label
- **Switch Entity** — searchable `switch.*` entity
- **Duration Entity** — searchable `input_number.*` entity

Drag the `⠿` handle to reorder. Dimmed zones are inactive (beyond the active count).

### Settings
| Field | Description |
|---|---|
| Nav path | Path to navigate when tapping the card title (e.g. `/lovelace`) |
| Rain limit | mm threshold above which schedule is auto-disabled |
| Jojo low % | Tank level % below which all zones are shut off |
| Rain sensor | Precipitation sensor entity |
| Weather | `weather.*` entity |
| Jojo sensor | Water tank litres sensor |
| Schedule sw | `switch.schedule_*` entity from Scheduler integration |

### Info Bar (4 Slots)
Each slot has:
- **Enable checkbox** — show/hide the slot; disabled slots collapse
- **Label** — text prefix shown in the info bar
- **Icon** — searchable MDI icon (e.g. `weather-rainy`, `water-well`); shown as `ha-icon`
- **Sensor 1** — primary sensor; `weather.*` entities render with emoji + temp
- **Sensor 2** — optional secondary sensor appended after Sensor 1

**Layout:**
- 1 enabled → full width
- 2 enabled → 50/50
- 3 enabled → 3 equal columns, single row
- 4 enabled → 2×2 grid

---

## Smart Logic

### Rain Auto-Disable
When the rain sensor value ≥ Rain limit (mm), the schedule switch is turned off automatically and the slot turns **yellow**. Re-enable via the Schedule toggle inside the card.

### Jojo Low-Level Shutoff
When `sensor.jojo_tank_level_liquid_level` (or whichever sensor is in Sensor 2 of the Jojo slot and contains `liquid_level`) drops below the configured **Jojo low %** (default 35%), all currently running zones are switched off immediately. The Jojo slot turns **red**.

---

## Changelog

| Version | Changes |
|---|---|
| v1.7.0 | Info bar slots have enable/disable checkbox; smart CSS grid layout (1→full, 2→50/50, 3→3-col, 4→2×2); 3-slot single row |
| v1.6.0 | 4 fully configurable info bar slots (label + icon + 2 sensors); Jojo low % configurable; nav_path persistence fixed |
| v1.5.0 | Max zones 10; entity search fixed (global style injection); Switch Entity + Duration Entity per zone; Copy readme button |
| v1.4.0 | Rain auto-disable schedule; Jojo level + % display; rain_threshold setting; jojo_sensor setting |
| v1.3.0 | Full settings panel: drag-to-reorder zones, active zone count, entity search, nav path, readme modal |
| v1.2.0 | Built-in scheduler section; progress bar driven by switch last_changed; duration updates adjust countdown live |
| v1.1.0 | All Off calls switches directly (no script); duration number input with +/- buttons; zone sequence numbers |
| v1.0.0 | Initial release: zone grid, toggles, duration controls, green gradient header |

---

## Support

- [Issues](../../issues)
- [Home Assistant Community](https://community.home-assistant.io)

---

## License

MIT © [HybridRCG](https://github.com/HybridRCG)
