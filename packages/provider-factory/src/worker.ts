import { runFactory, factoryError, type FactoryRequest } from './runtime.ts';
import type { InteractionAnswer } from '../../provider-core/src/index.ts';
process.umask(parseInt(process.env.RELAY_FACTORY_UMASK ?? '0022', 8));
const abort = new AbortController();
const pending = new Map<string, (answer: InteractionAnswer) => void>();
const send = (data: unknown) => {
  if (process.connected) process.send?.(data);
};
let started = false;
const cancel = () => {
  abort.abort();
  for (const [id, resolve] of pending) resolve({ requestId: id, generation: '', decision: 'cancel' });
  pending.clear();
};
process.on('disconnect', cancel);
process.on('message', (m: any) => {
  if (m.type === 'cancel') {
    cancel();
    return;
  }
  if (m.type === 'answer') {
    pending.get(String(m.answer.requestId))?.(m.answer);
    pending.delete(String(m.answer.requestId));
    return;
  }
  if (m.type !== 'start' || started) return;
  started = true;
  void runFactory(m.request as FactoryRequest, {
    signal: abort.signal,
    emit: (type, payload) => send({ type: 'event', event: type, payload }),
    ask: (id, payload) =>
      new Promise((resolve) => {
        if (abort.signal.aborted) {
          resolve({ requestId: id, generation: '', decision: 'cancel' });
          return;
        }
        pending.set(id, resolve);
        send({ type: 'event', event: 'interaction.required', payload });
      }),
  })
    .then((result) => send({ type: 'result', result }))
    .catch((error) =>
      send({
        type: 'result',
        result: abort.signal.aborted
          ? { state: 'cancelled' }
          : { state: 'failed', error: factoryError(error) },
      }),
    )
    .finally(() => {
      process.disconnect?.();
      process.exitCode = 0;
    });
});
