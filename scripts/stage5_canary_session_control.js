'use strict';

const { CanarySessionStore } = require('../lib/stage5_canary_session');

function updateLockoff(sessionPath, restored, code = null) {
  const store = new CanarySessionStore({ sessionPath });
  if (!store.read()) return { updated: false, reason: 'CANARY_SESSION_NOT_PRESENT' };
  const session = store.recordLockoff({ restored, code });
  return { updated: true, sessionId: session.sessionId, state: session.state, lockoffRestorationState: session.lockoffRestorationState };
}

if (require.main === module) {
  const [command, sessionPath] = process.argv.slice(2);
  try {
    if (!sessionPath) throw new Error('CANARY_SESSION_PATH_REQUIRED');
    const result = command === 'lockoff-restored'
      ? updateLockoff(sessionPath, true)
      : command === 'lockoff-failed'
        ? updateLockoff(sessionPath, false, 'LOCKOFF_RESTORATION_FAILED')
        : (() => { throw new Error('UNKNOWN_CANARY_SESSION_CONTROL_COMMAND'); })();
    console.log(JSON.stringify(result));
    if (command === 'lockoff-failed') process.exitCode = 1;
  } catch (error) {
    console.error(JSON.stringify({ ok: false, error: error.message }));
    process.exitCode = 1;
  }
}

module.exports = { updateLockoff };
