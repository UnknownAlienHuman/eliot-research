import { describe, expect, it } from "vitest";
import worker from "./index.js";

describe("worker export", () => {
  it("exposes fetch, queue and scheduled handlers", () => {
    expect(typeof worker.fetch).toBe("function");
    expect(typeof worker.queue).toBe("function");
    expect(typeof worker.scheduled).toBe("function");
  });
});
