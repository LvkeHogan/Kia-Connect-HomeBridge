# homebridge-kia-connect

A HomeBridge plugin that brings your **Kia EV** (EV6, EV9, Niro EV, etc.) into Apple Home and Siri via **Kia Connect** (owners.kia.com).

> **Note:** This plugin uses the Kia Connect API exclusively. It is not related to Hyundai BlueLink — both systems are supported by the underlying `bluelinky` library, but setting `brand: 'kia'` routes all calls to Kia's own servers.

---

## Features

| What you get | How it works in HomeKit |
|---|---|
| **Lock / Unlock** | Lock Mechanism tile — tap to lock or unlock; Siri: *"Lock my EV6"* |
| **Remote Climate** | Switch tile — tap ON to start HVAC at your target temp; tap OFF to stop; max 10 min per session |
| **Battery Level** | Battery service — shows HV SOC%; low-battery alert at your configured threshold |
| **Estimated Range** | Light Sensor service (lux = km) — readable in the Home app and Eve app |
| **Charging State** | Part of the Battery tile — shows Charging / Plugged in / Unplugged |

### Siri commands

| Voice command | What happens |
|---|---|
| *"Lock my [car name]"* | Locks the vehicle |
| *"Unlock my [car name]"* | Unlocks the vehicle |
| *"Turn on [car name] Climate"* | Starts remote climate at your configured temperature |
| *"Turn off [car name] Climate"* | Stops remote climate |
| *"What's the battery level of [car name] Battery?"* | Reports HV battery % |
| *"What's the brightness of [car name] Range?"* | Reports range in km (as lux) |

For **"Heat my car up"** and **"Cool my car down"**, create [Siri Shortcuts](https://support.apple.com/en-gb/guide/shortcuts/welcome/ios) that trigger the Climate switch. The EV6 automatically heats or cools to your target temperature.

---

## Requirements

- [HomeBridge](https://homebridge.io) ≥ 1.6.0
- Node.js ≥ 18
- An active **Kia Connect** subscription (owners.kia.com)
- Your Kia Connect **email**, **password**, and **PIN**

---

## Installation

```bash
npm install -g homebridge-kia-connect
```

Or install via the [HomeBridge UI](https://github.com/homebridge/homebridge-config-ui-x) by searching for **homebridge-kia-connect**.

---

## Configuration

Add a platform entry to your HomeBridge `config.json`:

```json
{
  "platforms": [
    {
      "platform": "KiaConnect",
      "name": "Kia Connect",
      "username": "you@example.com",
      "password": "your-password",
      "pin": "1234",
      "region": "US",
      "pollIntervalMinutes": 60,
      "climateTemperatureCelsius": 22,
      "lowBatteryThreshold": 20,
      "modelName": "EV6"
    }
  ]
}
```

### Configuration options

| Field | Required | Default | Description |
|---|---|---|---|
| `username` | ✅ | — | Email for owners.kia.com |
| `password` | ✅ | — | Password for owners.kia.com |
| `pin` | ✅ | — | 4-digit Kia Connect PIN |
| `region` | ✅ | `"US"` | `US`, `CA`, `EU`, or `AU` |
| `vehicleId` | — | *(first vehicle)* | VIN of your vehicle (required if you have multiple vehicles on the account) |
| `pollIntervalMinutes` | — | `60` | How often to refresh status from the cloud. **See rate limits below.** |
| `climateTemperatureCelsius` | — | `22` | Target cabin temperature when remote climate starts |
| `lowBatteryThreshold` | — | `20` | SOC% below which the battery tile shows a low-battery alert |
| `modelName` | — | `"EV6"` | Display name for your model in Apple Home |

---

## API rate limits

Kia Connect enforces daily API call limits (community-documented):

| Region | Daily limit | Recommended `pollIntervalMinutes` |
|---|---|---|
| US | ~30 calls/day | **60** (gives ~24 polls/day, leaves headroom for commands) |
| CA | ~30 calls/day + 90s between commands | **60** |
| EU | ~200 calls/day | 30 or higher |
| AU | ~200 calls/day | 30 or higher |

**Setting `pollIntervalMinutes` too low will exhaust your daily quota.** When the limit is approached, the plugin logs a warning and serves the last cached status.

### 12V battery drain

Status fetched with `refresh: false` (the default) reads the **Kia Connect cloud cache** — it does not wake or poll the car directly. This is kind to your 12V auxiliary battery. Direct car polling (`forceCar: true`) is only used internally after a remote command to confirm it worked.

---

## How accessories are structured

For each vehicle the plugin creates three accessories:

```
[Car Name] Lock       — Service.LockMechanism
[Car Name] Climate    — Service.Switch
[Car Name] Battery    — Service.Battery + Service.LightSensor (range)
```

The Battery accessory contains two services in one tile:
- **Battery** tab: SOC %, charging state, low-battery status
- **Range sensor** tab: estimated range in km (reported as lux value)

---

## Troubleshooting

**"No vehicles found"** — Log in to owners.kia.com in a browser and confirm your account has a registered vehicle with Remote Services enabled.

**Commands failing** — Verify your PIN is correct. For CA region, note the 90-second mandatory wait between vehicle commands.

**"Daily API limit reached"** — Increase `pollIntervalMinutes` or wait until midnight for the counter to reset.

**Status not updating** — The plugin caches status and enforces a 1-minute minimum between refreshes. Check HomeBridge logs for `[KiaClient]` entries.

---

## Development

```bash
git clone https://github.com/LvkeHogan/Kia-Connect-HomeBridge.git
cd Kia-Connect-HomeBridge
npm install
npm run build      # compile TypeScript → dist/
npm run watch      # watch mode
```

---

## Licence

GPL-3.0 — see [LICENSE](LICENSE).
