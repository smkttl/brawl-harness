import { expect, it } from "vitest";
import { createSseParser } from "../shared/stream.js";

it("reassembles multi-byte chunks and several packets", () => {
  const values: string[] = [];
  const parse = createSseParser((value) => values.push(value));
  parse('data: {"text":"');
  parse("hello");
  parse('"}\n\ndata: {"text":"world"}\n\n');
  expect(values).toEqual(['{"text":"hello"}', '{"text":"world"}']);
});
