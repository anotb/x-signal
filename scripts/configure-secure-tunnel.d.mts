export function validateTunnelId(value: string): string;
export function validateOrganizationId(value: string): string;
export function validateApiKey(value: string): string;
export function configureSecureTunnel(options?: {
  root?: string;
  tunnelId?: string;
  organizationId?: string;
  apiKey?: string;
}): {
  envFile: string;
  secretFile: string;
  hasApiKey: boolean;
  tunnelIdConfigured: boolean;
  organizationIdConfigured: boolean;
};
export function inspectSecureTunnel(options?: { root?: string }): {
  status: "ok";
  tunnelIdConfigured: true;
  organizationIdConfigured: true;
  apiKeyConfigured: true;
};
