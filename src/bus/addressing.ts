import { isValidSlug, SLUG_RULES } from '../domain/slug.js';
import { BusError } from './errors.js';

/**
 * Splits and validates an address: `connection/handle` or `workspace/connection/handle`
 * (ADR 0003, ADR 0006). Resolution against the workspace happens in the bus.
 */
export function parseAddress(raw: string): string[] {
  const address = raw.trim().toLowerCase();
  if (address.includes('@')) {
    throw new BusError(
      'invalid_address',
      `"${raw}": "@" is reserved for future federation and is not supported. Address agents as "connection/handle", e.g. "grok-build/researcher".`,
    );
  }
  const parts = address.split('/');
  if (parts.length === 1 && isValidSlug(address)) {
    throw new BusError(
      'invalid_address',
      `"${raw}" is missing a handle. Address an agent as "connection/handle", e.g. "${address}/researcher". Call list_connections to see known handles.`,
    );
  }
  if (parts.length < 2 || parts.length > 3 || parts.some((p) => !isValidSlug(p))) {
    throw new BusError(
      'invalid_address',
      `"${raw}" is not a valid address. Use "connection/handle" (e.g. "grok-build/researcher") or "workspace/connection/handle", where each part is ${SLUG_RULES}. Call list_connections to see valid addresses.`,
    );
  }
  return parts;
}

export function formatAddress(connection: string, handle: string): string {
  return `${connection}/${handle}`;
}
