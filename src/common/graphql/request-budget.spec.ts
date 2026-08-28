import { buildSchema, parse, validate } from "graphql";
import { requestBudgetRule } from "./request-budget";

const schema = buildSchema(`
  type Query { root: Node }
  type Node { child: Node, value: String }
`);

const validateQuery = (query: string) => validate(schema, parse(query), [requestBudgetRule]);

describe("requestBudgetRule", () => {
  it("rejects excessive aliases, depth, and fields", () => {
    const aliases = Array.from({ length: 21 }, (_, index) => `field${index}: root { value }`).join("\n");
    const nested = Array.from({ length: 12 }, () => "child {").join(" ");
    const closings = Array.from({ length: 12 }, () => "}").join(" ");
    const fields = Array.from({ length: 251 }, () => "value").join("\n");

    expect(validateQuery(`query Aliases { ${aliases} }`)).toHaveLength(1);
    expect(validateQuery(`query Depth { root { ${nested} value ${closings} } }`)).toHaveLength(1);
    expect(validateQuery(`query Fields { root { ${fields} } }`)).toHaveLength(1);
  });

  it("accepts a normal operation", () => {
    expect(validateQuery("query Normal { root { child { value } } }")).toEqual([]);
  });
});
