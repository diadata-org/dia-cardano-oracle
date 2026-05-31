// Events API builders.
//
//   GET /api/v1/events           — list processed events
//   GET /api/v1/events/names     — available event names
//   GET /api/v1/events/:hash     — single event by intent hash

import type { ProcessedEventRow } from "../persistence/index.js";

export type EventEntry = {
  intentHash: string;
  eventId?: string;
  eventName?: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  routerId: string;
  destinationIndex: number;
  status: string;
  filterReason?: string;
  processedAtMs: number;
};

export type EventsResponse = {
  count: number;
  events: EventEntry[];
};

export type EventNamesResponse = {
  names: string[];
};

function toEventEntry(row: ProcessedEventRow): EventEntry {
  return {
    intentHash: row.intentHash,
    eventId: row.eventId,
    eventName: row.eventName,
    txHash: row.txHash,
    logIndex: row.logIndex,
    blockNumber: row.blockNumber.toString(),
    routerId: row.routerId,
    destinationIndex: row.destinationIndex,
    status: row.status,
    filterReason: row.filterReason,
    processedAtMs: row.processedAtMs,
  };
}

export function buildEventsResponse(rows: ProcessedEventRow[]): EventsResponse {
  return {
    count: rows.length,
    events: rows.map(toEventEntry),
  };
}

export function buildEventNamesResponse(): EventNamesResponse {
  return { names: ["IntentRegistered"] };
}

export function buildEventByHashResponse(row: ProcessedEventRow | null): EventEntry | null {
  if (!row) return null;
  return toEventEntry(row);
}
