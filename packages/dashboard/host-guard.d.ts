export function hostGuard(hostHeader: string | undefined | null): boolean
export function isHostAllowed(hostHeader: string | undefined | null): boolean
export function getTailscaleDnsName(now?: number): string | null
export function clearTailscaleDnsCache(): void
export function getCustomDashboardHosts(): string[]
export default hostGuard
