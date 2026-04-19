type ActionHandler = (payload: Record<string, unknown>, respondingUserId: number) => Promise<void>;

const actionRegistry = new Map<string, ActionHandler>();

function registerAction(actionType: string, handler: ActionHandler): void {
  actionRegistry.set(actionType, handler);
}

function getAction(actionType: string): ActionHandler | undefined {
  return actionRegistry.get(actionType);
}

// Dev/test actions
registerAction('test_approve', async () => {
  console.log('[notifications] Test approve action executed');
});

registerAction('test_deny', async () => {
  console.log('[notifications] Test deny action executed');
});

registerAction('noop', async () => {});

registerAction('budget_settlement_ack', async (_payload, _respondingUserId) => {
  // Acknowledgement is recorded on the notification row's response column by the caller.
});

export { registerAction, getAction };
