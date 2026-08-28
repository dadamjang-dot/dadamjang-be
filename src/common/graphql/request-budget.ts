import { GraphQLError, Kind, type FragmentDefinitionNode, type SelectionSetNode, type ValidationRule } from "graphql";

const maxAliases = 20;
const maxDepth = 12;
const maxFields = 250;

type RequestBudget = { aliases: number; fields: number };

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
      if (depth > maxDepth || budget.fields > maxFields || budget.aliases > maxAliases) return true;
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
      context.reportError(
        new GraphQLError("GraphQL operation exceeds the request budget", {
          nodes: definition,
          extensions: { code: "GRAPHQL_VALIDATION_FAILED" },
        }),
      );
    }
  },
});
