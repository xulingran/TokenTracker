export function normalizeHostname(value: unknown): string;
export function isLoopbackHostname(value: unknown): boolean;
export function isPrivateNetworkHostname(value: unknown): boolean;
export function normalizeInstanceUrl(value: unknown, options?: { allowPrivateHttp?: boolean }): string | null;
