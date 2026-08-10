'use client';

/**
 * IndexTable example — the shape every list surface in an app should take.
 *
 * Three things are deliberate here:
 *
 *  1. **Skeleton-first.** The table renders with `loading` on the first paint
 *     and swaps to data. There is never a blank pane and never a layout jump,
 *     because the skeleton occupies the same rows the data will.
 *  2. **No in-page heading.** Title, breadcrumbs and the "New item" action are
 *     published to the host command bar by `AppPage`.
 *  3. **Sort and pagination are intent, not state.** `IndexTable` reports what
 *     the merchant asked for; the DATA stays external so the same page works
 *     against a real paginated API without restructuring.
 */

import { useEffect, useState } from 'react';
import {
  Badge,
  EmptyState,
  IndexTable,
  Pagination,
  type SortState,
} from '@flashmandu/app-bridge-ui/react';
import { AppPage } from '@/lib/chrome';

interface Item {
  id: number;
  name: string;
  sku: string;
  status: 'active' | 'draft';
  stock: number;
}

const PAGE_SIZE = 10;

/** Stand-in for your API call. Replace with a fetch to your own backend. */
async function fetchItems(page: number, sort: SortState | null): Promise<{ items: Item[]; total: number }> {
  const all: Item[] = Array.from({ length: 23 }, (_, index) => ({
    id: index + 1,
    name: `Sample item ${index + 1}`,
    sku: `SKU-${String(index + 1).padStart(4, '0')}`,
    status: index % 4 === 0 ? 'draft' : 'active',
    stock: (index * 7) % 40,
  }));

  if (sort) {
    all.sort((a, b) => {
      const left = a[sort.key as keyof Item];
      const right = b[sort.key as keyof Item];
      const cmp = left < right ? -1 : left > right ? 1 : 0;
      return sort.direction === 'asc' ? cmp : -cmp;
    });
  }

  return {
    items: all.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE),
    total: Math.ceil(all.length / PAGE_SIZE),
  };
}

export default function ItemsPage() {
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<Item[]>([]);
  const [totalPages, setTotalPages] = useState(1);
  const [page, setPage] = useState(1);
  const [sort, setSort] = useState<SortState | null>({ key: 'name', direction: 'asc' });
  const [selected, setSelected] = useState<Array<string | number>>([]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void fetchItems(page, sort).then((result) => {
      if (cancelled) return;
      setItems(result.items);
      setTotalPages(result.total);
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [page, sort]);

  return (
    <AppPage
      title="Items"
      crumbs={[{ label: 'Dashboard', path: '/' }, { label: 'Items' }]}
      actions={[{ id: 'new-item', label: 'New item', variant: 'primary', onSelect: () => undefined }]}
    >
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
        emptyState={<EmptyState title="No items yet" description="Items you create will appear here." />}
        footer={<Pagination current={page} total={totalPages} onChange={setPage} />}
      />
    </AppPage>
  );
}
