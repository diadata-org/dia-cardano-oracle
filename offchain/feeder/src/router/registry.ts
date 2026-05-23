// Router registry — collects enabled routers and indexes them by event
// name for O(1) lookup in the hot path.
//
// Spectra equivalent:
//   `pkg/router/generic_registry.go` (`RouterRegistry`).
//
// The registry is built once at startup from the loaded `ModularConfig`
// and is immutable thereafter. Any router with `enabled: false` is
// silently excluded so the dispatch loop never sees it.

import type { RouterConfig } from "../config/types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type RouterRegistry = {
  /** All enabled routers in definition order. */
  readonly all: RouterConfig[];
  /**
   * Routers whose `triggers.events` list includes `eventName`.
   * Returns an empty array (never throws) for unknown event names,
   * so the dispatch loop can iterate unconditionally.
   */
  forEvent(eventName: string): RouterConfig[];
  /** Count of enabled routers. */
  readonly size: number;
};

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Build a registry from the loaded config's router map. Routers with
 * `enabled: false` are excluded. The order of `all` matches the order
 * in which routers appear in the config map (insertion order).
 */
export function createRouterRegistry(
  routers: Record<string, RouterConfig>,
): RouterRegistry {
  const all: RouterConfig[] = Object.values(routers).filter((r) => r.enabled);

  // Build an event → router[] index over the enabled set.
  const byEvent = new Map<string, RouterConfig[]>();
  for (const router of all) {
    for (const eventName of router.triggers.events) {
      const list = byEvent.get(eventName);
      if (list) {
        list.push(router);
      } else {
        byEvent.set(eventName, [router]);
      }
    }
  }

  return {
    all,
    forEvent(eventName) {
      return byEvent.get(eventName) ?? [];
    },
    get size() {
      return all.length;
    },
  };
}
