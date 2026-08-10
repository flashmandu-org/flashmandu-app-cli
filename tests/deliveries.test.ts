import { describe, expect, it } from 'vitest';
import { formatDeliveries, statusCell } from '../src/commands/hooks';
import type { DeliveryRecord } from '../src/services/apiClient';

/** Strip ANSI so assertions read against the visible text. */
function plain(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\[[0-9;]*m/g, '');
}

const row = (over: Partial<DeliveryRecord> = {}): DeliveryRecord => ({
  id: 1,
  delivery_id: 'd-1',
  event: 'order.created',
  http_status: 200,
  succeeded: true,
  attempts: 1,
  duration_ms: 142,
  created_at: '2026-08-10T10:00:00Z',
  ...over,
});

describe('statusCell', () => {
  it('reports the http status for a completed attempt', () => {
    expect(statusCell(row()).text).toBe('200');
  });

  it('reports a pending attempt as "-"', () => {
    expect(statusCell(row({ http_status: null, succeeded: false })).text).toBe('-');
  });

  it('reports a dead-lettered delivery as "dead" regardless of status', () => {
    expect(statusCell(row({ http_status: 500, succeeded: false, dead_lettered: true })).text).toBe(
      'dead',
    );
  });
});

describe('formatDeliveries', () => {
  it('renders the four columns the spec calls for', () => {
    const header = plain(formatDeliveries([row()])).split('\n')[0]!;
    expect(header).toMatch(/Event/);
    expect(header).toMatch(/Status/);
    expect(header).toMatch(/Attempts/);
    expect(header).toMatch(/Latency/);
  });

  it('shows the row id so it can be replayed', () => {
    expect(plain(formatDeliveries([row({ id: 77 })]))).toMatch(/\b77\b/);
  });

  it('falls back to the delivery_id when the log has no row id', () => {
    expect(plain(formatDeliveries([row({ id: undefined })]))).toMatch(/d-1/);
  });

  it('degrades to "-" for fields an older delivery log does not carry', () => {
    const out = plain(
      formatDeliveries([row({ attempts: undefined, attempt: undefined, duration_ms: undefined })]),
    );
    const line = out.split('\n')[1]!;
    expect(line).toMatch(/-\s+-\s*$/);
  });

  it('uses the per-attempt number when only `attempt` is present', () => {
    const line = plain(formatDeliveries([row({ attempts: undefined, attempt: 3 })])).split('\n')[1]!;
    expect(line).toMatch(/\b3\b/);
  });

  it('renders latency in milliseconds', () => {
    expect(plain(formatDeliveries([row({ duration_ms: 142 })]))).toMatch(/142ms/);
  });

  it('aligns columns on visible width, not on ANSI byte length', () => {
    const lines = plain(formatDeliveries([row({ event: 'a.b' }), row({ event: 'a.very.long.event' })]))
      .split('\n')
      .slice(1);
    const statusColumn = lines.map((l) => l.indexOf('200'));
    expect(statusColumn[0]).toBe(statusColumn[1]);
  });
});
