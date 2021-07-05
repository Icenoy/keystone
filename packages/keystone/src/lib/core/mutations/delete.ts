import pLimit, { Limit } from 'p-limit';
import { DatabaseProvider, KeystoneContext } from '../../../types';
import { checkOperationAccess, getAccessFilters } from '../access-control';
import { accessDeniedError } from '../graphql-errors';
import { InitialisedList } from '../types-for-lists';
import { runWithPrisma } from '../utils';
import { InputFilter, resolveUniqueWhereInput, UniqueInputFilter } from '../where-inputs';
import { getAccessControlledItemForDelete } from './access-control';
import { runSideEffectOnlyHook } from './hooks';
import { validateDelete } from './validation';

async function deleteSingle(
  uniqueInput: UniqueInputFilter,
  list: InitialisedList,
  context: KeystoneContext,
  accessFilters: boolean | InputFilter,
  operationAccess: boolean,
  writeLimit: Limit
) {
  // Operation level access control
  if (!operationAccess) {
    throw accessDeniedError();
  }

  // Validate and resolve the input filter
  // MAYBE KS_USER_INPUT_ERROR
  const uniqueWhere = await resolveUniqueWhereInput(uniqueInput, list.fields, context);

  // Access control
  // Maybe KS_ACCESS_DENIED, KS_SYSTEM_ERROR
  const existingItem = await getAccessControlledItemForDelete(
    list,
    context,
    uniqueWhere,
    accessFilters
  );

  const hookArgs = { operation: 'delete' as const, listKey: list.listKey, context, existingItem };

  // Apply all validation checks
  // Maybe KS_VALIDATION_ERROR
  await validateDelete({ list, hookArgs });

  // Before delete
  // Maybe KS_HOOK_ERROR
  await runSideEffectOnlyHook(list, 'beforeDelete', hookArgs);

  // Maybe KS_PRISMA_ERROR
  const item = await writeLimit(() =>
    runWithPrisma(context, list, model => model.delete({ where: { id: existingItem.id } }))
  );

  // Maybe KS_HOOK_ERROR
  await runSideEffectOnlyHook(list, 'afterDelete', hookArgs);

  return item;
}

export async function deleteMany(
  uniqueInputs: UniqueInputFilter[],
  list: InitialisedList,
  context: KeystoneContext,
  provider: DatabaseProvider
) {
  const writeLimit = pLimit(provider === 'sqlite' ? 1 : Infinity);

  // Check operation permission to pass into single operation
  const operationAccess = await checkOperationAccess(list, context, 'delete');

  // Check filter permission to pass into single operation
  const accessFilters = await getAccessFilters(list, context, 'delete');

  return uniqueInputs.map(async uniqueInput =>
    deleteSingle(uniqueInput, list, context, accessFilters, operationAccess, writeLimit)
  );
}

export async function deleteOne(
  uniqueInput: UniqueInputFilter,
  list: InitialisedList,
  context: KeystoneContext
) {
  // Check operation permission to pass into single operation
  const operationAccess = await checkOperationAccess(list, context, 'delete');

  // Check filter permission to pass into single operation
  const accessFilters = await getAccessFilters(list, context, 'delete');

  return deleteSingle(uniqueInput, list, context, accessFilters, operationAccess, pLimit(1));
}
