export interface CloudRelaySettings {
  serverUrl: string;
  vaultId: string;
  vaultToken: string;
  adminToken: string;
  enabled: boolean;
}

export const DEFAULT_SETTINGS: CloudRelaySettings = {
  serverUrl: "",
  vaultId: "",
  vaultToken: "",
  adminToken: "",
  enabled: false,
};

export function parseInviteLink(
  link: string
): { serverUrl: string; vaultId: string; vaultToken: string } | null {
  const match = link.match(/^cloudrelay:\/\/join#s=(.+)&v=([^&]+)&k=(.+)$/);
  if (!match) return null;
  return { serverUrl: match[1], vaultId: match[2], vaultToken: match[3] };
}

export function buildInviteLink(settings: CloudRelaySettings): string {
  return `cloudrelay://join#s=${settings.serverUrl}&v=${settings.vaultId}&k=${settings.vaultToken}`;
}
