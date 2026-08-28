import type { ApolloDriverConfig } from "@nestjs/apollo";
import {
  GraphQLError,
  Kind,
  getOperationAST,
  type ASTNode,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationRule,
  type ValueNode,
} from "graphql";

const maxAliases = 20;
const maxDepth = 12;
const maxFields = 250;
const maxCardinality = 100;
const cardinalityNames = new Set(["first", "last", "limit", "pageSize", "take"]);

type RequestBudget = { aliases: number; fields: number };
type RequestBudgetPlugin = NonNullable<ApolloDriverConfig["plugins"]>[number];

const requestBudgetError = (nodes?: ASTNode | readonly ASTNode[]) =>
  new GraphQLError("GraphQL operation exceeds the request budget", {
    ...(nodes ? { nodes } : {}),
    extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
  });

const valueExceedsBudget = (value: ValueNode, name?: string): boolean => {
  if (value.kind === Kind.LIST)
    return value.values.length > maxCardinality || value.values.some((item) => valueExceedsBudget(item));
  if (value.kind === Kind.OBJECT)
    return value.fields.some((field) => valueExceedsBudget(field.value, field.name.value));
  return value.kind === Kind.INT && !!name && cardinalityNames.has(name) && Number(value.value) > maxCardinality;
};

const variableValueExceedsBudget = (value: unknown, name?: string): boolean => {
  if (Array.isArray(value))
    return value.length > maxCardinality || value.some((item) => variableValueExceedsBudget(item));
  if (typeof value === "object" && value !== null)
    return Object.entries(value).some(([field, item]) => variableValueExceedsBudget(item, field));
  return typeof value === "number" && !!name && cardinalityNames.has(name) && value > maxCardinality;
};

const variableCardinalityExceedsBudget = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  activeFragments: Set<string>,
  variables: Readonly<Record<string, unknown>>,
): boolean => {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      if (
        selection.arguments?.some((argument) => {
          if (!cardinalityNames.has(argument.name.value) || argument.value.kind !== Kind.VARIABLE) return false;
          const value = variables[argument.value.name.value];
          return typeof value === "number" && value > maxCardinality;
        })
      )
        return true;
      if (
        selection.selectionSet &&
        variableCardinalityExceedsBudget(selection.selectionSet, fragments, activeFragments, variables)
      )
        return true;
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (variableCardinalityExceedsBudget(selection.selectionSet, fragments, activeFragments, variables)) return true;
      continue;
    }
    if (activeFragments.has(selection.name.value)) continue;
    const fragment = fragments.get(selection.name.value);
    if (!fragment) continue;
    activeFragments.add(selection.name.value);
    const exceeded = variableCardinalityExceedsBudget(fragment.selectionSet, fragments, activeFragments, variables);
    activeFragments.delete(selection.name.value);
    if (exceeded) return true;
  }
  return false;
};

const exceedsBudget = (
  selectionSet: SelectionSetNode,
  fragments: ReadonlyMap<string, FragmentDefinitionNode>,
  activeFragments: Set<string>,
  budget: RequestBudget,
  depth: number,
): boolean => {
  for (const selection of selectionSet.selections) {
    if (selection.kind === Kind.FIELD) {
      budget.fields += 1;
      if (selection.alias) budget.aliases += 1;
      if (
        depth > maxDepth ||
        budget.fields > maxFields ||
        budget.aliases > maxAliases ||
        selection.arguments?.some((argument) => valueExceedsBudget(argument.value, argument.name.value))
      )
        return true;
      if (
        selection.selectionSet &&
        exceedsBudget(selection.selectionSet, fragments, activeFragments, budget, depth + 1)
      )
        return true;
      continue;
    }
    if (selection.kind === Kind.INLINE_FRAGMENT) {
      if (exceedsBudget(selection.selectionSet, fragments, activeFragments, budget, depth)) return true;
      continue;
    }
    if (activeFragments.has(selection.name.value)) continue;
    const fragment = fragments.get(selection.name.value);
    if (!fragment) continue;
    activeFragments.add(selection.name.value);
    const exceeded = exceedsBudget(fragment.selectionSet, fragments, activeFragments, budget, depth);
    activeFragments.delete(selection.name.value);
    if (exceeded) return true;
  }
  return false;
};

export const requestBudgetRule: ValidationRule = (context) => ({
  Document: (document) => {
    const fragments = new Map(
      document.definitions
        .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
        .map((fragment) => [fragment.name.value, fragment]),
    );
    for (const definition of document.definitions) {
      if (definition.kind !== Kind.OPERATION_DEFINITION) continue;
      if (!exceedsBudget(definition.selectionSet, fragments, new Set(), { aliases: 0, fields: 0 }, 1)) continue;
      context.reportError(requestBudgetError(definition));
    }
  },
});

export const requestBudgetPlugin: RequestBudgetPlugin = {
  requestDidStart: async () => ({
    didResolveOperation: async ({ request, document, operationName }) => {
      if (variableValueExceedsBudget(request.variables)) throw requestBudgetError();
      const operation = getOperationAST(document, operationName);
      if (!operation) return;
      const fragments = new Map(
        document.definitions
          .filter((definition): definition is FragmentDefinitionNode => definition.kind === Kind.FRAGMENT_DEFINITION)
          .map((fragment) => [fragment.name.value, fragment]),
      );
      if (variableCardinalityExceedsBudget(operation.selectionSet, fragments, new Set(), request.variables ?? {}))
        throw requestBudgetError(operation);
    },
  }),
};
