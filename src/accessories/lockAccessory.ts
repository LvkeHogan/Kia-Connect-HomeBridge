/**
 * LockAccessory — exposes your Kia's door locks as an Apple HomeKit
 * "Lock Mechanism" accessory.
 *
 * Apple Home UI:   Tap the tile to lock/unlock. Shows current lock state.
 * Siri commands:
 *   "Hey Siri, lock my [Car Name]"
 *   "Hey Siri, unlock my [Car Name]"
 *   "Hey Siri, is my [Car Name] locked?"
 */

import { Service, PlatformAccessory, CharacteristicValue } from 'homebridge';
import { KiaConnectPlatform } from '../platform';
import { VehicleStatus } from '../kiaClient';

export class LockAccessory {
  private readonly service: Service;

  /** In-memory shadow of current state — served immediately to HomeKit GET requests */
  private currentState: CharacteristicValue;
  private targetState: CharacteristicValue;

  constructor(
    private readonly platform: KiaConnectPlatform,
    accessory: PlatformAccessory,
    private readonly vin: string,
    modelName: string,
    year: number,
  ) {
    const { Service, Characteristic } = platform;

    // Accessory information
    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Kia')
      .setCharacteristic(Characteristic.Model, modelName)
      .setCharacteristic(Characteristic.SerialNumber, vin)
      .setCharacteristic(Characteristic.FirmwareRevision, String(year));

    // Default to SECURED so the car appears locked until we get real data
    this.currentState = Characteristic.LockCurrentState.SECURED;
    this.targetState = Characteristic.LockTargetState.SECURED;

    // Get or add the LockMechanism service
    this.service =
      accessory.getService(Service.LockMechanism) ??
      accessory.addService(Service.LockMechanism);

    this.service.setCharacteristic(Characteristic.Name, accessory.displayName);

    this.service
      .getCharacteristic(Characteristic.LockCurrentState)
      .onGet(this.getLockCurrentState.bind(this));

    this.service
      .getCharacteristic(Characteristic.LockTargetState)
      .onGet(this.getLockTargetState.bind(this))
      .onSet(this.setLockTargetState.bind(this));
  }

  // -------------------------------------------------------------------------
  // HomeKit GET handlers — served from in-memory cache
  // -------------------------------------------------------------------------

  private getLockCurrentState(): CharacteristicValue {
    this.platform.log.debug('[Lock %s] GET LockCurrentState → %s', this.vin, this.currentState);
    return this.currentState;
  }

  private getLockTargetState(): CharacteristicValue {
    return this.targetState;
  }

  // -------------------------------------------------------------------------
  // HomeKit SET handler — sends remote command to the car
  // -------------------------------------------------------------------------

  private async setLockTargetState(value: CharacteristicValue): Promise<void> {
    const { Characteristic } = this.platform;
    this.targetState = value;

    if (value === Characteristic.LockTargetState.SECURED) {
      this.platform.log.info('[Lock %s] Locking vehicle', this.vin);
      await this.platform.kiaClient.lock(this.vin);
      // Optimistically update current state while we wait for confirmation
      this.currentState = Characteristic.LockCurrentState.SECURED;
    } else {
      this.platform.log.info('[Lock %s] Unlocking vehicle', this.vin);
      await this.platform.kiaClient.unlock(this.vin);
      this.currentState = Characteristic.LockCurrentState.UNSECURED;
    }

    this.service.updateCharacteristic(Characteristic.LockCurrentState, this.currentState);

    // Schedule a real status check ~35s later to confirm the command
    this.platform.schedulePostCommandRefresh(this.vin);
  }

  // -------------------------------------------------------------------------
  // Called by the platform after each background status poll
  // -------------------------------------------------------------------------

  updateFromStatus(status: VehicleStatus): void {
    const { Characteristic } = this.platform;

    if (status.doorLock === undefined) return;

    this.currentState = status.doorLock
      ? Characteristic.LockCurrentState.SECURED
      : Characteristic.LockCurrentState.UNSECURED;

    this.targetState = status.doorLock
      ? Characteristic.LockTargetState.SECURED
      : Characteristic.LockTargetState.UNSECURED;

    this.service.updateCharacteristic(Characteristic.LockCurrentState, this.currentState);
    this.service.updateCharacteristic(Characteristic.LockTargetState, this.targetState);

    this.platform.log.debug(
      '[Lock %s] Status update → %s',
      this.vin,
      status.doorLock ? 'LOCKED' : 'UNLOCKED',
    );
  }
}
