import { useState } from 'react';
import { ChevronRight, Terminal } from 'lucide-react';
import './tool-history.css';

export interface ToolRecord {
  id: string;
  title: string;
  text: string;
  truncated?: string;
}

/** One disclosure per turn; live updates never expand it automatically. */
export function ToolHistory({ records }: { records: ToolRecord[] }) {
  const [open, setOpen] = useState(false);
  if (!records.length) return null;
  return (
    <details className="tool-history" open={open}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          setOpen((value) => !value);
        }}
      >
        <ChevronRight size={14} className="tool-history-chevron" />
        <Terminal size={13} />
        <span>执行记录 · {records.length} 项</span>
        <span className="tool-history-action">{open ? '收起' : '展开'}</span>
      </summary>
      {open && (
        <div className="tool-history-records">
          {records.map((record) => (
            <details className="tool-message" key={record.id}>
              <summary>{record.title}</summary>
              <pre>{record.text}</pre>
              {record.truncated && <small>{record.truncated}</small>}
            </details>
          ))}
        </div>
      )}
    </details>
  );
}
