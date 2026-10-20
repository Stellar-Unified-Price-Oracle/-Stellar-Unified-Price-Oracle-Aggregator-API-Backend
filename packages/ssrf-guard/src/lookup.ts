import dns from 'dns';
import { SsrfError, SsrfReason } from './errors';
import { isPrivateIp } from './ranges';
import { SsrfPolicy } from './policy';

export type LookupFunction = (
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family: number,
  ) => void,
) => void;

export interface SecureLookupOptions {
  /** Read the policy on every resolution so runtime config changes apply. */
  getPolicy: () => SsrfPolicy;
  /**
   * Invoked when a resolution is refused. The callback receives only the
   * caller's own host and the addresses it produced, so it is safe to log or
   * surface.
   */
  onBlocked?: (info: { host: string; addresses: string[]; reason: SsrfReason }) => void;
  /**
   * Addresses previously approved for a hostname (e.g. by a pre-flight
   * validation step). When supplied, the lookup pins to these addresses and
   * refuses any answer that differs, so a DNS change between validation and
   * connect cannot redirect the socket.
   */
  pinnedAddresses?: (hostname: string) => string[] | undefined;
  /**
   * Invoked after a successful resolution with the addresses that were
   * approved, so callers can record the pin for the connection's lifetime.
   */
  onResolved?: (info: { host: string; addresses: string[] }) => void;
}

/**
 * DNS lookup for outbound sockets.
 *
 * It resolves every address for the hostname, drops any that falls in a
 * private / loopback / link-local / metadata range, and hands the socket a
 * single surviving address. That is the pinning step: the address the policy
 * approved is the address the connection uses, so a hostname that resolves
 * differently a millisecond later cannot be used, and a DNS answer that points
 * at 169.254.169.254 never reaches a socket.
 *
 * net.js calls this in two modes. With `all: true` — what it uses when
 * `autoSelectFamily` (Happy Eyeballs) is on, the default since Node 20 — it
 * expects the full array back; otherwise a single address. The result must
 * match the requested mode, or every request fails with ERR_INVALID_IP_ADDRESS
 * before reaching the socket.
 */
export function createSecureLookup(options: SecureLookupOptions): LookupFunction {
  return function secureLookup(
    hostname: string,
    lookupOptions: dns.LookupOptions,
    callback: (
      err: NodeJS.ErrnoException | null,
      address: string | dns.LookupAddress[],
      family: number,
    ) => void,
  ): void {
    dns.lookup(hostname, { ...lookupOptions, all: true }, (err, addresses) => {
      if (err) {
        callback(err, '', 0);
        return;
      }

      const list = addresses as dns.LookupAddress[];
      const allowPrivateIps = options.getPolicy().allowPrivateIps ?? false;
      const safe = allowPrivateIps ? list : list.filter((a) => !isPrivateIp(a.address));

      if (safe.length === 0) {
        options.onBlocked?.({
          host: hostname,
          addresses: list.map((a) => a.address),
          reason: 'dns-rebinding',
        });
        const blocked = new SsrfError(
          `All resolved addresses for "${hostname}" are in a private range`,
          hostname,
          'dns-rebinding',
        ) as NodeJS.ErrnoException;
        callback(blocked, '', 0);
        return;
      }

      // Pin to previously approved addresses. If the hostname now resolves to
      // anything outside the approved set, treat it as a rebinding attempt:
      // the answer changed between validation and connect.
      const pinned = options.pinnedAddresses?.(hostname);
      if (pinned && pinned.length > 0) {
        const pinnedSet = new Set(pinned);
        const drifted = safe.filter((a) => !pinnedSet.has(a.address));
        if (drifted.length > 0) {
          options.onBlocked?.({
            host: hostname,
            addresses: list.map((a) => a.address),
            reason: 'dns-rebinding',
          });
          const blocked = new SsrfError(
            `Resolved addresses for "${hostname}" changed after validation`,
            hostname,
            'dns-rebinding',
          ) as NodeJS.ErrnoException;
          callback(blocked, '', 0);
          return;
        }

        const pinnedResults = safe.filter((a) => pinnedSet.has(a.address));
        options.onResolved?.({ host: hostname, addresses: pinnedResults.map((a) => a.address) });
        if (lookupOptions?.all) {
          callback(null, pinnedResults, 0);
          return;
        }
        callback(null, pinnedResults[0].address, pinnedResults[0].family);
        return;
      }

      options.onResolved?.({ host: hostname, addresses: safe.map((a) => a.address) });

      if (lookupOptions?.all) {
        callback(null, safe, 0);
        return;
      }

      callback(null, safe[0].address, safe[0].family);
    });
  };
}
