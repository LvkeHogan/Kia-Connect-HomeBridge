/**
 * KiaConnectPlatform — the main HomeBridge platform class.
 *
 * Responsibilities:
 *  - Reads config, validates it, and creates the KiaClient
 *  - Waits for the Kia Connect authentication to complete
 *  - Discovers vehicles and registers three accessories per vehicle:
 *      1. Lock/Unlock  (Service.LockMechanism)
 *      2. Climate      (Service.Switch)
 *      3. EV Status    (Service.Battery + Service.LightSensor for range)
 *  - Runs a background polling loop to keep status fresh
 *  - Implements configureAccessory() so cached accessories survive restarts
 */

import {
  API,
  DynamicPlatformPlugin,
  Logger,
  PlatformAccessory,
  PlatformConfig,
  Service,
  Characteristic,
} from 'homebridge';

import { PLATFORM_NAME, PLUGIN_NAME, POST_COMMAND_REFRESH_DELAY_MS } from './settings';
import { KiaClient, KiaConfig, VehicleStatus } from './kiaClient';
import { LockAccessory } from './accessories/lockAccessory';
import { ClimateAccessory } from './accessories/climateAccessory';
import { EvStatusAccessory } from './accessories/evStatusAccessory';

// Per-vehicle set of accessory handlers
interface VehicleAccessories {
  lock: LockAccessory;
  climate: ClimateAccessory;
  evStatus: EvStatusAccessory;
}

export class KiaConnectPlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  /** Accessories that HomeBridge has restored from its cache. */
  private readonly cachedAccessories: Map<string, PlatformAccessory> = new Map();
  /** Active accessory handler objects, keyed by VIN. */
  private readonly vehicleAccessories: Map<string, VehicleAccessories> = new Map();

  public readonly kiaClient: KiaClient;
  private readonly kiaConfig: KiaConfig;
  private pollTimer?: ReturnType<typeof setInterval>;

  constructor(
    public readonly log: Logger,
    public readonly config: PlatformConfig,
    public readonly api: API,
  ) {
    this.Service = this.api.hap.Service;
    this.Characteristic = this.api.hap.Characteristic;

    // Validate required config fields
    if (!config['username'] || !config['password'] || !config['pin']) {
      this.log.error(
        'homebridge-kia-connect: Missing required config fields (username, password, pin). ' +
        'Plugin will not start. Please check your HomeBridge config.',
      );
      // Provide a no-op KiaClient to satisfy TypeScript; the plugin won't function
      this.kiaConfig = this.buildKiaConfig();
      this.kiaClient = new KiaClient(this.kiaConfig, this.log);
      return;
    }

    this.kiaConfig = this.buildKiaConfig();
    this.kiaClient = new KiaClient(this.kiaConfig, this.log);

    // HomeBridge calls didFinishLaunching after it has restored cached accessories
    this.api.on('didFinishLaunching', () => {
      this.log.debug('didFinishLaunching');
      this.discoverVehicles();
    });

    this.log.debug('KiaConnectPlatform initialised');
  }

  // -------------------------------------------------------------------------
  // HomeBridge lifecycle — called for each accessory restored from cache
  // -------------------------------------------------------------------------

  configureAccessory(accessory: PlatformAccessory): void {
    this.log.debug('Loading cached accessory: %s (%s)', accessory.displayName, accessory.UUID);
    this.cachedAccessories.set(accessory.UUID, accessory);
  }

  // -------------------------------------------------------------------------
  // Vehicle discovery and accessory registration
  // -------------------------------------------------------------------------

  private async discoverVehicles(): Promise<void> {
    try {
      this.log.info('Connecting to Kia Connect (owners.kia.com) …');
      await this.kiaClient.waitForReady();
    } catch (err) {
      this.log.error(
        'Failed to connect to Kia Connect: %s\n' +
        'Check your username, password, PIN and region in the HomeBridge config.',
        (err as Error).message,
      );
      return;
    }

    const vins = this.kiaClient.getVehicleVins();
    if (vins.length === 0) {
      this.log.error('No vehicles found on this Kia Connect account.');
      return;
    }

    // If a specific VIN is configured, use only that vehicle
    const targetVins = this.kiaConfig.vehicleId
      ? vins.filter(v => v === this.kiaConfig.vehicleId?.toUpperCase())
      : vins;

    if (targetVins.length === 0) {
      this.log.error(
        'Configured vehicleId "%s" not found. Available VINs: %s',
        this.kiaConfig.vehicleId,
        vins.join(', '),
      );
      return;
    }

    for (const vin of targetVins) {
      this.registerVehicle(vin);
    }

    // Remove any cached accessories that no longer correspond to a vehicle
    for (const [uuid, accessory] of this.cachedAccessories) {
      if (!accessory.context.registered) {
        this.log.info('Removing stale cached accessory: %s', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.cachedAccessories.delete(uuid);
      }
    }

    // Start background polling
    this.startPolling();

    // Do an immediate status fetch for all registered vehicles
    for (const vin of targetVins) {
      this.refreshAndUpdate(vin);
    }
  }

  private registerVehicle(vin: string): void {
    const info = this.kiaClient.getVehicleInfo(vin);
    const modelName = this.kiaConfig.modelName || info.model;

    this.log.info(
      'Registering vehicle: %s %s %s (VIN: %s)',
      info.year,
      modelName,
      info.name,
      vin,
    );

    const lock = this.getOrCreateAccessory(`${vin}-lock`, `${info.name} Lock`);
    const climate = this.getOrCreateAccessory(`${vin}-climate`, `${info.name} Climate`);
    const evStatus = this.getOrCreateAccessory(`${vin}-ev-status`, `${info.name} Battery`);

    // Mark as registered so we know not to remove them
    lock.context.registered = true;
    climate.context.registered = true;
    evStatus.context.registered = true;

    // Store vehicle metadata in context for display
    [lock, climate, evStatus].forEach(acc => {
      acc.context.vin = vin;
      acc.context.modelName = modelName;
      acc.context.year = info.year;
    });

    const lockHandler = new LockAccessory(this, lock, vin, modelName, info.year);
    const climateHandler = new ClimateAccessory(this, climate, vin, modelName, info.year, this.kiaConfig);
    const evStatusHandler = new EvStatusAccessory(this, evStatus, vin, modelName, info.year, this.kiaConfig);

    this.vehicleAccessories.set(vin, {
      lock: lockHandler,
      climate: climateHandler,
      evStatus: evStatusHandler,
    });
  }

  // -------------------------------------------------------------------------
  // Accessory creation / cache lookup
  // -------------------------------------------------------------------------

  private getOrCreateAccessory(uniqueId: string, displayName: string): PlatformAccessory {
    const uuid = this.api.hap.uuid.generate(uniqueId);
    const existing = this.cachedAccessories.get(uuid);
    if (existing) {
      this.log.debug('Using cached accessory: %s', displayName);
      return existing;
    }

    this.log.debug('Creating new accessory: %s', displayName);
    const accessory = new this.api.platformAccessory(displayName, uuid);
    this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.cachedAccessories.set(uuid, accessory);
    return accessory;
  }

  // -------------------------------------------------------------------------
  // Background polling
  // -------------------------------------------------------------------------

  private startPolling(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
    }

    const intervalMs = this.kiaConfig.pollIntervalMinutes * 60 * 1000;
    this.log.info(
      'Starting status poll every %d minutes (%d API calls/day at this rate). ' +
      'Region %s daily limit: ~%d calls.',
      this.kiaConfig.pollIntervalMinutes,
      Math.round(1440 / this.kiaConfig.pollIntervalMinutes),
      this.kiaConfig.region,
      this.kiaConfig.region === 'EU' || this.kiaConfig.region === 'AU' ? 200 : 30,
    );

    this.pollTimer = setInterval(() => {
      for (const vin of this.vehicleAccessories.keys()) {
        this.refreshAndUpdate(vin);
      }
    }, intervalMs);
  }

  /**
   * Fetch fresh status from the Kia Connect cloud and push updates to all
   * accessories for that vehicle.
   */
  async refreshAndUpdate(vin: string, forceCar = false): Promise<void> {
    const status = await this.kiaClient.refreshStatus(vin, forceCar);
    if (status) {
      this.pushStatusToAccessories(vin, status);
    }
  }

  /**
   * Schedule a status refresh some time after a command is sent, to confirm
   * the command took effect without polling too eagerly.
   */
  schedulePostCommandRefresh(vin: string): void {
    setTimeout(() => {
      this.log.debug('Post-command status refresh for %s', vin);
      this.refreshAndUpdate(vin);
    }, POST_COMMAND_REFRESH_DELAY_MS);
  }

  private pushStatusToAccessories(vin: string, status: VehicleStatus): void {
    const accessories = this.vehicleAccessories.get(vin);
    if (!accessories) return;

    accessories.lock.updateFromStatus(status);
    accessories.climate.updateFromStatus(status);
    accessories.evStatus.updateFromStatus(status);
  }

  // -------------------------------------------------------------------------
  // Config helpers
  // -------------------------------------------------------------------------

  private buildKiaConfig(): KiaConfig {
    const region = (['US', 'CA', 'EU', 'AU'].includes(this.config['region'] as string)
      ? this.config['region']
      : 'US') as 'US' | 'CA' | 'EU' | 'AU';

    const pollInterval = Math.max(
      15,
      typeof this.config['pollIntervalMinutes'] === 'number'
        ? this.config['pollIntervalMinutes']
        : 60,
    );

    return {
      username: (this.config['username'] as string) ?? '',
      password: (this.config['password'] as string) ?? '',
      pin: (this.config['pin'] as string) ?? '',
      region,
      vehicleId: (this.config['vehicleId'] as string | undefined),
      pollIntervalMinutes: pollInterval,
      climateTemperatureCelsius: typeof this.config['climateTemperatureCelsius'] === 'number'
        ? this.config['climateTemperatureCelsius'] : 22,
      lowBatteryThreshold: typeof this.config['lowBatteryThreshold'] === 'number'
        ? this.config['lowBatteryThreshold'] : 20,
      modelName: (this.config['modelName'] as string | undefined),
    };
  }
}

// Extend KiaConfig to include modelName
declare module './kiaClient' {
  interface KiaConfig {
    modelName?: string;
  }
}
