import { createSchema, list } from '@keystone-next/keystone';
import { checkbox, relationship, text, timestamp } from '@keystone-next/keystone/fields';
import { select } from '@keystone-next/keystone/fields';

export const lists = createSchema({
  Task: list({
    fields: {
      label: text({ isRequired: true }),
      priority: select({
        dataType: 'enum',
        options: [
          { label: 'Low', value: 'low' },
          { label: 'Medium', value: 'medium' },
          { label: 'High', value: 'high' },
        ],
        // Dynamic default: Use the label field to determine the priority
        defaultValue: ({ originalInput }) => {
          if (originalInput.label && originalInput.label.toLowerCase().includes('urgent')) {
            return 'high';
          } else {
            return 'low';
          }
        },
      }),
      // Static default: When a task is first created, it is incomplete
      isComplete: checkbox({ defaultValue: false }),
      assignedTo: relationship({
        ref: 'Person.tasks',
        many: false,
        // Dynamic default: Find an anonymous user and assign the task to them
        defaultValue: async ({ context }) => {
          const anonymous = await context.lists.Person.findMany({
            where: { name: { equals: 'Anonymous' } },
          });
          if (anonymous.length > 0) {
            return { connect: { id: anonymous[0].id } };
          }
          // If we don't have an anonymous user return undefined so as not to apply any default
        },
      }),
      // Dynamic default: We set the due date to be 7 days in the future
      finishBy: timestamp({
        defaultValue: () =>
          new Date(new Date().setUTCDate(new Date().getUTCDate() + 7)).toUTCString(),
      }),
    },
    defaultIsFilterable: true,
    defaultIsOrderable: true,
  }),
  Person: list({
    fields: {
      name: text({ isRequired: true }),
      tasks: relationship({ ref: 'Task.assignedTo', many: true }),
    },
    defaultIsFilterable: true,
    defaultIsOrderable: true,
  }),
});
