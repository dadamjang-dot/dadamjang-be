import type { ApolloServerPlugin } from "@apollo/server";
import { buildSchema, parse, validate } from "graphql";
import { requestBudgetRule } from "./request-budget";

const schema = buildSchema(`
  type Query { root(values: [Int!], first: Int): Node }
  type Node { child: Node, value: String }
`);

const validateQuery = (query: string) => validate(schema, parse(query), [requestBudgetRule]);
const requestBudgetPlugin = (jest.requireActual("./request-budget") as { requestBudgetPlugin?: ApolloServerPlugin })
  .requestBudgetPlugin;
const validateVariables = async (
  variables: Record<string, unknown>,
  source = "query Budget($first: Int) { root(first: $first) { value } }",
) => {
  const document = parse(source);
  const listener = await requestBudgetPlugin?.requestDidStart?.({ request: { variables } } as never);
  await listener?.didResolveOperation?.({ request: { variables }, document, operationName: null } as never);
};

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

  it("rejects literal list and cardinality arguments over 100", () => {
    const values = Array.from({ length: 101 }, () => "1").join(",");

    expect(validateQuery(`query List { root(values: [${values}]) { value } }`)).toHaveLength(1);
    expect(validateQuery("query Cardinality { root(first: 101) { value } }")).toHaveLength(1);
  });

  it("rejects variable list and cardinality values over 100", async () => {
    await expect(validateVariables({ input: { skus: Array.from({ length: 101 }, () => ({})) } })).rejects.toThrow(
      "GraphQL operation exceeds the request budget",
    );
    await expect(validateVariables({ first: 101 })).rejects.toThrow("GraphQL operation exceeds the request budget");
  });

  it("rejects a cardinality variable whose name differs from its argument", async () => {
    await expect(validateVariables({ n: 101 }, "query Budget($n: Int) { root(first: $n) { value } }")).rejects.toThrow(
      "GraphQL operation exceeds the request budget",
    );
  });

  it("accepts variable list and cardinality values at 100", async () => {
    await expect(
      validateVariables({ input: { skus: Array.from({ length: 100 }, () => ({})) }, first: 100 }),
    ).resolves.toBeUndefined();
  });
});
