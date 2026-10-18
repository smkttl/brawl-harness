import { describe, expect, it } from "vitest";
import { createSseParser } from "./stream.js";

describe("createSseParser", () => {
  it("reassembles packets split across arbitrary stream chunks", () => {
    const values: string[] = [];
    const parse = createSseParser((value) => values.push(value));
    parse('data: {"type":"one"');
    parse('}\n');
    parse('\ndata: [DONE]\n\n');
    expect(values).toEqual(['{"type":"one"}', "[DONE]"]);
  });

  it("flushes a final packet without a trailing blank line", () => {
    const values: string[] = [];
    const parse = createSseParser((value) => values.push(value));
    parse("data: last", true);
    expect(values).toEqual(["last"]);
  });
});
