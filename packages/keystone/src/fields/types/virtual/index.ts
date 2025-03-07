import {
  BaseGeneratedListTypes,
  graphql,
  ItemRootValue,
  CommonFieldConfig,
  FieldTypeFunc,
  fieldType,
  ListInfo,
} from '../../../types';
import { resolveView } from '../../resolve-view';

type VirtualFieldGraphQLField = graphql.Field<ItemRootValue, any, any, string>;

export type VirtualFieldConfig<TGeneratedListTypes extends BaseGeneratedListTypes> =
  CommonFieldConfig<TGeneratedListTypes> & {
    field:
      | VirtualFieldGraphQLField
      | ((lists: Record<string, ListInfo>) => VirtualFieldGraphQLField);
    unreferencedConcreteInterfaceImplementations?: graphql.ObjectType<any>[];
    graphQLReturnFragment?: string;
  };

export const virtual =
  <TGeneratedListTypes extends BaseGeneratedListTypes>({
    graphQLReturnFragment = '',
    field,
    ...config
  }: VirtualFieldConfig<TGeneratedListTypes>): FieldTypeFunc =>
  meta => {
    const usableField = typeof field === 'function' ? field(meta.lists) : field;

    return fieldType({
      kind: 'none',
    })({
      ...config,
      output: graphql.field({
        ...(usableField as any),
        resolve({ item }, ...args) {
          return usableField.resolve!(item as any, ...args);
        },
      }),
      views: resolveView('virtual/views'),
      getAdminMeta: () => ({ graphQLReturnFragment }),
    });
  };
