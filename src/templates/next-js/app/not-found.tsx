/* @flashmandu-template app/not-found.tsx@0.4.0 */
import Link from 'next/link';

export default function NotFound() {
  return (
    <div className="fm-container">
      <div className="fm-empty">
        <p>This page does not exist.</p>
        <Link href="/" className="fm-btn fm-btn--primary">
          Back to home
        </Link>
      </div>
    </div>
  );
}
