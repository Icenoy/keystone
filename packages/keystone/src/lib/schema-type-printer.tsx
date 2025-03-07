import {
  GraphQLSchema,
  parse,
  TypeNode,
  ListTypeNode,
  NamedTypeNode,
  GraphQLScalarType,
  EnumTypeDefinitionNode,
  InputObjectTypeDefinitionNode,
  ObjectTypeDefinitionNode,
  FieldDefinitionNode,
  InputValueDefinitionNode,
} from 'graphql';
import prettier from 'prettier';
import { getGqlNames } from '../types';
import { InitialisedList } from './core/types-for-lists';

let printEnumTypeDefinition = (node: EnumTypeDefinitionNode) => {
  return `export type ${node.name.value} =\n${node
    .values!.map(x => `  | ${JSON.stringify(x.name.value)}`)
    .join('\n')};`;
};

function printInputTypesFromSchema(
  schema: string,
  schemaObj: GraphQLSchema,
  scalars: Record<string, string>
) {
  let ast = parse(schema);
  let printTypeNodeWithoutNullable = (node: ListTypeNode | NamedTypeNode): string => {
    if (node.kind === 'ListType') {
      return `ReadonlyArray<${printTypeNode(node.type)}> | ${printTypeNode(node.type)}`;
    }
    let name = node.name.value;
    if (schemaObj.getType(name) instanceof GraphQLScalarType) {
      if (scalars[name] === undefined) {
        return 'any';
      }
      return `Scalars[${JSON.stringify(name)}]`;
    }
    return name;
  };
  let printTypeNode = (node: TypeNode): string => {
    if (node.kind === 'NonNullType') {
      return printTypeNodeWithoutNullable(node.type);
    }
    return `${printTypeNodeWithoutNullable(node)} | null`;
  };
  let printInputObjectTypeDefinition = (node: InputObjectTypeDefinitionNode) => {
    let str = `export type ${node.name.value} = {\n`;
    node.fields?.forEach(node => {
      str += `  readonly ${node.name.value}${
        node.type.kind === 'NonNullType' && !node.defaultValue ? '' : '?'
      }: ${printTypeNode(node.type)};\n`;
    });
    str += '};';
    return str;
  };
  let typeString = 'type Scalars = {\n';
  for (let scalar in scalars) {
    typeString += `  readonly ${scalar}: ${scalars[scalar]};\n`;
  }
  typeString += '};';
  for (const node of ast.definitions) {
    if (node.kind === 'InputObjectTypeDefinition') {
      typeString += '\n\n' + printInputObjectTypeDefinition(node);
    }
    if (node.kind === 'EnumTypeDefinition') {
      typeString += '\n\n' + printEnumTypeDefinition(node);
    }
  }
  return { printedTypes: typeString + '\n', ast, printTypeNode };
}

export function printGeneratedTypes(
  printedSchema: string,
  graphQLSchema: GraphQLSchema,
  lists: Record<string, InitialisedList>
) {
  let scalars = {
    ID: 'string',
    Boolean: 'boolean',
    String: 'string',
    Int: 'number',
    Float: 'number',
    JSON: 'import("@keystone-next/keystone/types").JSONValue',
  };

  let prelude = `import {
  KeystoneListsAPI as GenericKeystoneListsAPI,
  KeystoneDbAPI as GenericKeystoneDbAPI,
  KeystoneContext as GenericKeystoneContext,
} from '@keystone-next/keystone/types';
`;

  let { printedTypes, ast, printTypeNode } = printInputTypesFromSchema(
    printedSchema,
    graphQLSchema,
    scalars
  );

  printedTypes += '\n';

  let allListsStr = '\nexport type KeystoneListsTypeInfo = {';

  let queryTypeName = graphQLSchema.getQueryType()!.name;

  let queryNode = ast.definitions.find((node): node is ObjectTypeDefinitionNode => {
    return node.kind === 'ObjectTypeDefinition' && node.name.value === queryTypeName;
  });

  if (!queryNode) {
    throw new Error('Query type on GraphQL schema not found when generating types');
  }

  let queryNodeFieldsByName: Record<string, FieldDefinitionNode> = {};

  for (const field of queryNode.fields!) {
    queryNodeFieldsByName[field.name.value] = field;
  }

  let printArgs = (args: readonly InputValueDefinitionNode[]) => {
    let types = '{\n';
    for (const arg of args) {
      if (arg.name.value === 'search') continue;
      types += `  readonly ${arg.name.value}${
        arg.type.kind === 'NonNullType' && !arg.defaultValue ? '' : '?'
      }: ${printTypeNode(arg.type)};\n`;
    }
    return types + '}';
  };

  for (const [listKey, list] of Object.entries(lists)) {
    const gqlNames = getGqlNames(list);
    let listTypeInfoName = `${listKey}ListTypeInfo`;
    const listQuery = queryNodeFieldsByName[gqlNames.listQueryName];
    printedTypes += `
export type ${listTypeInfoName} = {
  key: ${JSON.stringify(listKey)};
  fields: ${Object.keys(list.fields)
    .map(x => JSON.stringify(x))
    .join('|')}
  backing: import(".prisma/client").${listKey};
  inputs: {
    where: ${gqlNames.whereInputName};
    uniqueWhere: ${gqlNames.whereUniqueInputName};
    create: ${gqlNames.createInputName};
    update: ${gqlNames.updateInputName};
  };
  args: {
    listQuery: ${
      listQuery
        ? printArgs(listQuery.arguments!)
        : 'import("@keystone-next/keystone/types").BaseGeneratedListTypes["args"]["listQuery"]'
    }
  };
};

export type ${listKey}ListFn = (
  listConfig: import('@keystone-next/keystone').ListConfig<${listTypeInfoName}, ${listTypeInfoName}['fields']>
) => import('@keystone-next/keystone').ListConfig<${listTypeInfoName}, ${listTypeInfoName}['fields']>;
`;
    allListsStr += `\n  readonly ${JSON.stringify(listKey)}: ${listTypeInfoName};`;
  }
  allListsStr += '\n};';

  const postlude = `
export type KeystoneListsAPI = GenericKeystoneListsAPI<KeystoneListsTypeInfo>;
export type KeystoneDbAPI = GenericKeystoneDbAPI<KeystoneListsTypeInfo>;

export type KeystoneContext = Omit<GenericKeystoneContext, 'db' | 'lists' | 'prisma'> & {
  db: { lists: KeystoneDbAPI };
  lists: KeystoneListsAPI;
  prisma: import('.prisma/client').PrismaClient;
};
`;
  return prettier.format(prelude + printedTypes + allListsStr + postlude, {
    parser: 'babel-ts',
    trailingComma: 'es5',
    singleQuote: true,
  });
}
