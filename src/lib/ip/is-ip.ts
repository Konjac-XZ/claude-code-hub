import ipaddr from "ipaddr.js";

/**
 * Edge-safe equivalent for the `node:net` isIP helper.
 *
 * Returns 4 for IPv4, 6 for IPv6, and 0 for invalid input.
 */
export function isIP(ip: string): 0 | 4 | 6 {
  if (ip.includes("%")) return 0;
  if (ipaddr.IPv4.isValidFourPartDecimal(ip)) return 4;
  if (ipaddr.IPv6.isValid(ip)) return 6;
  return 0;
}
