/**
 * ClimateAccessory — exposes your Kia's remote climate (HVAC) as an Apple
 * HomeKit Switch accessory.
 *
 * Apple Home UI:
 *   Tap the tile ON to start remote climate at your configured temperature.
 *   Tap the tile OFF to stop it.
 *   The tile shows whether remote climate is currently running.
 *
 * Siri commands (use your configured accessory name):
 *   "Hey Siri, turn on [Car Name] Climate"    → starts remote climate
 *   "Hey Siri, turn off [Car Name] Climate"   → stops remote climate
 *   "Hey Siri, is [Car Name] Climate on?"     → checks status
 *
 * For "Heat my car up" / "Cool my car down" via Siri, create Siri Shortcuts:
 *   Shortcut "Heat my car" → "Control Home" → turn on this switch
 *   Shortcut "Cool my car" → "Control Home" → turn on this switch
 *
 * Note on EV6 remote climate: the car starts the HVAC at the configured target
 * temperature. If cabin temp < target → it heats; if cabin temp > target → it
 * cools. Kia Connect allows a maximum runtime of 10 minutes per activation.
 */

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KiaConnectPlatform } from '../platform';
import { KiaConfig, VehicleStatus } from '../kiaClient';

export class ClimateAccessory {
  private readonly service: Service;

  /** Shadow state served to HomeKit GET requests */
  private isOn: boolean = false;

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
      .setCharacteristic(Characteristic.SerialNumber, `${vin}-climate`)
      .setCharacteristic(Characteristic.FirmwareRevision, String(year));

    this.service =
      accessory.getService(Service.Switch) ??
      accessory.addService(Service.Switch);

    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.service
      .getCharacteristic(Characteristic.On)
      .onGet(this.getOn.bind(this))
      .onSet(this.setOn.bind(this));
  }

  // -------------------------------------------------------------------------
  // HomeKit GET
  // -------------------------------------------------------------------------

  private getOn(): CharacteristicValue {
    this.platform.log.debug('[Climate %s] GET On → %s', this.vin, this.isOn);
    return this.isOn;
  }

  // -------------------------------------------------------------------------
  // HomeKit SET
  // -------------------------------------------------------------------------

  private async setOn(value: CharacteristicValue): Promise<void> {
    const on = value as boolean;
    this.isOn = on;   // optimistic update

    if (on) {
      const temp = this.config.climateTemperatureCelsius;
      this.platform.log.info(
        '[Climate %s] Starting remote climate at %d°C (10 min max)',
        this.vin,
        temp,
      );
      await this.platform.kiaClient.startClimate(this.vin, {
        temperatureCelsius: temp,
      });
    } else {
      this.platform.log.info('[Climate %s] Stopping remote climate', this.vin);
      await this.platform.kiaClient.stopClimate(this.vin);
    }

    // Schedule a real status check to confirm the command
    this.platform.schedulePostCommandRefresh(this.vin);
  }

  // -------------------------------------------------------------------------
  // Called by the platform after each background status poll
  // -------------------------------------------------------------------------

  updateFromStatus(status: VehicleStatus): void {
    if (status.climateActive === undefined) return;

    this.isOn = status.climateActive;
    this.service.updateCharacteristic(this.platform.Characteristic.On, this.isOn);

    this.platform.log.debug(
      '[Climate %s] Status update → climate %s',
      this.vin,
      this.isOn ? 'RUNNING' : 'OFF',
    );
  }
}
