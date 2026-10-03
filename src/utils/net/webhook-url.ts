import { lookup } from 'node:dns/promises';
import { BlockList } from 'node:net';

// This Code was written by Claude.
// It checks if a webhook URL is valid and points to a public address.
// It is used in the StoreService to validate webhook URLs before saving them to the database.

const blocked = new BlockList();
blocked.addSubnet('0.0.0.0', 8, 'ipv4');
blocked.addSubnet('10.0.0.0', 8, 'ipv4');
blocked.addSubnet('100.64.0.0', 10, 'ipv4');
blocked.addSubnet('127.0.0.0', 8, 'ipv4');
blocked.addSubnet('169.254.0.0', 16, 'ipv4');
blocked.addSubnet('172.16.0.0', 12, 'ipv4');
blocked.addSubnet('192.168.0.0', 16, 'ipv4');
blocked.addSubnet('224.0.0.0', 4, 'ipv4');
blocked.addSubnet('240.0.0.0', 4, 'ipv4');
blocked.addAddress('::', 'ipv6');
blocked.addAddress('::1', 'ipv6');
blocked.addSubnet('fc00::', 7, 'ipv6');
blocked.addSubnet('fe80::', 10, 'ipv6');
blocked.addSubnet('ff00::', 8, 'ipv6');

export async function webhookUrlProblem(raw: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'Webhook URL is not a valid URL.';
  }

  if (url.protocol !== 'https:') return 'Webhook URL must use https.';
  if (url.username || url.password) {
    return 'Webhook URL must not contain credentials.';
  }

  const host = url.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 literal brackets
  let addresses: { address: string; family: number }[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return 'Webhook host could not be resolved.';
  }

  for (const { address, family } of addresses) {
    if (blocked.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
      return 'Webhook URL must point to a public address.';
    }
  }
  return null;
}
