/**
 * KiaClient — a rate-limit-aware wrapper around the `bluelinky` npm library.
 *
 * Kia Connect (brand: 'kia') connects to Kia's own servers (us.kia.com / owners.kia.com).
 * This is entirely separate from Hyundai BlueLink even though the same bluelinky library
 * handles both brands — when `brand` is set to 'kia', only Kia Connect API endpoints
 * are used.
 *
 * Rate limits (community-documented):
 *   US:  ~30 API calls/day total
 *   EU:  ~200 API calls/day
 *   CA:  ~30 calls/day + must wait ≥90s between vehicle commands
 *
 * This client:
 *   - Caches the last-known vehicle status in memory
 *   - Throttles status refreshes to respect daily limits
 *   - Tracks approximate daily call usage and warns when approaching the limit
 *   - Wraps lock/unlock/startClimate/stopClimate with error handling
 */

import BlueLinky from 'bluelinky';
import { Logger } from 'homebridge';
import { DAILY_LIMITS, DAILY_LIMIT_WARN_FRACTION, MIN_REFRESH_INTERVAL_MS } from './settings';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface KiaConfig {
  username: string;
  password: string;
  pin: string;
  region: 'US' | 'CA' | 'EU' | 'AU';
  vehicleId?: string;
  pollIntervalMinutes: number;
  climateTemperatureCelsius: number;
  lowBatteryThreshold: number;
}

/**
 * Normalised vehicle status — fields mapped from bluelinky's parsed output.
 * All fields are optional so the accessory code can handle partial data
 * gracefully when the API returns incomplete responses.
 */
export interface VehicleStatus {
  /** Whether all doors are locked */
  doorLock?: boolean;
  /** Whether the remote climate/HVAC system is currently running */
  climateActive?: boolean;
  /** State of charge as a percentage 0–100 */
  batteryChargePct?: number;
  /** Whether the car is currently charging */
  isCharging?: boolean;
  /** Whether the charge port is plugged in */
  isPluggedIn?: boolean;
  /** Estimated range in km */
  rangeKm?: number;
  /** Raw timestamp of when this status was fetched */
  fetchedAt: number;
}

export interface VehicleInfo {
  vin: string;
  name: string;
  model: string;
  year: number;
}

export interface ClimateOptions {
  temperatureCelsius: number;
  heating?: boolean;
  defrost?: boolean;
}

// ---------------------------------------------------------------------------
// KiaClient implementation
// ---------------------------------------------------------------------------

export class KiaClient {
  private client!: InstanceType<typeof BlueLinky>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private vehicles: Map<string, any> = new Map();
  private statusCache: Map<string, VehicleStatus> = new Map();
  private lastRefreshTime: Map<string, number> = new Map();
  private readyPromise: Promise<void>;
  private readyResolve!: () => void;
  private readyReject!: (err: Error) => void;

  /** Tracks approximate number of API calls made today */
  private dailyCallCount = 0;
  private callCountResetAt: Date = this.todayMidnight();

  constructor(
    private readonly config: KiaConfig,
    private readonly log: Logger,
  ) {
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });
    this.initClient();
  }

  // -------------------------------------------------------------------------
  // Initialisation
  // -------------------------------------------------------------------------

  private initClient(): void {
    this.log.info(
      '[KiaClient] Connecting to Kia Connect API (region: %s, account: %s)',
      this.config.region,
      this.config.username,
    );

    this.client = new BlueLinky({
      username: this.config.username,
      password: this.config.password,
      brand: 'kia',               // explicitly Kia Connect, not Hyundai BlueLink
      // bluelinky types only list US/CA/EU but AU is supported at runtime
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      region: this.config.region as any,
      pin: this.config.pin,
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.client.on('ready', (vehicleList: any[]) => {
      this.log.info('[KiaClient] Connected to Kia Connect. Found %d vehicle(s).', vehicleList.length);

      for (const v of vehicleList) {
        const vin = (v.vehicleConfig?.vin ?? v.vin ?? '').toUpperCase();
        if (vin) {
          this.vehicles.set(vin, v);
          this.log.info('[KiaClient] Vehicle registered: %s (%s %s)', vin, v.vehicleConfig?.year ?? '', v.vehicleConfig?.nickname ?? v.vehicleConfig?.modelName ?? '');
        }
      }

      this.readyResolve();
    });

    this.client.on('error', (err: Error) => {
      this.log.error('[KiaClient] Authentication error: %s', err.message);
      this.readyReject(err);
    });
  }

  /** Wait until the bluelinky client has authenticated and is ready. */
  async waitForReady(): Promise<void> {
    return this.readyPromise;
  }

  // -------------------------------------------------------------------------
  // Vehicle discovery
  // -------------------------------------------------------------------------

  getVehicleVins(): string[] {
    return Array.from(this.vehicles.keys());
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getVehicleByVin(vin: string): any {
    const v = this.vehicles.get(vin);
    if (!v) {
      throw new Error(`Vehicle ${vin} not found. Available: ${Array.from(this.vehicles.keys()).join(', ')}`);
    }
    return v;
  }

  getVehicleInfo(vin: string): VehicleInfo {
    const v = this.getVehicleByVin(vin);
    const cfg = v.vehicleConfig ?? {};
    return {
      vin,
      name: cfg.nickname ?? cfg.modelName ?? 'Kia EV',
      model: cfg.modelName ?? 'EV6',
      year: cfg.year ?? new Date().getFullYear(),
    };
  }

  // -------------------------------------------------------------------------
  // Status / caching
  // -------------------------------------------------------------------------

  /** Return the most recently cached status without triggering an API call. */
  getCachedStatus(vin: string): VehicleStatus | null {
    return this.statusCache.get(vin) ?? null;
  }

  /**
   * Refresh vehicle status from the Kia Connect cloud.
   *
   * By default (`forceCar = false`) this reads the cloud cache — fast, cheap,
   * and does NOT wake or poll the car directly (no 12V drain).
   *
   * When `forceCar = true` the car is polled directly for a live reading.
   * This is slow (~30s), costs an extra API call, and can drain the 12V battery
   * if called too frequently.
   */
  async refreshStatus(vin: string, forceCar = false): Promise<VehicleStatus | null> {
    this.resetDailyCountIfNeeded();

    const dailyLimit = DAILY_LIMITS[this.config.region] ?? 30;
    if (this.dailyCallCount >= dailyLimit) {
      this.log.warn(
        '[KiaClient] Daily API call limit (%d) reached for region %s. Serving cached status.',
        dailyLimit,
        this.config.region,
      );
      return this.getCachedStatus(vin);
    }

    const lastRefresh = this.lastRefreshTime.get(vin) ?? 0;
    const timeSinceLast = Date.now() - lastRefresh;
    if (timeSinceLast < MIN_REFRESH_INTERVAL_MS) {
      this.log.debug(
        '[KiaClient] Skipping refresh for %s — last refresh was %ds ago (minimum %ds).',
        vin,
        Math.round(timeSinceLast / 1000),
        MIN_REFRESH_INTERVAL_MS / 1000,
      );
      return this.getCachedStatus(vin);
    }

    try {
      const vehicle = this.getVehicleByVin(vin);
      this.log.debug('[KiaClient] Refreshing status for %s (forceCar=%s)', vin, forceCar);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const raw: any = await vehicle.status({ parsed: true, refresh: forceCar });
      this.trackApiCall(vin, 'status');

      const status = this.parseStatus(raw);
      this.statusCache.set(vin, status);
      this.lastRefreshTime.set(vin, Date.now());

      this.log.debug(
        '[KiaClient] %s — locked=%s climate=%s battery=%s%% range=%skm',
        vin,
        status.doorLock,
        status.climateActive,
        status.batteryChargePct,
        status.rangeKm,
      );

      return status;
    } catch (err) {
      this.log.error('[KiaClient] Failed to refresh status for %s: %s', vin, (err as Error).message);
      return this.getCachedStatus(vin);
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private parseStatus(raw: any): VehicleStatus {
    const evStatus = raw?.evStatus ?? raw?.evInfo ?? null;

    // Range: bluelinky may return unit 0 = km, unit 1 = miles
    let rangeKm: number | undefined;
    const drvDist = evStatus?.drvDistance?.[0];
    if (drvDist) {
      const range = drvDist.rangeByFuel?.totalAvailableRange ?? drvDist.rangeByFuel?.evModeRange;
      if (range?.value !== undefined) {
        // unit 0 = km, unit 1 = miles — normalise to km
        rangeKm = range.unit === 1 ? Math.round(range.value * 1.60934) : range.value;
      }
    }

    return {
      doorLock: raw?.doorLock ?? undefined,
      climateActive: raw?.airCtrlOn ?? raw?.climate?.active ?? undefined,
      batteryChargePct: evStatus?.batteryStatus ?? evStatus?.batteryStatus?.stateOfCharge ?? undefined,
      isCharging: evStatus?.batteryCharge ?? (evStatus?.plugStatus === true ? true : undefined),
      isPluggedIn: evStatus?.batteryPlugin !== undefined ? evStatus.batteryPlugin !== 0 : undefined,
      rangeKm,
      fetchedAt: Date.now(),
    };
  }

  // -------------------------------------------------------------------------
  // Remote commands
  // -------------------------------------------------------------------------

  async lock(vin: string): Promise<void> {
    await this.executeCommand(vin, 'lock', async (vehicle) => {
      await vehicle.lock();
    });
  }

  async unlock(vin: string): Promise<void> {
    await this.executeCommand(vin, 'unlock', async (vehicle) => {
      await vehicle.unlock();
    });
  }

  async startClimate(vin: string, options: ClimateOptions): Promise<void> {
    await this.executeCommand(vin, 'startClimate', async (vehicle) => {
      await vehicle.start({
        hvac: true,
        heating: options.heating ? 1 : 0,
        temperature: options.temperatureCelsius,
        defrost: options.defrost ?? false,
        windshieldHeating: options.defrost ?? false,
        duration: 10,   // max allowed by Kia Connect (10 minutes)
      });
    });
  }

  async stopClimate(vin: string): Promise<void> {
    await this.executeCommand(vin, 'stopClimate', async (vehicle) => {
      await vehicle.stop();
    });
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async executeCommand(vin: string, name: string, fn: (v: any) => Promise<void>): Promise<void> {
    this.resetDailyCountIfNeeded();
    const dailyLimit = DAILY_LIMITS[this.config.region] ?? 30;

    if (this.dailyCallCount >= dailyLimit) {
      const msg = `Daily API limit (${dailyLimit}) reached — cannot execute '${name}'. Try again tomorrow.`;
      this.log.error('[KiaClient] %s', msg);
      throw new Error(msg);
    }

    const vehicle = this.getVehicleByVin(vin);
    this.log.info('[KiaClient] Executing command "%s" for %s', name, vin);

    try {
      await fn(vehicle);
      this.trackApiCall(vin, name);
      this.log.info('[KiaClient] Command "%s" sent successfully to %s', name, vin);
    } catch (err) {
      this.log.error('[KiaClient] Command "%s" failed for %s: %s', name, vin, (err as Error).message);
      throw err;
    }
  }

  private trackApiCall(vin: string, action: string): void {
    this.dailyCallCount++;
    const limit = DAILY_LIMITS[this.config.region] ?? 30;
    this.log.debug('[KiaClient] API call #%d/%d today (%s on %s)', this.dailyCallCount, limit, action, vin);

    if (this.dailyCallCount >= Math.floor(limit * DAILY_LIMIT_WARN_FRACTION)) {
      this.log.warn(
        '[KiaClient] Approaching daily API limit: %d/%d calls used today (region: %s). ' +
        'Consider increasing pollIntervalMinutes in config to avoid hitting the limit.',
        this.dailyCallCount,
        limit,
        this.config.region,
      );
    }
  }

  private resetDailyCountIfNeeded(): void {
    const now = new Date();
    if (now >= this.callCountResetAt) {
      this.log.debug('[KiaClient] Resetting daily API call count (was %d).', this.dailyCallCount);
      this.dailyCallCount = 0;
      this.callCountResetAt = this.todayMidnight();
      this.callCountResetAt.setDate(this.callCountResetAt.getDate() + 1);
    }
  }

  private todayMidnight(): Date {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }
}
