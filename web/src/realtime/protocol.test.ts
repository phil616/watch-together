import { describe, expect, it } from "vitest";
import { parseEnvelope } from "./protocol";
describe("protocol parser", () => {
  it("accepts v1", () =>
    expect(parseEnvelope('{"v":1,"type":"ack"}').type).toBe("ack"));
  it("rejects another version", () =>
    expect(() => parseEnvelope('{"v":2,"type":"ack"}')).toThrow());
  it("rejects malformed messages", () =>
    expect(() => parseEnvelope("[]")).toThrow());
});
