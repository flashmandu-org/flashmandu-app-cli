/* @flashmandu-template app/error.tsx@0.4.0 */
'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div className="fm-container">
      <div className="fm-callout fm-callout--danger" role="alert">
        <p>Something went wrong: {error.message}</p>
        <button type="button" className="fm-btn fm-btn--subtle" onClick={reset}>
          Try again
        </button>
      </div>
    </div>
  );
}
