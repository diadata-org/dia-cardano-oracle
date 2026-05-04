/** Client artifact identity used in paths and labels. */
export function assertClientIdNonEmpty(clientId: string): void {
  if (!clientId.trim()) {
    throw new Error("Client id must be a non-empty string.");
  }
}
