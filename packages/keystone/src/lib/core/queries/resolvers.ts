import { GraphQLResolveInfo } from 'graphql';
import { FindManyArgsValue, ItemRootValue, KeystoneContext, OrderDirection } from '../../../types';
import { checkOperationAccess, getAccessFilters } from '../access-control';
import {
  PrismaFilter,
  resolveUniqueWhereInput,
  resolveWhereInput,
  UniqueInputFilter,
  InputFilter,
} from '../where-inputs';
import { limitsExceededError } from '../graphql-errors';
import { InitialisedList } from '../types-for-lists';
import { getDBFieldKeyForFieldOnMultiField, runWithPrisma } from '../utils';

// doing this is a result of an optimisation to skip doing a findUnique and then a findFirst(where the second one is done with access control)
// we want to do this explicit mapping because:
// - we are passing the values into a normal where filter and we want to ensure that fields cannot do non-unique filters(we don't do validation on non-unique wheres because prisma will validate all that)
// - for multi-field unique indexes, we need to a mapping because iirc findFirst/findMany won't understand the syntax for filtering by multi-field unique indexes(which makes sense and is correct imo)
export function mapUniqueWhereToWhere(uniqueWhere: UniquePrismaFilter): PrismaFilter {
  // inputResolvers.uniqueWhere validates that there is only one key
  const key = Object.keys(uniqueWhere)[0];
  return { [key]: uniqueWhere[key] };
}

export async function accessControlledFilter(
  list: InitialisedList,
  context: KeystoneContext,
  resolvedWhere: PrismaFilter,
  accessFilters: boolean | InputFilter
) {
  // Run access control
  // KS_SYSTEM_ERROR
  const access = await validateNonCreateListAccessControl({
    access: list.access.read,
    args: { context, listKey: list.listKey, operation: 'read', session: context.session },
  });
  // KS_ACCESS_DENIED
  if (access === false) {
    throw accessDeniedError();
  }

  // Merge declarative access control
  // No expected errors
  if (typeof access === 'object') {
    resolvedWhere = { AND: [resolvedWhere, await resolveWhereInput(access, list, context)] };
  }

  return resolvedWhere;
}

export async function findOne(
  args: { where: UniqueInputFilter },
  list: InitialisedList,
  context: KeystoneContext
) {
  // maybe KS_USER_INPUT_ERROR
  const uniqueWhere = await resolveUniqueWhereInput(args.where, list.fields, context);

  // No expected errors
  const resolvedWhere = mapUniqueWhereToWhere(uniqueWhere);

  // Maybe KS_ACCESS_DENIED, KS_SYSTEM_ERROR
  const filter = await accessControlledFilter(list, context, resolvedWhere);

  // Maybe KS_PRISMA_ERROR
  return runWithPrisma(context, list, model => model.findFirst({ where: filter }));
}

export async function findMany(
  { where, take, skip, orderBy: rawOrderBy }: FindManyArgsValue,
  list: InitialisedList,
  context: KeystoneContext,
  info: GraphQLResolveInfo,
  extraFilter?: PrismaFilter
): Promise<ItemRootValue[]> {
  // Maybe KS_BAD_USER_INPUT
  // Would we like to check anything else here for user input? first/skip non-negative?
  const orderBy = await resolveOrderBy(rawOrderBy, list, context);

  // Maybe KS_LIMITS_EXCEEDED
  applyEarlyMaxResults(take, list);

  // No expected errors
  let resolvedWhere = await resolveWhereInput(where || {}, list, context);

  // Maybe KS_ACCESS_DENIED, KS_SYSTEM_ERROR
  let filter = await accessControlledFilter(list, context, resolvedWhere);

  // Inject the extra filter if we're coming from a relationship query
  if (extraFilter) {
    filter = { AND: [filter, extraFilter] };
  }

  // Maybe KS_PRISMA_ERROR
  const results = await runWithPrisma(context, list, model =>
    model.findMany({ where: filter, orderBy, take: take ?? undefined, skip })
  );

  // Maybe KS_LIMITS_EXCEEDED
  applyMaxResults(results, list, context);

  if (info.cacheControl && list.cacheHint) {
    info.cacheControl.setCacheHint(
      list.cacheHint({ results, operationName: info.operation.name?.value, meta: false }) as any
    );
  }
  // Result gets passed to field resolvers
  return results;
}

async function resolveOrderBy(
  orderBy: readonly Record<string, any>[],
  list: InitialisedList,
  context: KeystoneContext
): Promise<readonly Record<string, OrderDirection>[]> {
  return await Promise.all(
    orderBy.map(async orderBySelection => {
      const keys = Object.keys(orderBySelection);
      if (keys.length !== 1) {
        throw userInputError(
          `Only a single key must be passed to ${list.types.orderBy.graphQLType.name}`
        );
      }

      const fieldKey = keys[0];
      const value = orderBySelection[fieldKey];
      if (value === null) {
        throw userInputError('null cannot be passed as an order direction');
      }

      const field = list.fields[fieldKey];
      const resolve = field.input!.orderBy!.resolve;
      const resolvedValue = resolve ? await resolve(value, context) : value;
      if (field.dbField.kind === 'multi') {
        const keys = Object.keys(resolvedValue);
        if (keys.length !== 1) {
          throw userInputError(
            `Only a single key must be returned from an orderBy input resolver for a multi db field`
          );
        }
        const innerKey = keys[0];
        return {
          [getDBFieldKeyForFieldOnMultiField(fieldKey, innerKey)]: resolvedValue[innerKey],
        };
      } else {
        return { [fieldKey]: resolvedValue };
      }
    })
  );
}

export async function count(
  { where }: { where: Record<string, any> },
  list: InitialisedList,
  context: KeystoneContext,
  info: GraphQLResolveInfo,
  extraFilter?: PrismaFilter
) {
  // No expected errors
  let resolvedWhere = await resolveWhereInput(where || {}, list, context);

  // Maybe KS_ACCESS_DENIED, KS_SYSTEM_ERROR
  let filter = await accessControlledFilter(list, context, resolvedWhere);

  // Inject the extra filter if we're coming from a relationship query
  if (extraFilter) {
    filter = { AND: [filter, extraFilter] };
  }

  // Maybe KS_PRISMA_ERROR
  const count = await runWithPrisma(context, list, model => model.count({ where: filter }));

  if (info.cacheControl && list.cacheHint) {
    info.cacheControl.setCacheHint(
      list.cacheHint({
        results: count,
        operationName: info.operation.name?.value,
        meta: true,
      }) as any
    );
  }
  return count;
}

function applyEarlyMaxResults(_take: number | null | undefined, list: InitialisedList) {
  const take = Math.abs(_take ?? Infinity);
  // We want to help devs by failing fast and noisily if limits are violated.
  // Unfortunately, we can't always be sure of intent.
  // E.g., if the query has a "take: 10", is it bad if more results could come back?
  // Maybe yes, or maybe the dev is just paginating posts.
  // But we can be sure there's a problem in two cases:
  // * The query explicitly has a "first" that exceeds the limit
  // * The query has no "first", and has more results than the limit
  if (take < Infinity && take > list.maxResults) {
    throw limitsExceededError({
      listKey: list.listKey,
      type: 'maxResults',
      limit: list.maxResults,
    });
  }
}

function applyMaxResults(results: unknown[], list: InitialisedList, context: KeystoneContext) {
  if (results.length > list.maxResults) {
    throw limitsExceededError({
      listKey: list.listKey,
      type: 'maxResults',
      limit: list.maxResults,
    });
  }
  if (context) {
    context.totalResults += results.length;
    if (context.totalResults > context.maxTotalResults) {
      throw limitsExceededError({
        listKey: list.listKey,
        type: 'maxTotalResults',
        limit: context.maxTotalResults,
      });
    }
  }
}
