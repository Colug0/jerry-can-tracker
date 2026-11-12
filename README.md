# jerry-can-tracker

A [Signal K](https://signalk.org) server plugin that keeps track of the jerry
cans on board. Group them into sets, for example *Diesel* and *Petrol*, and
each set appears in Signal K as one more tank, with its total capacity and
current volume. Instrument apps, dashboards and alarms then treat the cans
like any other tank.

A set can mix different cans, for example two 20 L and one 5 L can. A webapp
records which cans are full, empty or partly filled.

## Requirements

- Signal K server 2.x. Route access levels for the webapp need 2.35 or later
  (see [Access](#access)).
- Node.js 22 or later.

## Setup

1. Install **Jerry Can Tracker** from the Signal K App Store and enable it.
2. In **Server → Plugin Config → Jerry Can Tracker**, add a set for each group
   of cans:

| Setting | Meaning |
|---|---|
| Id | Last part of the Signal K path, unique across all sets. Letters, digits and `_`, starting with a letter. |
| Name | Tank name shown in apps, for example "Diesel jerry cans". |
| Tank kind | Signal K tank group: `fuel`, `freshWater`, `wasteWater`, `blackWater`, `lubrication`, `gas`, `ballast`, `liveWell`, `baitWell`. |
| Contents | Optional: published as the tank type (`diesel`, `petrol`, `fresh water`, …). |
| Cans | One line per kind of can: name, capacity in litres and how many identical cans there are. |

New cans start empty. Open the webapp to fill them.

## Signal K paths

Each set is published under `tanks.<kind>.<id>`, the same paths a tank sensor
uses. A set with kind `fuel` and id `dieselCans` gives:

| Path | Unit | Value |
|---|---|---|
| `tanks.fuel.dieselCans.name` | | Set name |
| `tanks.fuel.dieselCans.type` | | Contents, if set |
| `tanks.fuel.dieselCans.capacity` | m³ | Sum of all cans |
| `tanks.fuel.dieselCans.currentVolume` | m³ | Sum of what is in the cans |
| `tanks.fuel.dieselCans.currentLevel` | ratio | Volume divided by capacity |

Single cans are not published. The values change only when someone changes a
fill level, so the plugin marks them as event data: the server never treats
them as stale.

## Webapp

Open **Jerry Can Tracker** from the server's **Webapps** page. For each set it
shows the total and every can:

- **Fill all** / **Empty all** for the whole set.
- **Total … L → Set** spreads a volume over the cans in the configured order:
  the first cans are full, one is partly filled, the rest are empty.
- Per can: **Empty**, **Full**, or a slider in 5 % steps.

## Changing levels from other apps

Both paths accept a Signal K PUT, so dashboards, Node-RED or other apps can
set a set's level. The volume is spread over the cans in configured order, as
with **Set** in the webapp.

```
PUT /signalk/v1/api/vessels/self/tanks/fuel/dieselCans/currentVolume
{"value": 0.025}

PUT /signalk/v1/api/vessels/self/tanks/fuel/dieselCans/currentLevel
{"value": 0.5}
```

`currentVolume` is in m³ (0.025 = 25 L), `currentLevel` a ratio from 0 to 1.
Out-of-range values are answered at once with status 400. A valid value is
answered with `PENDING` and completes with status 200 once the new levels are
saved (follow the `href` in the answer); a failed save completes with 500 and
leaves the level unchanged.

### REST API

The webapp uses these routes under `/plugins/jerry-can-tracker`.
Volumes are in litres, levels are ratios from 0 to 1. Every answer is the
set as JSON (`id`, `name`, `path`, `capacity`, `volume`, `level`, `cans`).

| Route | Body |
|---|---|
| `GET /api/sets` | – lists all sets |
| `GET /api/sets/:id` | – |
| `POST /api/sets/:id/fill` | – |
| `POST /api/sets/:id/empty` | – |
| `POST /api/sets/:id/volume` | `{"volume": 25}` |
| `POST /api/sets/:id/cans/:key` | `{"level": 0.5}`; `key` comes from `GET /api/sets` |

### Access

From Signal K 2.35, reading needs read-only access and changing levels
read/write access. Older servers allow these routes for admins only.

## Where data is kept

- The sets are the plugin configuration.
- Fill levels are in `levels.json` in the plugin's data directory, so they
  survive restarts and updates, and changing them does not restart the
  plugin.
- Can keys follow the position in the configuration: reordering the can
  lines of a set moves the fill levels with the position, not with the can.

## License

MIT
