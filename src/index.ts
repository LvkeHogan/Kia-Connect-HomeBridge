import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { KiaConnectPlatform } from './platform';

/**
 * This is the entry point that HomeBridge calls when it loads the plugin.
 * It registers the platform so HomeBridge knows how to instantiate it.
 */
export = (api: API): void => {
  api.registerPlatform(PLATFORM_NAME, KiaConnectPlatform);
};
