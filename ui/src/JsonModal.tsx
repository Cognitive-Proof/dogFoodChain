import { useEffect } from 'react';

interface JsonModalProps {
  title: string;
  value: unknown;
  onClose: () => void;
}

export default function JsonModal({ title, value, onClose }: JsonModalProps) {
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-header">
          <h3>{title}</h3>
          <button onClick={onClose}>Close</button>
        </div>
        <pre className="modal-json">{JSON.stringify(value, null, 2)}</pre>
      </div>
    </div>
  );
}
