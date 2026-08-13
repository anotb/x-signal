export function validateTunnelId(value: string): string;
export function validateApiKey(value: string): string;
export function configureSecureTunnel(options?: {
  root?: string;
  tunnelId?: string;
  apiKey?: string;
}): {
  envFile: string;
  secretFile: string;
  hasApiKey: boolean;
  tunnelIdConfigured: boolean;
};
export function inspectSecureTunnel(options?: { root?: string }): {
  status: "ok";
  tunnelIdConfigured: true;
  apiKeyConfigured: true;
};
