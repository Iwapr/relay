import { FactoryDroidMessageSchema, ProcessTransport } from '@factory/droid-sdk/node';

/** CLI history is authoritative. Drop only unknown optional route metadata from
 * the SDK's inbound copy; never rewrite persisted history or outbound requests.
 * SDK 0.9.1 rejects Droid 0.233.0's azure_anthropic route when resuming sessions.
 */
export function compatibleFactoryMessage(raw: string): string {
  let envelope: any;
  try {
    envelope = JSON.parse(raw);
  } catch {
    return raw;
  }
  let changed = false;
  const normalize = (message: any) => {
    if (
      message &&
      typeof message.apiProvider === 'string' &&
      !FactoryDroidMessageSchema.shape.apiProvider.safeParse(message.apiProvider).success
    ) {
      delete message.apiProvider;
      changed = true;
    }
  };
  if (envelope?.type === 'response' && Array.isArray(envelope.result?.session?.messages))
    envelope.result.session.messages.forEach(normalize);
  if (
    envelope?.type === 'notification' &&
    envelope.method === 'droid.session_notification' &&
    envelope.params?.notification?.type === 'create_message'
  )
    normalize(envelope.params.notification.message);
  return changed ? JSON.stringify(envelope) : raw;
}

export class FactoryTransport extends ProcessTransport {
  override onMessage(handler: (message: string) => void) {
    super.onMessage((message) => handler(compatibleFactoryMessage(message)));
  }
}
