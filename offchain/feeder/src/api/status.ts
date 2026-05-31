// Status API builders.
//
//   GET /api/v1/status           — high-level feeder health snapshot
//   GET /api/v1/status/components — per-component health details

import type { ModularConfig } from "../config/types.js";
import type { ChainStateRow, Db } from "../persistence/index.js";

export type StatusResponse = {
  status: string;
  uptime_seconds: number;
  network: string;
  db_driver: string;
  cron_enabled: boolean;
  scanner: {
    last_scan_block: number;
    is_healthy: boolean;
  };
};

export type ComponentStatus = {
  name: string;
  healthy: boolean;
  last_check_ms: number;
};

export type StatusOptions = {
  config: ModularConfig;
  db: Db;
  uptime: number;
  network: string;
  cronEnabled: boolean;
  chainStates?: ChainStateRow[];
};

export function buildStatusResponse(options: StatusOptions): StatusResponse {
  const { config, uptime, network, cronEnabled, chainStates } = options;
  const dbDriver = config.infrastructure?.database?.driver ?? "sqlite";

  let lastScanBlock = 0;
  let isHealthy = true;

  if (chainStates && chainStates.length > 0) {
    const latest = chainStates.reduce((best, row) =>
      row.lastScanBlock > best.lastScanBlock ? row : best,
    );
    lastScanBlock = Number(latest.lastScanBlock);
    isHealthy = latest.isHealthy;
  }

  return {
    status: "ok",
    uptime_seconds: Math.floor(uptime / 1000),
    network,
    db_driver: dbDriver,
    cron_enabled: cronEnabled,
    scanner: {
      last_scan_block: lastScanBlock,
      is_healthy: isHealthy,
    },
  };
}

export type ComponentsOptions = {
  config: ModularConfig;
  db: Db;
  chainStates: ChainStateRow[];
};

export function buildComponentsResponse(options: ComponentsOptions): ComponentStatus[] {
  const { chainStates } = options;

  const components: ComponentStatus[] = [];

  if (chainStates.length > 0) {
    const latest = chainStates.reduce((best, row) =>
      row.updatedAtMs > best.updatedAtMs ? row : best,
    );
    components.push({
      name: "scanner",
      healthy: latest.isHealthy,
      last_check_ms: latest.lastHealthCheckMs ?? latest.updatedAtMs,
    });
  } else {
    components.push({
      name: "scanner",
      healthy: true,
      last_check_ms: 0,
    });
  }

  return components;
}
