/* @flashmandu-template lib/purge.ts@0.4.0 */
/**
 * Uninstall data purge — called by the webhook route's `onUninstalled` when
 * the platform sends `app.uninstalled` or `profile.data.erased`.
 *
 * Delete (or anonymize) everything this app stored for `profileId` and
 * return counts per model, so the webhook route's log line
 * (`[flashmandu] <event> purged profile=<id> <model>=<n> …`) is meaningful.
 * The template ships no models yet, so this returns an empty count map —
 * replace the body with your own deletes as you add persistence, e.g.:
 *
 *     const items = await prisma.item.deleteMany({ where: { profileId } });
 *     return { items: items.count };
 */
export async function purgeProfileData(profileId: string): Promise<Record<string, number>> {
  void profileId;
  return {};
}
