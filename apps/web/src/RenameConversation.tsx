import { useState } from 'react';
import { Pencil } from 'lucide-react';
import { api, base, type Conversation } from './api';

export function RenameConversation({
  connection,
  conversation,
  disabled,
  onSaved,
  onRename,
}: {
  connection: string;
  conversation: Pick<Conversation, 'id' | 'title'>;
  disabled: boolean;
  onSaved: (conversation: Conversation) => void;
  onRename?: (title: string) => Promise<Conversation>;
}) {
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(conversation.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!editing)
    return (
      <button
        className="rename-conversation-trigger"
        aria-label="修改对话标题"
        title="修改对话标题"
        disabled={disabled}
        onClick={() => {
          setTitle(conversation.title);
          setEditing(true);
        }}
      >
        <Pencil size={14} />
      </button>
    );
  return (
    <form
      className="rename-conversation"
      onSubmit={async (event) => {
        event.preventDefault();
        if (busy || disabled || !title.trim()) return;
        setBusy(true);
        setError('');
        try {
          const updated = onRename
            ? await onRename(title.trim())
            : (
                await api(base(connection) + `/conversations/${conversation.id}/title`, {
                  title: title.trim(),
                })
              ).conversation;
          onSaved(updated);
          setEditing(false);
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setBusy(false);
        }
      }}
    >
      <label>
        对话标题
        <input
          autoFocus
          aria-label="对话标题"
          maxLength={200}
          value={title}
          disabled={busy}
          onChange={(event) => setTitle(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229))
              event.preventDefault();
          }}
        />
      </label>
      <small>保存为 Relay 中的显示标题。</small>
      <div>
        <button type="submit" disabled={busy || disabled || !title.trim()}>
          保存标题
        </button>
        <button type="button" disabled={busy} onClick={() => setEditing(false)}>
          取消
        </button>
      </div>
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </form>
  );
}
