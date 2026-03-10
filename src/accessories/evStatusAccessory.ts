/**
 * EvStatusAccessory — exposes your Kia EV's high-voltage battery state and
 * estimated range in Apple HomeKit.
 *
 * Two services are added to a single accessory:
 *
 * 1. Service.Battery
 *    - BatteryLevel (0–100 %)          → reports HV battery state-of-charge
 *    - StatusLowBattery                → alerts when SOC < configured threshold
 *    - ChargingState                   → shows Charging / Not Charging / Not Chargeable
 *
 *    Siri: "Hey Siri, what's the battery level of [Car Name] Battery?"
 *          "Hey Siri, is [Car Name] Battery charging?"
 *
 * 2. Service.LightSensor  (repurposed for range readout)
 *    HomeKit's LightSensor reports CurrentAmbientLightLevel in lux.
 *    We use lux = range in km. Light sensor lux ranges 0.0001–100 000 lux
 *    which comfortably covers EV range values (0–600 km).
 *    The accessory is named "[Car Name] Range (km)" to make the value obvious.
 *
 *    Siri: "Hey Siri, what's the brightness of [Car Name] Range?"
 *          → "About 312 lux" which the user maps to "312 km of range".
 *
 *    Alternatively, use the Home app or Eve app to see the numeric value
 *    without the lux mapping confusion.
 *
 * Note: read-only — no commands are sent from this accessory.
 */

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KiaConnectPlatform } from '../platform';
import { KiaConfig, VehicleStatus } from '../kiaClient';

/** Minimum lux value accepted by HomeKit's LightSensor characteristic. */
const MIN_LUX = 0.0001;

export class EvStatusAccessory {
  private readonly batteryService: Service;
  private readonly rangeSensorService: Service;

  private batteryPct: number = 50;
  private isCharging: boolean = false;
  private isPluggedIn: boolean = false;
  private rangeKm: number = 0;

  constructor(
    private readonly platform: KiaConnectPlatform,
    accessory: PlatformAccessory,
    private readonly vin: string,
    modelName: string,
    year: number,
    private readonly config: KiaConfig,
  ) {
    const { Service, Characteristic } = platform;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Kia')
      .setCharacteristic(Characteristic.Model, modelName)
      .setCharacteristic(Characteristic.SerialNumber, `${vin}-ev`)
      .setCharacteristic(Characteristic.FirmwareRevision, String(year));

    // ------------------------------------------------------------------
    // Service 1: Battery
    // ------------------------------------------------------------------
    this.batteryService =
      accessory.getService(Service.Battery) ??
      accessory.addService(Service.Battery, `${accessory.displayName}`, `${vin}-battery`);

    this.batteryService.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.batteryService
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(this.getBatteryLevel.bind(this));

    this.batteryService
      .getCharacteristic(Characteristic.ChargingState)
      .onGet(this.getChargingState.bind(this));

    this.batteryService
      .getCharacteristic(Characteristic.StatusLowBattery)
      .onGet(this.getStatusLowBattery.bind(this));

    // ------------------------------------------------------------------
    // Service 2: LightSensor (range in km, mapped to lux)
    // ------------------------------------------------------------------
    // Sub-type string keeps it distinct from other LightSensor services
    this.rangeSensorService =
      accessory.getService(Service.LightSensor) ??
      accessory.addService(
        Service.LightSensor,
        `${accessory.displayName.replace('Battery', 'Range')} (km)`,
        `${vin}-range`,
      );

    this.rangeSensorService.setCharacteristic(
      Characteristic.Name,
      `${accessory.displayName.replace('Battery', 'Range')} (km)`,
    );

    this.rangeSensorService
      .getCharacteristic(Characteristic.CurrentAmbientLightLevel)
      .onGet(this.getRangeAsLux.bind(this));
  }

  // -------------------------------------------------------------------------
  // HomeKit GET handlers
  // -------------------------------------------------------------------------

  private getBatteryLevel(): CharacteristicValue {
    this.platform.log.debug('[EVStatus %s] GET BatteryLevel → %d%%', this.vin, this.batteryPct);
    return this.batteryPct;
  }

  private getChargingState(): CharacteristicValue {
    const { Characteristic } = this.platform;
    if (this.isCharging) return Characteristic.ChargingState.CHARGING;
    if (this.isPluggedIn) return Characteristic.ChargingState.NOT_CHARGING;
    return Characteristic.ChargingState.NOT_CHARGEABLE;
  }

  private getStatusLowBattery(): CharacteristicValue {
    const { Characteristic } = this.platform;
    const isLow = this.batteryPct < this.config.lowBatteryThreshold;
    return isLow
      ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
      : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL;
  }

  private getRangeAsLux(): CharacteristicValue {
    // HomeKit requires lux >= 0.0001; we use km as lux (0 → 0.0001 minimum)
    const lux = Math.max(MIN_LUX, this.rangeKm);
    this.platform.log.debug('[EVStatus %s] GET Range → %d km (reported as %d lux)', this.vin, this.rangeKm, lux);
    return lux;
  }

  // -------------------------------------------------------------------------
  // Called by the platform after each background status poll
  // -------------------------------------------------------------------------

  updateFromStatus(status: VehicleStatus): void {
    const { Characteristic } = this.platform;

    let changed = false;

    if (status.batteryChargePct !== undefined) {
      this.batteryPct = Math.max(0, Math.min(100, status.batteryChargePct));
      this.batteryService.updateCharacteristic(Characteristic.BatteryLevel, this.batteryPct);
      this.batteryService.updateCharacteristic(
        Characteristic.StatusLowBattery,
        this.batteryPct < this.config.lowBatteryThreshold
          ? Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
          : Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
      );
      changed = true;
    }

    if (status.isCharging !== undefined) {
      this.isCharging = status.isCharging;
      changed = true;
    }
    if (status.isPluggedIn !== undefined) {
      this.isPluggedIn = status.isPluggedIn;
      changed = true;
    }
    if (changed) {
      this.batteryService.updateCharacteristic(Characteristic.ChargingState, this.getChargingState());
    }

    if (status.rangeKm !== undefined) {
      this.rangeKm = status.rangeKm;
      this.rangeSensorService.updateCharacteristic(
        Characteristic.CurrentAmbientLightLevel,
        Math.max(MIN_LUX, this.rangeKm),
      );
    }

    this.platform.log.debug(
      '[EVStatus %s] Status update → %d%% SOC, %s, range %d km',
      this.vin,
      this.batteryPct,
      this.isCharging ? 'CHARGING' : this.isPluggedIn ? 'PLUGGED-IN (not charging)' : 'UNPLUGGED',
      this.rangeKm,
    );
  }
}
