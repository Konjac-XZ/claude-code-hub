import { describe, expect, test } from "vitest";
import { isIP } from "./is-ip";

describe("isIP", () => {
  test.each([
    ["1.2.3.4", 4],
    ["255.255.255.255", 4],
    ["01.2.3.4", 0],
    ["256.2.3.4", 0],
    ["2001:db8::1", 6],
    ["::ffff:192.168.0.1", 6],
    ["fe80::1%eth0", 0],
    ["not-an-ip", 0],
    ["", 0],
  ])("%s -> %s", (input, expected) => {
    expect(isIP(input)).toBe(expected);
  });
});
