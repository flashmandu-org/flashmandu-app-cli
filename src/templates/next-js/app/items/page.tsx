'use client';

/**
 * IndexTable + FilterBar example — the shape every list surface should take.
 *
 * Four things are deliberate here:
 *
 *  1. **Skeleton-first.** The table renders with `loading` on the first paint
 *     and swaps to data. There is never a blank pane and never a layout jump,
 *     because the skeleton occupies the same rows the data will.
 *  2. **Create renders IN THE PAGE, not in the command bar.** The host bar
 *     carries the dirty-state form pair — Save / Discard — and nothing else.
 *     Everything a merchant can do to a LIST (create, preview, jump to a
 *     sibling surface) belongs on the page, top-right, above the filter bar,
 *     which is exactly where the host's own Items index puts "New Item"
 *     (chiya-shots resources/views/livewire/items/index.blade.php).
 *  3. **Filtering is the platform's filter section, not a search box.** One
 *     attached `Filter ▾` menu with an active-count badge, auto-derived quick
 *     filters, chips, and `defaults` — the pin that saves the current filter
 *     as this merchant's default for this list. Every host list has the pin;
 *     an app that omits it is the only surface in the admin that forgets.
 *  4. **Sort, filter and pagination are intent, not state.** The components
 *     report what the merchant asked for; the DATA stays external, so the same
 *     page works against a real paginated API without restructuring.
 *
 * NOTE there is no page padding anywhere in this file, and there must not be.
 * `Page` owns the host's own Items-index page box (24/16/128px below lg,
 * 16/24/40px from lg up) — never add your own margin or padding around it.
 */

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  Badge,
  Button,
  EmptyState,
  FilterBar,
  IndexTable,
  Page,
  Pagination,
  type FilterField,
  type FilterValue,
  type SortState,
} from '@flashmandu/app-bridge-ui/react';
import { useProfileId } from '@flashmandu/app-bridge/react';

interface Item {
  id: number;
  name: string;
  sku: string;
  status: 'active' | 'draft';
  stock: number;
}

const PAGE_SIZE = 10;

/**
 * The filter schema. `defaultValue` is what makes "All" produce no chip and
 * not count toward "Clear all" — the same rule the host applies to a select
 * sitting at its declared default. The key reads as a status, so the bar also
 * offers these options as one-click quick filters at the top of its menu.
 */
const STATUS_FIELD: FilterField = {
  key: 'status',
  label: 'Status',
  type: 'select',
  defaultValue: '',
  options: [
    { label: 'All items', value: '' },
    { label: 'Active', value: 'active' },
    { label: 'Draft', value: 'draft' },
  ],
};

/** Stand-in for your API call. Replace with a fetch to your own backend. */
async function fetchItems(
  page: number,
  sort: SortState | null,
  query: string,
  status: string,
): Promise<{ items: Item[]; total: number }> {
  const all: Item[] = Array.from({ length: 23 }, (_, index) => ({
    id: index + 1,
    name: `Sample item ${index + 1}`,
    sku: `SKU-${String(index + 1).padStart(4, '0')}`,
    status: index % 4 === 0 ? 'draft' : 'active',
    stock: (index * 7) % 40,
  }));

  // Search and filters AND together, server-side, on the real thing.
  const matched = all.filter(
    (item) =>
      (query === '' || item.name.toLowerCase().includes(query.toLowerCase())) &&
      (status === '' || item.status === status),
  );

  if (sort) {
    matched.sort((a, b) => {
      const left = a[sort.key as keyof Item];
      const right = b[sort.key as keyof Item];
      const cmp = left < right ? -1 : left > right ? 1 : 0;
      return sort.direction === 'asc' ? cmp : -cmp;
    });
  }

  return {
    items: matched.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: Math.max(1, Math.ceil(matched.length / PAGE_SIZE)),
  };
}

export default function ItemsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState | null>({ key: 'name', direction: 'asc' });
  const [selected, setSelected] = useState<Array<string | number>>([]);
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const bridgeStatus = useProfileId();
  const profileId = bridgeStatus.status === 'ready' ? bridgeStatus.profileId : undefined;

  const filterValues = useMemo<Record<string, FilterValue>>(() => ({ status }), [status]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchItems(page, sort, query, status).then((result) => {
      if (cancelled) return;
      setItems(result.items);
      setTotalPages(result.total);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [page, sort, query, status]);

  /** Any filter change invalidates the page you were on, and the selection. */
  useEffect(() => {
    setPage(1);
    setSelected([]);
  }, [query, status]);

  return (
    <Page
      title="Items"
      crumbs={[{ label: 'Dashboard', path: '/' }, { label: 'Items' }]}
      linkComponent={Link}
    >
      {/* In the page, above the filter bar — NOT in the host command bar. */}
      <div className="fm-page-actions">
        <Button variant="primary" onClick={() => undefined}>
          New item
        </Button>
      </div>

      <FilterBar
        search={{ value: query, onChange: setQuery, placeholder: 'Search items...' }}
        fields={[STATUS_FIELD]}
        values={filterValues}
        onChange={(key, value) => {
          if (key === 'status') setStatus(typeof value === 'string' ? value : '');
        }}
        onClear={() => {
          setQuery('');
          setStatus('');
        }}
        // The pin: "save this filter as my default for this list". Scope names
        // the list; profileId partitions it, so two merchants sharing a browser
        // do not inherit each other's view. Pass `urlKeys` naming the query
        // params this page writes, if any — a shared link beats a saved default.
        defaults={{ scope: 'items', profileId }}
      />

      <IndexTable<Item>
        label="Items"
        columns={[
          // The first column is pinned: it stays put while the table travels
          // sideways on narrow viewports.
          { key: 'name', label: 'Name', sortable: true, pinned: true, render: (item) => item.name },
          { key: 'sku', label: 'SKU', render: (item) => <code>{item.sku}</code> },
          {
            key: 'status',
            label: 'Status',
            render: (item) => (
              <Badge tone={item.status === 'active' ? 'success' : 'neutral'}>{item.status}</Badge>
            ),
          },
          { key: 'stock', label: 'Stock', align: 'right', sortable: true, render: (item) => item.stock },
        ]}
        data={items}
        keyExtractor={(item) => item.id}
        sort={sort}
        onSortChange={setSort}
        selectable
        selected={selected}
        onSelectionChange={setSelected}
        bulkActions={[
          { key: 'archive', label: 'Archive', onAction: (ids) => console.log('archive', ids) },
        ]}
        loading={loading}
        loadingRows={PAGE_SIZE}
        emptyState={
          query !== '' || status !== '' ? (
            <EmptyState
              title="No items match the current search and filters."
              action={
                <Button
                  onClick={() => {
                    setQuery('');
                    setStatus('');
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState title="No items yet" description="Items you create will appear here." />
          )
        }
        footer={<Pagination current={page} total={totalPages} onChange={setPage} />}
      />
    </Page>
  );
}
